import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { StorageService, MAX_UPLOAD_BYTES } from './storage.service';

/**
 * Files held against a case: what the requester sent, and what came back.
 *
 * Downloads resolve through an id, never a supplied path, and the case lookup
 * runs under row-level security — so an approver cannot reach another zone's
 * evidence by guessing an attachment id.
 */
@Controller('internal/cases/:id/attachments')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertCaseVisible(req, id);
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.source, a.note,
                a.created_at, a.in_reply_to, u.name AS uploaded_by_name
           FROM case_attachments a
      LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.case_id = $1
          ORDER BY a.created_at DESC`,
        [id],
      );
      return res.rows;
    });
  }

  @Get(':attachmentId/download')
  async download(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    const row = await this.assertCaseVisible(req, id);

    const file = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT filename, mime_type, storage_key, size_bytes
           FROM case_attachments WHERE id = $1 AND case_id = $2`,
        [attachmentId, id],
      );
      return r.rows[0];
    });
    if (!file) throw new NotFoundException('No such attachment');

    // Reading a requester's evidence is a disclosure; record it.
    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'attachment.downloaded',
      entityType: 'case',
      entityId: id,
      zoneId: row.zone_id,
      after: { filename: file.filename },
    });

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', String(file.size_bytes));
    // Always an attachment: never render requester-supplied content inline.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename.replace(/"/g, '')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(this.storage.stream(file.storage_key));
  }

  /**
   * Record a reply we received out of band — a forwarded email or a signed PDF.
   * The portal cannot receive mail, so this is how an answer from a requester
   * or a colleague becomes part of the case record.
   */
  @Post()
  @Requires('cases.work')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { note?: string; source?: string; inReplyTo?: string },
  ) {
    if (!file) throw new BadRequestException('Choose a file to upload');
    const row = await this.assertCaseVisible(req, id);

    const source = body?.source === 'internal' ? 'internal' : 'response';
    const stored = await this.storage.save({
      zoneId: row.zone_id,
      caseRef: row.case_ref,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });

    const saved = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `INSERT INTO case_attachments
           (case_id, zone_id, case_ref, filename, mime_type, size_bytes, storage_key,
            sha256, scan_status, source, uploaded_by, note, in_reply_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'clean',$9,$10,$11,$12)
         RETURNING id, filename, created_at`,
        [
          id, row.zone_id, row.case_ref, stored.filename, stored.mimeType, stored.sizeBytes,
          stored.storageKey, stored.sha256, source, req.user.id, body?.note ?? null,
          body?.inReplyTo || null,
        ],
      );
      // The reply is the thing that unblocks the case, so it stops waiting.
      await client.query(
        `UPDATE cases SET pending_party = NULL, pending_on = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO case_status_history (case_id, actor_id, from_status, to_status, note)
         VALUES ($1, $2, $3, $3, $4)`,
        [
          id,
          req.user.id,
          row.status,
          `Response recorded: ${stored.filename}${body?.note ? ` — ${body.note}` : ''}`,
        ],
      );
      return r.rows[0];
    });

    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'attachment.recorded',
      entityType: 'case',
      entityId: id,
      zoneId: row.zone_id,
      after: { filename: stored.filename, source, bytes: stored.sizeBytes },
    });

    return { ok: true, ...saved };
  }

  /** Row-level security decides visibility; this turns a miss into a 404. */
  private async assertCaseVisible(req: AuthedRequest, id: string) {
    const row = await this.db.withContext(req.zoneCtx, async (_db, client) => {
      const r = await client.query(
        'SELECT id, zone_id, case_ref, status FROM cases WHERE id = $1',
        [id],
      );
      return r.rows[0];
    });
    if (!row) throw new NotFoundException();
    return row;
  }
}
