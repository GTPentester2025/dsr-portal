import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

/**
 * A brake on failing sends, and a record of what did not go out.
 *
 * Two problems, one place. Without a brake, a provider outage turns every
 * reminder cron tick into another few hundred doomed API calls, which is how a
 * rate-limited account stays rate-limited. Without a record, `email_log` says
 * a send failed and names a subject line, leaving nobody able to answer the
 * first question anybody asks: what was in the message the requester never
 * received?
 *
 * Failures are counted per scope. The provider is one scope, so an outage
 * pauses everything briefly; each recipient is another, so one address that
 * hard-bounces stops being retried without silencing mail to anybody else.
 */

/** Consecutive failures tolerated before a scope is paused at all. */
const FREE_FAILURES = 2;
/** First pause after the tolerance is used up. Doubles from there. */
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Bodies are kept for evidence, not for archival; this bounds one audit row. */
const MAX_RECORDED_BODY = 100_000;

export interface BlockedScope {
  scope: string;
  blockedUntil: Date;
  consecutiveFailures: number;
  lastError: string | null;
}

/** Everything known about a message that was attempted, sent or not. */
export interface AttemptedMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  subject: string;
  /** Rendered HTML, exactly as it would have arrived. */
  body?: string | null;
  templateId?: string | null;
  /** Values the template was rendered against, for a transactional send. */
  variables?: Record<string, string> | null;
  caseId?: string | null;
  zoneId?: string | null;
}

@Injectable()
export class SendGuardService {
  private readonly log = new Logger(SendGuardService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** 'provider', plus one scope per recipient address. */
  scopesFor(recipients: string[]): string[] {
    const addresses = recipients
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)
      .map((r) => `to:${r}`);
    return ['provider', ...new Set(addresses)];
  }

