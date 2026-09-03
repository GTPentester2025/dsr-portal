import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Db, DbService, ZoneContext } from '../db/db.module';
import {
  caseStatusHistory,
  cases,
  slaClocks,
  slaPolicies,
  statusTransitions,
  statuses,
} from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { CollaborationService } from './collaboration.service';

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
  /**
   * Optimistic-locking guard: the case's updatedAt as the caller last saw it.
   * When supplied and stale, the change is refused with a 409 instead of
   * silently overwriting a colleague's concurrent edit. Optional so older
   * clients and scripts keep working.
   */
  expectedUpdatedAt?: string;
  actorId: string;
  ip?: string;
}

const OUTCOME_CODES = new Set([
  'fulfilled', 'partially_fulfilled', 'refused', 'withdrawn',
  'identity_not_verified', 'out_of_scope',
]);

export const APPEAL_STATUSES = new Set(['requested', 'under_review', 'upheld', 'rejected']);

@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly collab: CollaborationService,
  ) {}

  /**
   * The workflow as data: every active status and every legal transition.
   *
   * The console reads this to offer only moves the server would accept, so
   * "Illegal transition" stops being something an operator discovers after
   * filling in a closure note. 'overdue' remains listed as a target where the
   * table allows it, but is flagged system-only, mirroring changeStatus.
   */
  async transitionTable() {
    return this.db.system(async (db) => {
      const all = await db.select().from(statusTransitions);
      const active = await db.select().from(statuses).where(eq(statuses.active, true));
      return {
        statuses: active.map((s) => ({ key: s.key, label: s.label ?? s.key })),
        transitions: all.map((t) => ({ from: t.fromStatus, to: t.toStatus })),
        systemOnly: ['overdue'],
      };
    });
  }

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

      // Two operators with the same case open: the second save must not
      // silently overwrite the first. Millisecond precision is enough — the
      // value round-trips through JSON as an ISO string.
      if (
        args.expectedUpdatedAt &&
        !Number.isNaN(Date.parse(args.expectedUpdatedAt)) &&
        row.updatedAt.getTime() !== new Date(args.expectedUpdatedAt).getTime()
      ) {
        throw new ConflictException(
          'This case changed since you loaded it. Review the latest state and try again.',
        );
      }

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
        // Stamped now rather than derived later: a subsequent SLA policy edit
        // must not be able to rewrite whether this case answered in time.
        patch.completedAfterDeadline = row.dueAt ? now > row.dueAt : false;

        // Appeal window, if this zone and request type offer one.
        const windowDays = await this.appealWindowDays(db, row.zoneId, row.requestTypes as string[]);
        if (windowDays > 0) {
          patch.canBeAppealed = true;
          patch.canAppealUntil = new Date(now.getTime() + windowDays * 86_400_000);
        }
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

    await this.collab.notifyWatchers(
      args.caseId,
      args.actorId,
      `Status changed to ${to}`,
      `${result.from} → ${to}${args.note ? ` — ${args.note}` : ''}`,
    );

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

  /**
   * How long this case may be appealed for, taking the most specific policy
   * that applies. Zero — the default on every policy — means this zone does
   * not offer appeals and no window is opened.
   */
  private async appealWindowDays(db: Db, zoneId: string, requestTypes: string[]): Promise<number> {
    const rows = await db
      .select({ requestType: slaPolicies.requestType, days: slaPolicies.appealWindowDays })
      .from(slaPolicies)
      .where(eq(slaPolicies.zoneId, zoneId));
    const specific = rows.find((r) => requestTypes?.includes(r.requestType));
    const fallback = rows.find((r) => r.requestType === '*');
    return Number((specific ?? fallback)?.days ?? 0);
  }

  /**
   * Record that the outcome report has gone to the requester.
   *
   * Closing a case and putting the answer in front of the person who asked are
   * different events, and the second is the one a regulator asks about. The
   * portal cannot observe a requester opening an email, so publication is
   * recorded here and receipt is recorded separately when there is evidence of
   * it — a read receipt, a reply, or an agent confirming it by phone.
   */
  async markReportPublished(ctx: ZoneContext, caseId: string, actorId: string, note?: string) {
    return this.stampDelivery(ctx, caseId, actorId, 'published', note);
  }

  async markReportAccessed(ctx: ZoneContext, caseId: string, actorId: string, note?: string) {
    return this.stampDelivery(ctx, caseId, actorId, 'accessed', note);
  }

  private async stampDelivery(
    ctx: ZoneContext,
    caseId: string,
    actorId: string,
    event: 'published' | 'accessed',
    note?: string,
  ) {
    const result = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      if (event === 'accessed' && !row.reportPublishedAt) {
        throw new BadRequestException('Publish the report before recording that it was read');
      }
      const now = new Date();
      await db
        .update(cases)
        .set(
          event === 'published'
            ? { reportPublishedAt: row.reportPublishedAt ?? now, updatedAt: now }
            : { reportAccessedAt: row.reportAccessedAt ?? now, updatedAt: now },
        )
        .where(eq(cases.id, caseId));

      // The timeline carries it without a status change, so the case history
      // reads as a sequence of events rather than only of state.
      await db.insert(caseStatusHistory).values({
        caseId,
        actorId,
        fromStatus: row.status,
        toStatus: row.status,
        note:
          (event === 'published'
            ? 'Outcome report published to the data subject'
            : 'Outcome report confirmed read by the data subject') +
          (note ? ` — ${note}` : ''),
      });
      return { zoneId: row.zoneId };
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: event === 'published' ? 'case.report_published' : 'case.report_accessed',
      entityType: 'case',
      entityId: caseId,
      zoneId: result.zoneId,
      after: { note },
    });
    return { ok: true };
  }

  /**
   * Open an appeal against a closed case.
   *
   * An appeal is a new request with its own deadline, not an edit to the one
   * being appealed — treating it as a reopen would erase the response time of
   * the original and hide the appeal from the SLA engine entirely. The two are
   * linked so the pair can be read together.
   */
  async openAppeal(
    ctx: ZoneContext,
    args: { caseId: string; reason: string; actorId: string; ip?: string },
  ) {
    if (!args.reason?.trim()) throw new BadRequestException('An appeal needs a reason');

    const created = await this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, args.caseId) });
      if (!row) throw new NotFoundException();
      if (row.status !== 'closed') {
        throw new BadRequestException('Only a closed case can be appealed');
      }
      if (!row.canBeAppealed) {
        throw new BadRequestException('This case is not open to appeal');
      }
      if (row.canAppealUntil && new Date() > row.canAppealUntil) {
        throw new BadRequestException(
          `The appeal window closed on ${row.canAppealUntil.toISOString().slice(0, 10)}`,
        );
      }

      const year = new Date().getFullYear();
      const seqRes = await client.query(
        `INSERT INTO case_sequences (zone_id, year, last_seq) VALUES ($1, $2, 1)
         ON CONFLICT (zone_id, year) DO UPDATE SET last_seq = case_sequences.last_seq + 1
         RETURNING last_seq`,
        [row.zoneId, year],
      );
      const ref = `DSR-${row.zoneId}-${year}-${String(Number(seqRes.rows[0].last_seq)).padStart(5, '0')}`;

      const policyRes = await client.query(
        `SELECT id, target_minutes FROM sla_policies
          WHERE zone_id = $1 AND (request_type = ANY($2::text[]) OR request_type = '*')
          ORDER BY (request_type = '*') ASC LIMIT 1`,
        [row.zoneId, (row.requestTypes as string[])?.length ? row.requestTypes : ['*']],
      );
      const policy = policyRes.rows[0] ?? null;
      const due = new Date(Date.now() + Number(policy?.target_minutes ?? 30 * 1440) * 60_000);

      const [appeal] = await db
        .insert(cases)
        .values({
          caseRef: ref,
          zoneId: row.zoneId,
          formKey: row.formKey,
          formVersion: row.formVersion,
          requestTypes: row.requestTypes,
          requesterEmailEnc: row.requesterEmailEnc,
          requesterEmailHmac: row.requesterEmailHmac,
          requesterNameEnc: row.requesterNameEnc,
          residency: row.residency,
          status: 'open',
          dueAt: due,
          isAppeal: true,
          appealOfCaseId: row.id,
          appealStatus: 'requested',
          source: row.source,
        })
        .returning({ id: cases.id });

      // Carry the original answers over: an appeal is judged against what was
      // asked, and re-keying it by hand is how detail gets lost.
      await client.query(
        `INSERT INTO case_fields (case_id, field_key, value_json, value_enc, encrypted)
         SELECT $1, field_key, value_json, value_enc, encrypted
           FROM case_fields WHERE case_id = $2`,
        [appeal.id, row.id],
      );

      await db.insert(caseStatusHistory).values({
        caseId: appeal.id,
        actorId: args.actorId,
        toStatus: 'open',
        note: `Appeal of ${row.caseRef}: ${args.reason.trim()}`,
      });
      await db.insert(caseStatusHistory).values({
        caseId: row.id,
        actorId: args.actorId,
        fromStatus: row.status,
        toStatus: row.status,
        note: `Appealed — see ${ref}`,
      });
      await db
        .update(cases)
        .set({ appealStatus: 'under_review', updatedAt: new Date() })
        .where(eq(cases.id, row.id));

      if (policy) {
        await db.insert(slaClocks).values({
          caseId: appeal.id,
          policyId: policy.id,
          startedAt: new Date(),
          dueAt: due,
          originalDueAt: due,
        });
      }
      return { id: appeal.id, caseRef: ref, zoneId: row.zoneId, of: row.caseRef };
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'case.appealed',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: created.zoneId,
      after: { appealCaseId: created.id, appealRef: created.caseRef, reason: args.reason },
      sourceIp: args.ip,
    });

    return { ok: true, id: created.id, caseRef: created.caseRef, appealOf: created.of };
  }

  /** Record how an appeal was decided, on the appeal case itself. */
  async setAppealStatus(ctx: ZoneContext, caseId: string, status: string, actorId: string) {
    if (!APPEAL_STATUSES.has(status)) {
      throw new BadRequestException(`Appeal status must be one of: ${[...APPEAL_STATUSES].join(', ')}`);
    }
    const zoneId = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      if (!row.isAppeal) throw new BadRequestException('This case is not an appeal');
      await db
        .update(cases)
        .set({ appealStatus: status, updatedAt: new Date() })
        .where(eq(cases.id, caseId));
      // The outcome belongs on the original too, which is where anyone
      // reviewing the history of the request will look for it.
      if (row.appealOfCaseId) {
        await db
          .update(cases)
          .set({ appealStatus: status, updatedAt: new Date() })
          .where(eq(cases.id, row.appealOfCaseId));
      }
      await db.insert(caseStatusHistory).values({
        caseId,
        actorId,
        fromStatus: row.status,
        toStatus: row.status,
        note: `Appeal ${status.replace('_', ' ')}`,
      });
      return row.zoneId;
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'case.appeal_decided',
      entityType: 'case',
      entityId: caseId,
      zoneId,
      after: { appealStatus: status },
    });
    return { ok: true };
  }
}
