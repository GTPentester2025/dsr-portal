import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.module';

/**
 * Fixed-window counters in Postgres (spec §3): max 3 verification sends per
 * email per hour, max 10 per IP per hour. Durable across restarts and safe
 * with multiple instances (atomic upsert).
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly db: DbService) {}

  private windowStart(): Date {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now;
  }

  /** Returns true when the action is allowed (and consumes one unit). */
  async consume(key: string, limit: number): Promise<boolean> {
    const window = this.windowStart();
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start)
         DO UPDATE SET count = rate_counters.count + 1
         RETURNING count`,
        [key, window],
      );
      return Number(res.rows[0].count) <= limit;
    });
  }

  /** Is the key currently under the limit? Does not consume. */
  async isAllowed(key: string, limit: number): Promise<boolean> {
    const window = this.windowStart();
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT count FROM rate_counters WHERE key = $1 AND window_start = $2`,
        [key, window],
      );
      return Number(res.rows[0]?.count ?? 0) < limit;
    });
  }

  /** Consume one unit unconditionally (for failure-only counting). */
  async record(key: string): Promise<void> {
    const window = this.windowStart();
    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start)
         DO UPDATE SET count = rate_counters.count + 1`,
        [key, window],
      );
    });
  }
}
