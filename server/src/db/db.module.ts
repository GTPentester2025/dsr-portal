import { Global, Module, OnModuleDestroy } from '@nestjs/common';
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

/**
 * All queries run through withContext(), which opens a transaction and sets
 * app.current_role / app.current_zone for RLS. The pool connects as the
 * non-owner role dsr_app, so zone isolation cannot be bypassed by the app.
 */
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>(
        'DATABASE_URL_APP',
        'postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr',
      ),
      max: 10,
    });
  }

  async withContext<T>(
    ctx: ZoneContext,
    fn: (db: Db, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
        [ctx.role, ctx.zone],
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
  system<T>(fn: (db: Db, client: PoolClient) => Promise<T>): Promise<T> {
    return this.withContext({ role: 'system', zone: '*' }, fn);
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
