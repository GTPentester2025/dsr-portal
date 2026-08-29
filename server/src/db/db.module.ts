import { Global, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export type ZoneContext = {
  role: 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor' | 'system';
  zone: string; // 'EUR' | 'SAZ' | 'MAZ' | '*'
};

/** Interactive queries are killed at this point; exports pass their own. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * All queries run through withContext(), which opens a transaction and sets
 * app.current_role / app.current_zone for RLS. The pool connects as the
 * non-owner role dsr_app, so zone isolation cannot be bypassed by the app.
 */
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  private readonly log = new Logger(DbService.name);

  constructor(config: ConfigService) {
    // ConfigService.get(key, default) falls back only when the value is
    // *undefined*. A key present but empty -- DB_CONNECT_TIMEOUT_MS= -- gives
    // '', and Number('') is 0; a plausible typo like '5s' or '30_000' gives
    // NaN. pg-pool guards both timeouts with falsiness, so 0 and NaN alike
    // mean "no timeout" to it: an operator hand-editing these on the box could
    // restore exactly the unbounded behaviour they exist to remove -- requests
    // queueing forever behind an exhausted pool, idle connections never
    // released -- with a clean boot and no error. max survives such a value
    // only by luck, because pg-pool spells its own fallback `max || 10`.
    const ms = (k: string, d: number) => {
      const n = Number(config.get<string>(k, String(d)));
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const max = ms('DB_POOL_MAX', 10);
    // A connection that has been idle this long is closed rather than held
    // against the server's connection limit.
    const idleTimeoutMillis = ms('DB_IDLE_TIMEOUT_MS', 30_000);
    // Fail a request that cannot get a connection rather than queueing behind
    // an exhausted pool until the caller gives up.
    const connectionTimeoutMillis = ms('DB_CONNECT_TIMEOUT_MS', 5_000);
    this.pool = new Pool({
      connectionString: config.get<string>(
        'DATABASE_URL_APP',
        'postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr',
      ),
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    });
    // Once, at boot. A value the guard rejected is otherwise invisible, and
    // the failure it causes only shows up under load looking like anything but
    // its cause.
    this.log.log(
      `pool max=${max} idleTimeoutMs=${idleTimeoutMillis} connectTimeoutMs=${connectionTimeoutMillis}`,
    );
  }

  async withContext<T>(
    ctx: ZoneContext,
    fn: (db: Db, client: PoolClient) => Promise<T>,
    opts?: { statementTimeoutMs?: number },
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // is_local = true on all three. These are pooled connections: a
      // session-scoped SET would outlive the transaction and apply to whichever
      // request picked this connection up next, so an export's generous timeout
      // would silently become the timeout for unrelated interactive queries.
      await client.query(
        `SELECT set_config('app.current_role', $1, true),
                set_config('app.current_zone', $2, true),
                set_config('statement_timeout', $3, true)`,
        [ctx.role, ctx.zone, String(opts?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)],
      );
      const db = drizzle(client, { schema });
      const result = await fn(db, client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** System context: full visibility. For schedulers, intake, seeds. */
  system<T>(
    fn: (db: Db, client: PoolClient) => Promise<T>,
    opts?: { statementTimeoutMs?: number },
  ): Promise<T> {
    return this.withContext({ role: 'system', zone: '*' }, fn, opts);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export const rawSql = sql;

@Global()
@Module({
  providers: [{ provide: DbService, inject: [ConfigService], useFactory: (c: ConfigService) => new DbService(c) }],
  exports: [DbService],
})
export class DbModule {}