  /**
   * The first scope currently paused, or null if the message may be attempted.
   *
   * Expired blocks are cleared as they are read, so a scope comes back on its
   * own without needing a sweeper.
   */
  async blockedScope(scopes: string[]): Promise<BlockedScope | null> {
    if (scopes.length === 0) return null;
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT scope, blocked_until, consecutive_failures, last_error
           FROM email_send_health
          WHERE scope = ANY($1::text[]) AND blocked_until IS NOT NULL AND blocked_until > now()
          ORDER BY blocked_until DESC
          LIMIT 1`,
        [scopes],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        scope: row.scope as string,
        blockedUntil: new Date(row.blocked_until as string),
        consecutiveFailures: Number(row.consecutive_failures),
        lastError: (row.last_error ?? null) as string | null,
      };
    });
  }

  /**
   * Count a failure against every scope involved and work out how long each
   * should now be paused for.
   *
   * The backoff doubles per consecutive failure past the tolerance and is
   * capped, so a long outage settles into one retry every half hour rather
   * than growing until it never retries again.
   */
  async recordFailure(scopes: string[], error: string): Promise<Date | null> {
    if (scopes.length === 0) return null;
    return this.db.system(async (_db, client) => {
      let furthest: Date | null = null;
      for (const scope of scopes) {
        const r = await client.query(
          `INSERT INTO email_send_health (scope, consecutive_failures, total_failures, last_error, last_failed_at)
           VALUES ($1, 1, 1, $2, now())
           ON CONFLICT (scope) DO UPDATE SET
             consecutive_failures = email_send_health.consecutive_failures + 1,
             total_failures = email_send_health.total_failures + 1,
             last_error = EXCLUDED.last_error,
             last_failed_at = now()
           RETURNING consecutive_failures`,
          [scope, error.slice(0, 2000)],
        );
        const failures = Number(r.rows[0].consecutive_failures);
        if (failures <= FREE_FAILURES) continue;

        const backoff = Math.min(
          BASE_BACKOFF_MS * 2 ** (failures - FREE_FAILURES - 1),
          MAX_BACKOFF_MS,
        );
        const until = new Date(Date.now() + backoff);
        await client.query('UPDATE email_send_health SET blocked_until = $2 WHERE scope = $1', [
          scope,
          until,
        ]);
        if (!furthest || until > furthest) furthest = until;
      }
      return furthest;
    });
  }

  /** A send that worked clears the brake for everything it touched. */
  async recordSuccess(scopes: string[]): Promise<void> {
    if (scopes.length === 0) return;
    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO email_send_health (scope, consecutive_failures, last_succeeded_at)
         SELECT s, 0, now() FROM unnest($1::text[]) AS s
         ON CONFLICT (scope) DO UPDATE SET
           consecutive_failures = 0,
           blocked_until = NULL,
           last_succeeded_at = now()`,
        [scopes],
      );
    });
  }

  /**
   * Write down the message that did not go out.
   *
   * The body is recorded in full — that is the point of this. An audit entry
   * saying "outcome email failed" is not enough to tell a requester what they
   * were owed, or to re-send it by hand. `kind` separates a message the
   * provider rejected from one this service refused to hand over at all.
   */
  async recordUndelivered(args: {
    message: AttemptedMessage;
    kind: 'provider' | 'throttled' | 'render';
    error: string;
    attempt: number;
    blockedUntil?: Date | null;
    actorId?: string | null;
    ip?: string;
  }): Promise<void> {
    const m = args.message;
    const body = m.body ? m.body.slice(0, MAX_RECORDED_BODY) : null;
    const truncated = Boolean(m.body && m.body.length > MAX_RECORDED_BODY);

    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO email_log
           (case_id, direction, provider, from_addr, to_addrs, cc_addrs, bcc_addrs,
            subject, body_html, template_id, status, error, attempt, failure_kind,
            template_variables, blocked_until)
         VALUES ($1,'outbound',$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,'failed',$10,$11,$12,$13::jsonb,$14)`,
        [
          m.caseId ?? null,
          'active',
          m.from ?? 'transactional',
          JSON.stringify(m.to),
          m.cc ? JSON.stringify(m.cc) : null,
          m.bcc ? JSON.stringify(m.bcc) : null,
          m.subject,
          body,
          m.templateId ?? null,
          args.error.slice(0, 4000),
          args.attempt,
          args.kind,
          m.variables ? JSON.stringify(m.variables) : null,
          args.blockedUntil ?? null,
        ],
      );
    });

    await this.audit.record({
      actorId: args.actorId ?? null,
      actorType: args.actorId ? 'user' : 'system',
      action: 'email.send_failed',
      entityType: m.caseId ? 'case' : 'email',
      entityId: m.caseId ?? undefined,
      zoneId: m.zoneId ?? undefined,
      after: {
        kind: args.kind,
        error: args.error.slice(0, 2000),
        attempt: args.attempt,
        blockedUntil: args.blockedUntil?.toISOString() ?? null,
        message: {
          from: m.from ?? null,
          to: m.to,
          cc: m.cc ?? null,
          bcc: m.bcc ?? null,
          subject: m.subject,
          templateId: m.templateId ?? null,
          variables: m.variables ?? null,
          // The message itself, so "what did they not get?" is answerable
          // from the audit trail alone.
          body,
          bodyTruncated: truncated,
        },
      },
      sourceIp: args.ip,
    });

    this.log.warn(
      `undelivered (${args.kind}) to ${m.to.join(', ')}: ${m.subject} — ${args.error}`,
    );
  }

  /** Current brake state, for the settings screen. */
  async health() {
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT scope, consecutive_failures, total_failures, last_error,
                last_failed_at, last_succeeded_at, blocked_until
           FROM email_send_health
          WHERE consecutive_failures > 0 OR blocked_until IS NOT NULL
          ORDER BY blocked_until DESC NULLS LAST, consecutive_failures DESC
          LIMIT 100`,
      );
      return r.rows;
    });
  }

  /** Lift the brake by hand once the underlying problem is fixed. */
  async clear(scope: string, actorId: string): Promise<{ ok: true }> {
    await this.db.system(async (_db, client) => {
      if (scope === '*') await client.query('DELETE FROM email_send_health');
      else await client.query('DELETE FROM email_send_health WHERE scope = $1', [scope]);
    });
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'email.throttle_cleared',
      entityType: 'email',
      entityId: scope,
      after: { scope },
    });
    return { ok: true };
  }
}
