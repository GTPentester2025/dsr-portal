import { Global, Injectable, Module } from '@nestjs/common';
import { DbService } from '../db/db.module';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  actorId?: string | null;
  /** Overrides the lookup — used when the account is already gone. */
  actorName?: string | null;
  actorEmail?: string | null;
  actorType?: 'user' | 'system' | 'public';
  action: string;
  entityType: string;
  entityId?: string;
  zoneId?: string;
  before?: unknown;
  after?: unknown;
  sourceIp?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Fire-and-forget is forbidden: audit writes share the caller's success. */
  async record(entry: AuditEntry): Promise<void> {
    await this.db.system(async (db, client) => {
      // The actor's name is copied onto the row rather than left to a join.
      //
      // An account can be permanently deleted, and when it is, every row that
      // only pointed at it would otherwise read as an anonymous action. The
      // audit trail is the one place a deleted person's name is kept, so it
      // has to hold that name itself. Callers may pass it directly — a
      // deletion records the name of the account being deleted, which is by
      // then already gone from `users`.
      let actorName = entry.actorName ?? null;
      let actorEmail = entry.actorEmail ?? null;
      if (!actorName && entry.actorId) {
        const r = await client.query('SELECT name, email FROM users WHERE id = $1', [entry.actorId]);
        actorName = (r.rows[0]?.name as string) ?? null;
        actorEmail = (r.rows[0]?.email as string) ?? null;
      }

      await db.insert(auditLog).values({
        actorId: entry.actorId ?? null,
        actorName,
        actorEmail,
        actorType: entry.actorType ?? 'system',
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        zoneId: entry.zoneId,
        before: entry.before,
        after: entry.after,
        sourceIp: entry.sourceIp,
      });
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
