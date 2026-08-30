import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from '../db/db.module';

/**
 * Nightly cleanup of rows that exist only for a while.
 *
 * Sessions, verification tokens and rate-limit counters were written but never
 * removed, so all three grew without bound — 232 sessions, most long expired,
 * against six accounts. None of this is case data: it is short-lived
 * authentication state whose retention is not a legal question but a hygiene
 * one, and holding an expired session row is a liability rather than a record.
 *
 * Case retention is deliberately NOT handled here. Deleting a data subject
 * request needs a period agreed with Legal per zone, and inventing one would be
 * worse than leaving the gap visible.
 */
@Injectable()
export class HousekeepingService {
  private readonly log = new Logger(HousekeepingService.name);

  constructor(private readonly db: DbService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    try {
      const counts = await this.db.system(async (_db, client) => {
        // Expired or revoked sessions. A revoked session is kept a week so the
        // audit trail can still explain a forced sign-out.
        const sessions = await client.query(
          `DELETE FROM internal_sessions
            WHERE absolute_expires_at < now() - interval '7 days'
               OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
        );

        // Verification tokens are single-use and short-lived; past their expiry
        // they can only be replayed.
        const tokens = await client.query(
          `DELETE FROM verification_tokens WHERE expires_at < now() - interval '1 day'`,
        );

        // Drafts hold a data subject's address in plain text before their
        // request becomes a case, and nothing else ever deleted them -- an
        // abandoned form used to sit here for the life of the box. Purged on
        // the same one-day grace as the tokens above, because once a draft is
        // past expires_at the requester cannot resume it.
        //
        // Ordered after that delete and guarded by NOT EXISTS because
        // verification_tokens.draft_id references this table ON DELETE NO
        // ACTION: a draft whose token has not yet aged out would fail the
        // constraint and take the whole transaction with it. The guard makes
        // it self-healing instead -- such a draft is skipped now and removed
        // on the next run, once its token has gone.
        const drafts = await client.query(
          `DELETE FROM form_drafts d
            WHERE d.expires_at < now() - interval '1 day'
              AND NOT EXISTS (
                SELECT 1 FROM verification_tokens t WHERE t.draft_id = d.id
              )`,
        );

        // Rate-limit windows older than a day cannot influence a decision.
        const counters = await client.query(
          `DELETE FROM rate_counters WHERE window_start < now() - interval '1 day'`,
        );

        return {
          sessions: sessions.rowCount ?? 0,
          tokens: tokens.rowCount ?? 0,
          drafts: drafts.rowCount ?? 0,
          counters: counters.rowCount ?? 0,
        };
      });

      if (counts.sessions || counts.tokens || counts.drafts || counts.counters) {
        this.log.log(
          `housekeeping: removed ${counts.sessions} sessions, ${counts.tokens} tokens, ` +
            `${counts.drafts} drafts, ${counts.counters} rate counters`,
        );
      }
    } catch (err) {
      // Cleanup must never take the service down with it.
      this.log.error(`housekeeping failed: ${(err as Error).message}`);
    }
  }
}
