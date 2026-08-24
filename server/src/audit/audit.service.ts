import { Global, Injectable, Module } from '@nestjs/common';
import { DbService } from '../db/db.module';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  actorId?: string | null;
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
    await this.db.system(async (db) => {
      await db.insert(auditLog).values({
        actorId: entry.actorId ?? null,
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
