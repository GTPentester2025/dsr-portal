import {
  BadRequestException,
  Controller,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { DbService } from '../db/db.module';
import { RateLimitService } from './rate-limit.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService, MAX_UPLOAD_BYTES } from '../cases/storage.service';

/**
 * Attachment upload from the public form.
 *
 * Files are attached to a draft, not a case — the case does not exist until the
 * email is verified and the form submitted. The draft is keyed to the browser
 * session, so one visitor cannot add files to another's draft, and the upload
 * is rate limited because it is an unauthenticated write.
 */
@Controller('public/drafts/:draftId/attachments')
export class PublicUploadsController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly rate: RateLimitService,
    private readonly settings: SettingsService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file received');

    const perIp = this.settings.getNumber('UPLOAD_IP_RATE_LIMIT', 40);
    if (!(await this.rate.consume(`upload-ip:${ip}`, perIp))) {
      throw new BadRequestException('Too many uploads from this connection. Try again later.');
    }

    const sessionId = (req as unknown as { cookies?: Record<string, string> }).cookies?.dsr_sid ?? '';

    const draft = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT id, form_key FROM form_drafts
          WHERE id = $1 AND session_id = $2 AND expires_at > now()`,
        [draftId, sessionId],
      );
      return r.rows[0];
    });
    if (!draft) throw new BadRequestException('This form session has expired. Reload and try again.');

    // A cap per draft, so one visitor cannot fill the disk.
    const count = await this.db.system(async (_db, client) => {
      const r = await client.query(
        'SELECT count(*)::int AS n FROM case_attachments WHERE draft_id = $1',
        [draftId],
      );
      return Number(r.rows[0].n);
    });
    if (count >= 10) throw new BadRequestException('A maximum of 10 files can be attached');

    // Held under the draft until submission, then moved to the case directory.
    const stored = await this.storage.save({
      zoneId: 'drafts',
      caseRef: draftId,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });

    const row = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `INSERT INTO case_attachments
           (draft_id, filename, mime_type, size_bytes, storage_key, sha256, scan_status, source)
         VALUES ($1,$2,$3,$4,$5,$6,'clean','requester')
         RETURNING id, filename, size_bytes, mime_type`,
        [draftId, stored.filename, stored.mimeType, stored.sizeBytes, stored.storageKey, stored.sha256],
      );
      return r.rows[0];
    });

    return {
      id: row.id,
      name: row.filename,
      size: row.size_bytes,
      type: row.mime_type,
    };
  }
}
