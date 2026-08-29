import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import { WorkflowService } from './workflow.service';
import { cases, emailLog, templates, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';

/** Case response templates + outbound send (spec §10). */
/**
 * Reply templates grouped by where they sit in a case's life: what you send on
 * receipt, what you send while working it, and what you send to close it.
 */
export const TEMPLATE_CATEGORIES = [
  { value: 'acknowledgement', label: 'Acknowledgement' },
  { value: 'follow-up', label: 'Follow-up' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'custom', label: 'Custom' },
] as const;

@Injectable()
export class OutboundService {
  private readonly log = new Logger(OutboundService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly crypto: CryptoService,
    private readonly config: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  // ---- template CRUD ------------------------------------------------------

  /** Offered in the console; also the accepted set on save. */
  static readonly CATEGORIES = TEMPLATE_CATEGORIES;

  listTemplates(ctx: ZoneContext, zone?: string, requestType?: string) {
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT * FROM templates
          WHERE active
            AND (zone_id IS NULL OR $1::text IS NULL OR zone_id = $1)
            AND (request_type IS NULL OR $2::text IS NULL OR request_type = $2)
          ORDER BY
            CASE category
              WHEN 'acknowledgement' THEN 0
              WHEN 'follow-up' THEN 1
              WHEN 'outcome' THEN 2
              ELSE 3
            END,
            name`,
        [zone ?? null, requestType ?? null],
      );
      return res.rows;
    });
  }

  async upsertTemplate(args: {
    id?: string;
    zoneId?: string | null;
    requestType?: string | null;
    name: string;
    subject: string;
    body: string;
    category?: string;
    actorId: string;
  }) {
    if (!args.name?.trim() || !args.subject?.trim() || !args.body?.trim()) {
      throw new BadRequestException('name, subject and body are required');
    }
    const category = args.category ?? 'outcome';
    if (!TEMPLATE_CATEGORIES.some((c) => c.value === category)) {
      throw new BadRequestException('Unknown template category');
    }
    const row = await this.db.system(async (db) => {
      if (args.id) {
        const existing = await db.query.templates.findFirst({ where: eq(templates.id, args.id) });
        if (!existing) throw new NotFoundException();
        const [updated] = await db
          .update(templates)
          .set({
            name: args.name,
            subject: args.subject,
            body: args.body,
            zoneId: args.zoneId ?? null,
            requestType: args.requestType ?? null,
            category,
            version: existing.version + 1,
            updatedBy: args.actorId,
            updatedAt: new Date(),
          })
          .where(eq(templates.id, args.id))
          .returning();
        return updated;
      }
      const [created] = await db
        .insert(templates)
        .values({
          name: args.name,
          subject: args.subject,
          body: args.body,
          zoneId: args.zoneId ?? null,
          requestType: args.requestType ?? null,
          category,
          updatedBy: args.actorId,
        })
        .returning();
      return created;
    });
    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: args.id ? 'template.updated' : 'template.created',
      entityType: 'template',
      entityId: row.id,
      after: { name: row.name, version: row.version },
    });
    return row;
  }

  /**
   * Decide the waiting party from the recipient list.
   *
   * A message to the requester means the ball is with them; anything else is a
   * colleague or a third party, which the queue shows as internal so a manager
   * can tell the two apart at a glance.
   */
  /** Public entry point for a send that happened outside the portal. */
  async markPending(ctx: ZoneContext, caseId: string, to: string[], actorId: string) {
    const row = await this.db.withContext(ctx, async (db) => {
      const r = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!r) throw new NotFoundException();
      return r;
    });
    if (to.length === 0) return { ok: true };

    await this.setPendingFrom(caseId, to, row.requesterEmailEnc);
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'case.emailed_externally',
      entityType: 'case',
      entityId: caseId,
      zoneId: row.zoneId,
      after: { to },
    });
    return { ok: true };
  }

  /** Returns whether the requester was among the recipients. */
  private async setPendingFrom(
    caseId: string,
    to: string[],
    requesterEmailEnc: string | null,
  ): Promise<boolean> {
    let requesterEmail = '';
    try {
      if (requesterEmailEnc) requesterEmail = this.crypto.decrypt(requesterEmailEnc).toLowerCase();
    } catch {
      // An unreadable address must not stop the case being marked.
    }

    const recipients = to.map((t) => t.trim()).filter(Boolean);
    const toRequester =
      requesterEmail !== '' && recipients.some((r) => r.toLowerCase() === requesterEmail);

    const party = toRequester ? 'customer' : 'internal';
    const names = toRequester
      ? 'Requester'
      : await this.db.system(async (_db, client) => {
          // Prefer the person's name over their address; fall back to the
          // address so an external contact still reads sensibly.
          const res = await client.query(
            `SELECT lower(email) AS email, name FROM users WHERE lower(email) = ANY($1::text[])`,
            [recipients.map((r) => r.toLowerCase())],
          );
          const byEmail = new Map(res.rows.map((r) => [r.email as string, r.name as string]));
          return recipients.map((r) => byEmail.get(r.toLowerCase()) ?? r).join(', ');
        });

    await this.db.system(async (_db, client) => {
      await client.query(
        `UPDATE cases
            SET pending_party = $2, pending_on = $3, pending_since = now(), updated_at = now()
          WHERE id = $1`,
        [caseId, party, names],
      );
    });

    return toRequester;
  }

  /**
   * Answering the requester puts the ball in their court, so the case moves to
   * `pending`.
   *
   * Best-effort on purpose: the mail has already gone out by the time this
   * runs, and an illegal transition (from `closed`, say) must not surface as a
   * send failure. The statutory clock keeps running either way — `pending`
   * records who is being waited on, it does not pause anything.
   */
  private async markAwaitingRequester(
    ctx: ZoneContext,
    caseId: string,
    actorId: string,
    ip?: string,
  ): Promise<void> {
    const current = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      return row?.status ?? null;
    });
    if (!current || current === 'pending' || current === 'closed') return;
    try {
      await this.workflow.changeStatus(ctx, {
        caseId,
        toStatus: 'pending',
        note: 'Awaiting the requester after a reply was sent',
        actorId,
        ip,
      });
    } catch (err) {
      this.log.warn(
        `${caseId}: could not move ${current} -> pending after sending: ${(err as Error).message}`,
      );
    }
  }

  // ---- render + send ------------------------------------------------------

  /** Render a template against a case → ready-to-send draft (spec §10). */
  async renderDraft(ctx: ZoneContext, caseId: string, templateId: string) {
    return this.db.withContext(ctx, async (db) => {
      const c = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!c) throw new NotFoundException();
      const tpl = await db.query.templates.findFirst({ where: eq(templates.id, templateId) });
      if (!tpl || !tpl.active) throw new NotFoundException('Template not found');
      if (tpl.zoneId && tpl.zoneId !== c.zoneId) {
        throw new BadRequestException('Template belongs to a different zone');
      }
      const vars = await this.caseVariables(db, c);
      return {
        to: vars.requester_email,
        subject: this.substitute(tpl.subject, vars),
        body: this.substitute(tpl.body, vars),
        variables: vars,
      };
    });
  }

  async send(ctx: ZoneContext, args: {
    caseId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    templateId?: string;
    actorId: string;
    ip?: string;
  }) {
    if (!args.to?.length || !args.subject?.trim() || !args.body?.trim()) {
      throw new BadRequestException('to, subject and body are required');
    }
    const c = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, args.caseId) });
      if (!row) throw new NotFoundException();
      return row;
    });

    // No fallback: boot validation guarantees PRIVACY_MAILBOX is set, and an
    // invented example.com sender on the path that emails data subjects would
    // bounce rather than fail visibly.
    const fromMailbox = this.config.get<string>('PRIVACY_MAILBOX');
    let status: 'sent' | 'failed' = 'sent';
    let providerMessageId: string | null = null;
    let error: string | null = null;
    try {
      const result = await this.email.sendAsUser({
        fromMailbox,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
      });
      providerMessageId = result.providerMessageId;
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
    }

    await this.db.system((db) =>
      db.insert(emailLog).values({
        caseId: args.caseId,
        provider: this.email.activeName(),
        fromAddr: fromMailbox,
        toAddrs: args.to,
        ccAddrs: args.cc ?? null,
        bccAddrs: args.bcc ?? null,
        subject: args.subject,
        bodyHtml: args.body,
        templateId: args.templateId ?? null,
        status,
        providerMessageId,
        error,
      }),
    );
    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'case.email_sent',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: c.zoneId,
      after: { to: args.to, subject: args.subject, status },
      sourceIp: args.ip,
    });
    if (status === 'failed') throw new BadRequestException(`Send failed: ${error}`);

    // Record who the case is now waiting on. Derived from the recipients rather
    // than asked for separately, so it cannot drift from what was actually sent.
    const toRequester = await this.setPendingFrom(args.caseId, args.to, c.requesterEmailEnc);
    if (toRequester) {
      await this.markAwaitingRequester(ctx, args.caseId, args.actorId, args.ip);
    }

    return { ok: true, providerMessageId };
  }

  private async caseVariables(
    db: Parameters<Parameters<DbService['withContext']>[1]>[0],
    c: typeof cases.$inferSelect,
  ): Promise<Record<string, string>> {
    let assigneeName = '';
    if (c.assigneeId) {
      const u = await db.query.users.findFirst({
        where: eq(users.id, c.assigneeId),
      });
      assigneeName = u?.name ?? '';
    }
    return {
      case_ref: c.caseRef,
      requester_name: c.requesterNameEnc ? this.safeDecrypt(c.requesterNameEnc) : '',
      requester_email: this.safeDecrypt(c.requesterEmailEnc),
      zone: c.zoneId,
      request_type: (c.requestTypes as string[]).join(', '),
      submission_date: c.createdAt.toISOString().slice(0, 10),
      due_date: c.dueAt ? c.dueAt.toISOString().slice(0, 10) : '',
      assignee_name: assigneeName,
    };
  }

  private substitute(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars[name] ?? m);
  }

  private safeDecrypt(v: string): string {
    try {
      return this.crypto.decrypt(v);
    } catch {
      return '';
    }
  }
}
