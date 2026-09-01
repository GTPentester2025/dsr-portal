import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService, ZoneContext } from '../db/db.module';
import { emailLog } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../cases/storage.service';
import { SettingsService } from '../settings/settings.service';
import { CaseSourceGuard } from '../cases/case-source.guard';
import { GroupsService } from './groups.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';
import { isPdf, nextStage, permits, type DelegationStage } from './delegation-rules';

/** What the public page is allowed to know. Deliberately not the case row. */
export interface PublicDelegationView {
  caseRef: string;
  requestType: string;
  dueDate: string | null;
  note: string;
  groupName: string;
  stage: DelegationStage;
  acceptedBy: string | null;
  /** Only while the delegation is unanswered; empty afterwards. */
  members: { id: string; name: string }[];
  files: { filename: string; uploadedAt: string }[];
}

@Injectable()
export class DelegationService {
  private readonly log = new Logger(DelegationService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly groups: GroupsService,
    private readonly source: CaseSourceGuard,
    private readonly settings: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  // ---- from inside the portal ---------------------------------------------

  /**
   * Send a case to a group.
   *
   * One token for the whole group, so the email is the same for everyone and
   * there is no window where several links are live at once. Who accepted is
   * established on the page instead, from the group's own membership.
   */
  async send(
    ctx: ZoneContext,
    args: { caseId: string; groupId: string; note: string; actorId: string; ip?: string },
  ) {
    const row = await this.source.assertLive(ctx, args.caseId, 'sent to a group');
    const members = await this.groups.membersOf(ctx, args.groupId);
    if (members.length === 0) {
      throw new BadRequestException('That group has nobody in it to write to');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.crypto.sha256Hex(token);

    const delegation = await this.db.withContext(ctx, async (_db, client) => {
      // The partial unique index refuses a second open delegation; turn that
      // into something an operator can act on.
      const open = await client.query(
        `SELECT d.id, g.name FROM case_delegations d
           JOIN case_groups g ON g.id = d.group_id
          WHERE d.case_id = $1 AND d.stage <> 'closed'`,
        [args.caseId],
      );
      if (open.rows[0]) {
        throw new BadRequestException(
          `This case is already with ${open.rows[0].name}. Finish that first.`,
        );
      }
      // The SELECT above takes no lock, so two concurrent sends for the same
      // case can both see "none open" and both reach this INSERT. The partial
      // unique index (case_delegations_one_open_ux) is what actually decides
      // in that race; catch its violation and turn it into the same friendly
      // message rather than letting the raw Postgres error escape as a 500.
      try {
        const r = await client.query(
          `INSERT INTO case_delegations (case_id, group_id, zone_id, token_hash, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [args.caseId, args.groupId, row.zoneId, tokenHash, args.note ?? '', args.actorId],
        );
        return r.rows[0].id as string;
      } catch (err) {
        if (
          (err as { code?: string; constraint?: string }).code === '23505' &&
          (err as { constraint?: string }).constraint === 'case_delegations_one_open_ux'
        ) {
          throw new BadRequestException('This case is already with a group. Finish that first.');
        }
        throw err;
      }
    });

    const context = await this.caseContext(args.caseId);
    const link = `${this.settings.get<string>('PUBLIC_BASE_URL', 'http://127.0.0.1:5180')}/#/delegation/${token}`;

    for (const m of members) {
      let result;
      try {
        result = await this.email.sendTransactional(m.email, 'delegation-invite', {
          case_ref: context.caseRef,
          zone: context.zoneId,
          request_type: context.requestType,
          due_date: context.dueDate ?? 'not set',
          note: args.note ?? '',
          link,
          from_name: context.fromName,
        }, { caseId: args.caseId, zoneId: row.zoneId });
      } catch (err) {
        // One unreachable address must not stop the other two being asked.
        // The send guard has already recorded what did not go out, so nothing
        // is written to email_log here -- a second row would make the case's
        // mail history read as two attempts at the same invitation.
        this.log.warn(`delegation invite to ${m.email} failed: ${(err as Error).message}`);
        continue;
      }

      // One row per recipient: a case delegated to a group of three must be
      // able to show it asked all three, not just that the group's link was
      // used once. The rendered body is deliberately not stored -- unlike
      // the acknowledgement or assignment emails, this one carries a bearer
      // token in its link, and email_log.body_html is readable by anyone who
      // can see the case. Recording the subject and template id is enough to
      // evidence that the invite went out without also handing out the
      // capability it invited them with.
      try {
        await this.db.withContext(ctx, (db) =>
          db.insert(emailLog).values({
            caseId: args.caseId,
            provider: this.email.activeName(),
            fromAddr: 'transactional',
            toAddrs: [m.email],
            subject: result.subject ?? `Help needed on privacy request ${context.caseRef}`,
            templateId: 'delegation-invite',
            status: 'sent',
            providerMessageId: result.providerMessageId,
          }),
        );
      } catch (err) {
        // A bookkeeping failure must not undo a delegation that has already
        // been created and sent -- the invite went out either way.
        this.log.error(
          `failed to record email_log for delegation invite to ${m.email}: ${(err as Error).message}`,
        );
      }
    }

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'delegation.sent',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: row.zoneId,
      after: { delegationId: delegation, to: members.map((m) => m.email), note: args.note },
      sourceIp: args.ip,
    });
    return { ok: true, id: delegation, sentTo: members.length };
  }

  /** End it. The link stops working; the record of it does not. */
  async close(ctx: ZoneContext, caseId: string, delegationId: string, actorId: string) {
    const zoneId = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `UPDATE case_delegations
            SET stage = 'closed', closed_at = now(), closed_by = $3
          WHERE id = $1 AND case_id = $2 AND stage <> 'closed'
          RETURNING zone_id`,
        [delegationId, caseId, actorId],
      );
      if (!r.rows[0]) throw new NotFoundException('No open delegation to close');
      return r.rows[0].zone_id as string;
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'delegation.closed',
      entityType: 'case',
      entityId: caseId,
      zoneId,
      after: { delegationId },
    });
    return { ok: true };
  }

  // ---- from the link ------------------------------------------------------

  /**
   * What the page shows.
   *
   * Built field by field rather than by spreading a case row, because the
   * whole guarantee of this feature is that a bearer token does not disclose
   * the requester. A `SELECT *` here would quietly undo it the next time a
   * column is added.
   */
  async resolve(token: string, ip?: string): Promise<PublicDelegationView> {
    const d = await this.load(token);

    // The link is a bearer token: anyone it's forwarded to can open it, so
    // "opened, at this time, from this address" is recorded on every view --
    // it's the one signal an investigation into a leaked link would need.
    // A failed write must not stop someone holding a valid link from seeing
    // the page, the same way a bookkeeping failure elsewhere in this file
    // (email_log, above) doesn't undo the thing it's just recording.
    try {
      await this.audit.record({
        actorType: 'public',
        action: 'delegation.viewed',
        entityType: 'case',
        entityId: d.case_id,
        zoneId: d.zone_id,
        after: { delegationId: d.id },
        sourceIp: ip,
      });
    } catch (err) {
      this.log.error(`failed to record delegation.viewed audit for ${d.id}: ${(err as Error).message}`);
    }

    return this.buildView(d);
  }

  /**
   * Assemble the page's payload for an already-loaded delegation row.
   *
   * Split out of `resolve()` so `accept()` and `upload()` can rebuild the
   * view after their own mutation without each also counting as a
   * `delegation.viewed` -- that audit belongs only to the page actually
   * being opened (the controller's `GET`), not to every response that
   * happens to carry the same shape.
   */
  private async buildView(d: Awaited<ReturnType<DelegationService['load']>>): Promise<PublicDelegationView> {
    const files = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT filename, created_at FROM case_attachments
          WHERE case_id = $1 AND source = 'delegate'
          ORDER BY created_at`,
        [d.case_id],
      );
      return r.rows as { filename: string; created_at: string }[];
    });
    const members =
      d.stage === 'sent' ? await this.db.system(async (_db, client) => {
        const r = await client.query(
          'SELECT id, name FROM case_group_members WHERE group_id = $1 ORDER BY name',
          [d.group_id],
        );
        return r.rows as { id: string; name: string }[];
      }) : [];

    return {
      caseRef: d.case_ref,
      requestType: (d.request_types ?? []).join(', ') || 'not stated',
      dueDate: d.due_at ? new Date(d.due_at).toISOString().slice(0, 10) : null,
      note: d.note,
      groupName: d.group_name,
      stage: d.stage as DelegationStage,
      acceptedBy: d.accepted_by ?? null,
      members,
      files: files.map((f) => ({
        filename: f.filename,
        uploadedAt: new Date(f.created_at).toISOString().slice(0, 10),
      })),
    };
  }

  async accept(token: string, memberId: string, ip?: string) {
    const d = await this.load(token);
    this.assertPermits(d.stage, 'accept');

    await this.db.system(async (_db, client) => {
      const member = await client.query(
        'SELECT id, name FROM case_group_members WHERE id = $1 AND group_id = $2',
        [memberId, d.group_id],
      );
      if (!member.rows[0]) throw new BadRequestException('That is not one of this group');
      // Conditional on the stage, so two people clicking at once cannot both
      // win: the second update matches nothing.
      //
      // accepted_by_name is snapshotted here, not read back through the join,
      // because case_group_members can be edited later and the foreign key
      // is ON DELETE SET NULL -- the member row this points at can go away.
      // The snapshot is what keeps the case record able to say who accepted,
      // the same way audit_log.actor_name and case_status_history.actor_name
      // survive the account or row they were copied from.
      const r = await client.query(
        `UPDATE case_delegations
            SET stage = $3, accepted_by_member_id = $2, accepted_by_name = $4, accepted_at = now()
          WHERE id = $1 AND stage = 'sent'`,
        [d.id, memberId, nextStage('accept'), member.rows[0].name],
      );
      if (r.rowCount === 0) throw new ForbiddenException('Somebody has already accepted this');

      await client.query(
        `INSERT INTO case_status_history (case_id, from_status, to_status, note)
         SELECT $1, status, status, $2 FROM cases WHERE id = $1`,
        [d.case_id, `Accepted by ${member.rows[0].name} (${d.group_name})`],
      );
    });

    await this.audit.record({
      actorType: 'public',
      action: 'delegation.accepted',
      entityType: 'case',
      entityId: d.case_id,
      zoneId: d.zone_id,
      after: { delegationId: d.id, memberId },
      sourceIp: ip,
    });
    return this.buildView(await this.load(token));
  }

  async upload(
    token: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    ip?: string,
  ) {
    const d = await this.load(token);
    this.assertPermits(d.stage, 'upload');

    if (!file?.buffer?.length) throw new BadRequestException('Choose a file');
    if (!isPdf(file.buffer)) {
      throw new BadRequestException('Only PDF files can be sent through this link');
    }

    const stored = await this.storage.save({
      zoneId: d.zone_id,
      caseRef: d.case_ref,
      originalname: file.originalname,
      mimetype: 'application/pdf',
      size: file.size,
      buffer: file.buffer,
    });

    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO case_attachments
           (case_id, zone_id, case_ref, filename, mime_type, size_bytes, storage_key,
            sha256, scan_status, source, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'clean','delegate',$9)`,
        [
          d.case_id, d.zone_id, d.case_ref, stored.filename, stored.mimeType,
          stored.sizeBytes, stored.storageKey, stored.sha256,
          `Sent by ${d.accepted_by ?? 'a member'} (${d.group_name})`,
        ],
      );
      await client.query(
        `INSERT INTO case_status_history (case_id, from_status, to_status, note)
         SELECT $1, status, status, $2 FROM cases WHERE id = $1`,
        [d.case_id, `${d.group_name} sent ${stored.filename}`],
      );
    });

    await this.audit.record({
      actorType: 'public',
      action: 'delegation.uploaded',
      entityType: 'case',
      entityId: d.case_id,
      zoneId: d.zone_id,
      after: { delegationId: d.id, filename: stored.filename, bytes: stored.sizeBytes },
      sourceIp: ip,
    });
    return this.buildView(await this.load(token));
  }

  // ---- internals ----------------------------------------------------------

  private assertPermits(stage: string, action: 'accept' | 'upload') {
    if (permits(stage as DelegationStage, action)) return;
    throw new ForbiddenException(
      stage === 'closed'
        ? 'This request has been closed and the link no longer works'
        : action === 'upload'
          ? 'Accept the request before sending documents'
          : 'This request has already been accepted',
    );
  }

  /** Resolve a token to its delegation, or 404. Never leaks why it failed. */
  private async load(token: string) {
    if (!token || token.length < 20) throw new NotFoundException();
    const hash = this.crypto.sha256Hex(token);
    const row = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT d.id, d.case_id, d.group_id, d.zone_id, d.stage, d.note,
                c.case_ref, c.request_types, c.due_at,
                g.name AS group_name, COALESCE(d.accepted_by_name, m.name) AS accepted_by
           FROM case_delegations d
           JOIN cases c ON c.id = d.case_id
           JOIN case_groups g ON g.id = d.group_id
      LEFT JOIN case_group_members m ON m.id = d.accepted_by_member_id
          WHERE d.token_hash = $1`,
        [hash],
      );
      return r.rows[0];
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async caseContext(caseId: string) {
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT c.case_ref, c.zone_id, c.request_types, c.due_at, u.name AS from_name
           FROM cases c LEFT JOIN users u ON u.id = c.assignee_id
          WHERE c.id = $1`,
        [caseId],
      );
      const row = r.rows[0];
      return {
        caseRef: row.case_ref as string,
        zoneId: row.zone_id as string,
        requestType: ((row.request_types ?? []) as string[]).join(', ') || 'not stated',
        dueDate: row.due_at ? new Date(row.due_at).toISOString().slice(0, 10) : null,
        fromName: (row.from_name as string) ?? 'The privacy team',
      };
    });
  }
}
