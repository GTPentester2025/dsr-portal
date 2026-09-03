import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import { caseComments, cases, emailLog } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';

export const PRIORITIES = new Set(['normal', 'high']);

/** Tag hygiene: enough for 'vip' and 'legal-review', not enough for prose. */
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

/**
 * The collaboration layer on a case: comments, watchers, and the operational
 * properties (priority, tags, snooze) that describe how the team is working a
 * request rather than what the request is.
 *
 * Deliberately separate from WorkflowService: nothing here moves a case
 * through its lifecycle or touches the SLA clock, and nothing here is part of
 * the statutory record beyond being audited like every other action.
 */
@Injectable()
export class CollaborationService {
  private readonly log = new Logger(CollaborationService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  // ---- comments -----------------------------------------------------------

  /**
   * Append a comment. Append-only on purpose: an internal discussion that can
   * be edited after the fact is worthless in a dispute, which is the moment
   * anyone actually rereads it.
   */
  async addComment(ctx: ZoneContext, caseId: string, actorId: string, body: string, ip?: string) {
    const text = body?.trim();
    if (!text) throw new BadRequestException('A comment needs some text');
    if (text.length > 10_000) throw new BadRequestException('Comment too long (10k max)');

    const created = await this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      const who = await client.query('SELECT name FROM users WHERE id = $1', [actorId]);
      const [comment] = await db
        .insert(caseComments)
        .values({
          caseId,
          authorId: actorId,
          authorName: who.rows[0]?.name ?? null,
          body: text,
        })
        .returning();
      return { comment, caseRef: row.caseRef, zoneId: row.zoneId };
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'case.commented',
      entityType: 'case',
      entityId: caseId,
      zoneId: created.zoneId,
      // The fact of the comment, not its text: the comment row holds the text,
      // and the audit log is not a second place for it to live.
      after: { commentId: created.comment.id, length: text.length },
      sourceIp: ip,
    });

