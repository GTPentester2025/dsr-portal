import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

/**
 * Applying pending database migrations from the console.
 *
 * The awkward part is that this is the one operation the application is
 * deliberately not allowed to perform. The pool connects as `dsr_app`, a
 * non-owner role, precisely so that application code cannot alter the
 * row-level security policies that keep zones apart — a bug in a controller
 * should not be able to drop the thing standing between one zone's cases and
 * another's.
 *
 * So this does not run DDL through the pool. It runs `scripts/migrate.mjs` as
 * a child process with `DATABASE_URL` — the owner connection string already in
 * the environment for exactly this purpose, and the same one the deployer
 * uses. The privilege stays where it was; the console only gets a button that
 * starts the process the deployer already runs.
 */
@Injectable()
export class SchemaService {
  private readonly log = new Logger(SchemaService.name);

  /**
   * One migration at a time per process.
   *
   * `migrate.mjs` wraps each file in a transaction, so a concurrent run would
   * not corrupt the schema — the second would block, then find the migration
   * already recorded and skip it. This is about the operator's experience
   * rather than the data's safety: two people pressing the button together
   * should get one run and one clear answer, not two interleaved logs.
   */
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Where the repository lives, relative to the compiled `dist/`. */
  private get serverRoot(): string {
    return dirname(dirname(__dirname));
  }

  /**
   * What has been applied and what has not.
   *
   * Read-only, and the thing worth having on its own: knowing the schema is
   * behind the code is most of the value, and it answers the question an
   * operator actually has after a deploy.
   */
  async status(): Promise<{
    applied: { name: string; appliedAt: string }[];
    pending: string[];
    upToDate: boolean;
  }> {
    const files = (await readdir(join(this.serverRoot, 'drizzle')))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = await this.db.system(async (_db, client) => {
      // The table does not exist until the first migration has run.
      const exists = await client.query(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`,
      );
      if (!exists.rows[0].ok) return [];
      const r = await client.query(
        'SELECT name, applied_at FROM schema_migrations ORDER BY name',
      );
      return r.rows as { name: string; applied_at: string }[];
    });

    const appliedNames = new Set(applied.map((a) => a.name));
    const pending = files.filter((f) => !appliedNames.has(f));

    return {
      applied: applied.map((a) => ({
        name: a.name,
        appliedAt: new Date(a.applied_at).toISOString(),
      })),
      pending,
      upToDate: pending.length === 0,
    };
  }

  /**
   * Run whatever is pending.
   *
   * Returns the script's own output verbatim. An operator pressing this needs
   * to see what happened, and a summary written by this method would be a
   * second account of an event that already produces a good one.
   */
  async migrate(actorId: string, ip?: string): Promise<{
    ok: boolean;
    applied: string[];
    output: string;
  }> {
    if (this.running) {
      throw new BadRequestException('A migration is already running. Wait for it to finish.');
    }

    const before = await this.status();
    if (before.pending.length === 0) {
      return { ok: true, applied: [], output: 'The schema is already up to date.' };
    }

    // The owner connection, not the pool's. Absent it there is nothing to be
    // done here, and saying so plainly beats a child process failing obscurely.
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) {
      throw new BadRequestException(
        'DATABASE_URL is not set on the server, so migrations cannot be applied from here. ' +
          'Run them as part of a deployment instead.',
      );
    }

    this.running = true;
    const started = Date.now();
    try {
      const output = await this.run(ownerUrl);
      const after = await this.status();
      const applied = before.pending.filter((p) => !after.pending.includes(p));

      await this.audit.record({
        actorId,
        actorType: 'user',
        action: 'schema.migrated',
        entityType: 'instance',
        after: { applied, pending: after.pending, ms: Date.now() - started },
        sourceIp: ip,
      });
      this.log.log(`applied ${applied.length} migration(s): ${applied.join(', ') || 'none'}`);
      return { ok: after.pending.length === 0, applied, output };
    } catch (err) {
      const message = (err as Error).message;
      // A failed migration is a fact about the instance, not a transient
      // error to swallow: it is recorded whether or not it succeeded, because
      // "somebody tried and it did not work" is what the next person needs.
      await this.audit.record({
        actorId,
        actorType: 'user',
        action: 'schema.migration_failed',
        entityType: 'instance',
        after: { pending: before.pending, error: message.slice(0, 4000) },
        sourceIp: ip,
      });
      this.log.error(`migration failed: ${message}`);
      throw new BadRequestException(message);
    } finally {
      this.running = false;
    }
  }

  /**
   * The child process.
   *
   * `execFile`, not `exec`: nothing here is interpolated into a shell, so
   * there is no shell to interpolate into. The environment is passed
   * explicitly rather than inherited wholesale so that what the migration sees
   * is visible in one place.
   */
  private run(ownerUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [join(this.serverRoot, 'scripts', 'migrate.mjs')],
        {
          cwd: this.serverRoot,
          env: { ...process.env, DATABASE_URL: ownerUrl },
          timeout: 5 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (err) {
            reject(new Error(output || err.message));
            return;
          }
          resolve(output);
        },
      );
    });
  }
}
