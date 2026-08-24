import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import { caseStatusHistory, cases, slaClocks, statusTransitions, statuses } from '../db/schema';
import { AuditService } from '../audit/audit.service';

export interface StatusChangeArgs {
  caseId: string;
  toStatus: string;
  note?: string;
  /** Required when toStatus = extended. */
  justification?: string;
  newDueDate?: string;
  /** Required when toStatus = closed. */
  outcomeCode?: string;
  closureNote?: string;
  actorId: string;
  ip?: string;
}

const OUTCOME_CODES = new Set([
  'fulfilled', 'partially_fulfilled', 'refused', 'withdrawn',
  'identity_not_verified', 'out_of_scope',
]);

@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async changeStatus(ctx: ZoneContext, args: StatusChangeArgs) {
    const to = args.toStatus;

    // 'overdue' is system-set only (spec §7) — never accepted from a user.
    if (to === 'overdue') {
      throw new BadRequestException('Overdue is set by the SLA engine, not manually');
    }
    if (to === 'extended') {
      if (!args.justification?.trim()) {
        throw new BadRequestException('Extension requires a justification');
      }
      if (!args.newDueDate || Number.isNaN(Date.parse(args.newDueDate))) {
        throw new BadRequestException('Extension requires a valid new due date');
      }
    }
    if (to === 'closed') {
      if (!args.outcomeCode || !OUTCOME_CODES.has(args.outcomeCode)) {
        throw new BadRequestException(
          `Closing requires an outcome code: ${[...OUTCOME_CODES].join(', ')}`,
        );
      }
      if (!args.closureNote?.trim()) {
        throw new BadRequestException('Closing requires a closure note');
      }
    }

    const result = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, args.caseId) });
      if (!row) throw new NotFoundException();

      const target = await db.query.statuses.findFirst({ where: eq(statuses.key, to) });
      if (!target || !target.active) throw new BadRequestException('Unknown or retired status');

      const allowed = await db
        .select()
        .from(statusTransitions)
        .where(eq(statusTransitions.fromStatus, row.status));
      if (!allowed.some((t) => t.toStatus === to)) {
        throw new BadRequestException(`Illegal transition ${row.status} -> ${to}`);
      }

      const now = new Date();
      const patch: Partial<typeof cases.$inferInsert> = { status: to, updatedAt: now };
      if (to === 'closed') {
        patch.closedAt = now;
        patch.outcomeCode = args.outcomeCode;
        patch.closureNote = args.closureNote;
      }
      if (to === 'extended') {
        patch.dueAt = new Date(args.newDueDate!);
      }
      await db.update(cases).set(patch).where(eq(cases.id, args.caseId));

      await db.insert(caseStatusHistory).values({
        caseId: args.caseId,
        actorId: args.actorId,
        fromStatus: row.status,
        toStatus: to,
        note: to === 'extended' ? `${args.justification}${args.note ? ' — ' + args.note : ''}` : args.note,
      });

      if (to === 'extended') {
        await db
          .update(slaClocks)
          .set({
            dueAt: new Date(args.newDueDate!),
            state: 'running',
            extensionJustification: args.justification,
          })
          .where(eq(slaClocks.caseId, args.caseId));
      }
      if (to === 'closed') {
        await db.update(slaClocks).set({ state: 'stopped' }).where(eq(slaClocks.caseId, args.caseId));
      }
      return { from: row.status, zoneId: row.zoneId };
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'case.status_change',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: result.zoneId,
      before: { status: result.from },
      after: { status: to, outcomeCode: args.outcomeCode, newDueDate: args.newDueDate },
      sourceIp: args.ip,
    });

    return {
      ok: true,
      from: result.from,
      to,
      // GDPR Art. 12(3): remind the agent to notify the data subject.
      notice:
        to === 'extended'
          ? 'Send the requester an extension notification with reasons within the original response period.'
          : undefined,
    };
  }
}