    await this.notifyWatchers(caseId, actorId, 'New internal comment', excerpt(text));
    return created.comment;
  }

  // ---- watchers -----------------------------------------------------------

  async watch(ctx: ZoneContext, caseId: string, userId: string) {
    await this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      await client.query(
        `INSERT INTO case_watchers (case_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [caseId, userId],
      );
    });
    return { ok: true, watching: true };
  }

  async unwatch(ctx: ZoneContext, caseId: string, userId: string) {
    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        'DELETE FROM case_watchers WHERE case_id = $1 AND user_id = $2',
        [caseId, userId],
      );
    });
    return { ok: true, watching: false };
  }

  /**
   * Tell everyone watching that the case moved. Fire-and-forget from the
   * caller's point of view: a notification that fails must never fail the
   * action it describes.
   *
   * The actor is excluded — being told about your own edit is noise — and so
   * is the assignee when the event is an assignment, because they get the
   * richer case-assigned mail already.
   */
  async notifyWatchers(
    caseId: string,
    actorId: string | null,
    event: string,
    detail: string,
    alsoExclude: string[] = [],
  ): Promise<void> {
    try {
      const data = await this.db.system(async (_db, client) => {
        const caseRes = await client.query(
          'SELECT case_ref, zone_id FROM cases WHERE id = $1',
          [caseId],
        );
        if (!caseRes.rows[0]) return null;
        const watchers = await client.query(
          `SELECT u.id, u.email, u.name FROM case_watchers w
             JOIN users u ON u.id = w.user_id
            WHERE w.case_id = $1 AND u.active`,
          [caseId],
        );
        return { c: caseRes.rows[0], watchers: watchers.rows };
      });
      if (!data) return;

      const skip = new Set([actorId, ...alsoExclude].filter(Boolean));
      const targets = data.watchers.filter((w: { id: string }) => !skip.has(w.id));
      if (targets.length === 0) return;

      const base = this.config.get<string>('INTERNAL_BASE_URL', 'http://127.0.0.1:5181');
      const actorName = actorId
        ? await this.db.system(async (_db, client) => {
            const r = await client.query('SELECT name FROM users WHERE id = $1', [actorId]);
            return (r.rows[0]?.name as string) ?? 'A colleague';
          })
        : 'System';

      for (const w of targets as { email: string }[]) {
        try {
          const result = await this.email.sendTransactional(w.email, 'case-watched', {
            case_ref: data.c.case_ref,
            zone: data.c.zone_id,
            event,
            detail: detail || '—',
            actor: actorName,
            case_url: `${base}/#/cases/${caseId}`,
          });
          await this.db.system((sdb) =>
            sdb.insert(emailLog).values({
              caseId,
              provider: this.email.activeName(),
              fromAddr: 'transactional',
              toAddrs: [w.email],
              subject: result.subject ?? `[${data.c.zone_id}] ${data.c.case_ref}: ${event}`,
              bodyHtml: result.html,
              templateId: 'case-watched',
              status: 'sent',
              providerMessageId: result.providerMessageId,
            }),
          );
        } catch (err) {
          this.log.warn(
            `watcher notification to ${w.email} for ${data.c.case_ref} failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.log.warn(`watcher notification for ${caseId} failed: ${(err as Error).message}`);
    }
  }

  // ---- operational properties --------------------------------------------

  async setPriority(ctx: ZoneContext, caseId: string, priority: string, actorId: string, ip?: string) {
    if (!PRIORITIES.has(priority)) {
      throw new BadRequestException(`Priority must be one of: ${[...PRIORITIES].join(', ')}`);
    }
    const result = await this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      if (row.priority === priority) return { zoneId: row.zoneId, from: row.priority, changed: false };
      await db.update(cases).set({ priority, updatedAt: new Date() }).where(eq(cases.id, caseId));
      // On the timeline, without a status change: priority is part of how the
      // case was worked, and the history should read as a sequence of events.
      await client.query(
        `INSERT INTO case_status_history (case_id, actor_id, from_status, to_status, note)
         VALUES ($1, $2, $3, $3, $4)`,
        [caseId, actorId, row.status, `Priority set to ${priority}`],
      );
      return { zoneId: row.zoneId, from: row.priority, changed: true };
    });

    if (result.changed) {
      await this.audit.record({
        actorId,
        actorType: 'user',
        action: 'case.priority_changed',
        entityType: 'case',
        entityId: caseId,
        zoneId: result.zoneId,
        before: { priority: result.from },
        after: { priority },
        sourceIp: ip,
      });
    }
    return { ok: true, priority };
  }

  async setTags(ctx: ZoneContext, caseId: string, tags: unknown, actorId: string, ip?: string) {
    if (!Array.isArray(tags)) throw new BadRequestException('tags must be an array');
    const clean = [
      ...new Set(
        tags
          .map((t) => String(t).trim())
          .filter(Boolean)
          .map((t) => t.toLowerCase()),
      ),
    ];
    if (clean.length > MAX_TAGS) throw new BadRequestException(`At most ${MAX_TAGS} tags`);
    for (const t of clean) {
      if (t.length > MAX_TAG_LENGTH) {
        throw new BadRequestException(`Tag "${t.slice(0, 20)}…" is too long (${MAX_TAG_LENGTH} max)`);
      }
    }

    const result = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      await db.update(cases).set({ tags: clean, updatedAt: new Date() }).where(eq(cases.id, caseId));
      return { zoneId: row.zoneId, from: row.tags };
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'case.tagged',
      entityType: 'case',
      entityId: caseId,
      zoneId: result.zoneId,
      before: { tags: result.from },
      after: { tags: clean },
      sourceIp: ip,
    });
    return { ok: true, tags: clean };
  }

  /**
   * Set or clear the operator's follow-up date. Nothing to do with the SLA
   * clock — the deadline belongs to the regulator, the snooze to the
   * operator's attention.
   */
  async setSnooze(ctx: ZoneContext, caseId: string, until: string | null, actorId: string, ip?: string) {
    let date: Date | null = null;
    if (until != null && until !== '') {
      date = new Date(until);
      if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid snooze date');
      if (date.getTime() < Date.now()) throw new BadRequestException('Snooze until a future date');
    }

    const result = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      await db
        .update(cases)
        .set({ snoozedUntil: date, updatedAt: new Date() })
        .where(eq(cases.id, caseId));
      return { zoneId: row.zoneId, from: row.snoozedUntil };
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'case.snoozed',
      entityType: 'case',
      entityId: caseId,
      zoneId: result.zoneId,
      before: { snoozedUntil: result.from },
      after: { snoozedUntil: date },
      sourceIp: ip,
    });
    return { ok: true, snoozedUntil: date };
  }
}

/** First line-ish of a comment for a notification subject line. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
