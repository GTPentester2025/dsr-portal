import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { CryptoService } from '../crypto/crypto.service';
import { and, eq, sql } from 'drizzle-orm';
import { DbService, ZoneContext, type Db } from '../db/db.module';
import { assignmentConfig, cases, emailLog, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';

interface Candidate {
  id: string;
  email: string;
  name: string;
  capacityWeight: number;
  openCases: number;
}

@Injectable()
export class AssignmentService {
  private readonly log = new Logger(AssignmentService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly crypto: CryptoService,
  ) {}

  /** Auto-assign a new case per the zone's strategy. Safe to call from intake. */
  /**
   * Move an unassignable case into the work queue.
   *
   * `new` is an intake state: it means "not yet triaged", and a case that
   * nobody can be assigned to is still the zone's problem. Marking it pending
   * on the team is what makes it visible in the queue and on the dashboard.
   */
  private async openUnassigned(
    db: Db,
    client: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> },
    caseId: string,
    currentStatus: string,
    zoneId: string,
    why: string,
  ): Promise<void> {
    if (currentStatus !== 'new') return;
    await db
      .update(cases)
      .set({
        status: 'open',
        pendingParty: 'internal',
        pendingOn: `${zoneId} team`,
        pendingSince: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId));
    await client.query(
      `INSERT INTO case_status_history (case_id, to_status, from_status, note)
       VALUES ($1, 'open', 'new', $2)`,
      [caseId, `Queued for the ${zoneId} team — ${why}`],
    );
  }

  async autoAssign(caseId: string): Promise<string | null> {
    const assigneeId = await this.db.system(async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row || row.assigneeId) return null;
      const cfg = await db.query.assignmentConfig.findFirst({
        where: eq(assignmentConfig.zoneId, row.zoneId),
      });
      const strategy = cfg?.strategy ?? 'round_robin';
      if (strategy === 'manual') {
        // A queue is still work in progress. Leaving it `new` is how cases sat
        // untouched until they breached.
        await this.openUnassigned(db, client, caseId, row.status, row.zoneId, 'awaiting manual pickup');
        return null;
      }

      const candidates = await this.candidates(client, row.zoneId);
      if (candidates.length === 0) {
        // OOO/inactive must not black-hole tickets (spec §6): flag loudly.
        this.log.warn(`No assignable member in zone ${row.zoneId} for ${row.caseRef}`);
        await this.openUnassigned(db, client, caseId, row.status, row.zoneId, 'no assignable member in the zone');
        return null;
      }

      let chosen: Candidate;
      if (strategy === 'least_open') {
        chosen = [...candidates].sort((a, b) => a.openCases - b.openCases)[0];
      } else if (strategy === 'weighted') {
        chosen = [...candidates].sort(
          (a, b) => a.openCases / Math.max(1, a.capacityWeight) - b.openCases / Math.max(1, b.capacityWeight),
        )[0];
      } else {
        // round robin from the stored cursor
        const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
        const cursor = cfg?.rrCursor;
        const idx = cursor ? sorted.findIndex((c) => c.id > cursor) : 0;
        chosen = sorted[idx === -1 ? 0 : idx];
        await db
          .update(assignmentConfig)
          .set({ rrCursor: chosen.id })
          .where(eq(assignmentConfig.zoneId, row.zoneId));
      }

      await db
        .update(cases)
        .set({
          assigneeId: chosen.id,
          status: 'open',
          pendingParty: 'internal',
          pendingOn: chosen.name,
          pendingSince: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(cases.id, caseId));
      await client.query(
        `INSERT INTO case_status_history (case_id, to_status, from_status, note)
         VALUES ($1, 'open', 'new', $2)`,
        [caseId, `Auto-assigned to ${chosen.name} (${strategy})`],
      );
      await this.notifyAssignee(chosen, row.caseRef, row.zoneId, row.requestTypes as string[], row.createdAt, row.dueAt, caseId);
      return chosen.id;
    });

    if (assigneeId) {
      await this.audit.record({
        actorType: 'system',
        action: 'case.auto_assigned',
        entityType: 'case',
        entityId: caseId,
        after: { assigneeId },
      });
    }
    return assigneeId;
  }

  /** Manual (re)assignment; reason mandatory when replacing an assignee. */
  async assign(ctx: ZoneContext, args: { caseId: string; assigneeId: string; reason?: string; actorId: string; ip?: string }) {
    const result = await this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, args.caseId) });
      if (!row) throw new NotFoundException();
      if (row.assigneeId && !args.reason?.trim()) {
        throw new BadRequestException('Reassignment requires a reason');
      }
      const target = await db.query.users.findFirst({
        where: and(eq(users.id, args.assigneeId), eq(users.active, true)),
      });
      if (!target) throw new BadRequestException('Assignee not found or inactive');
      if (target.zoneId && target.zoneId !== row.zoneId) {
        throw new BadRequestException('Assignee belongs to a different zone');
      }
      // Once a case has an owner it is pending on that person, not on the
      // zone queue. Left alone when we are waiting on the requester — giving
      // the case an owner does not change who owes the next move.
      const waitingOnRequester = row.pendingParty === 'customer';
      await db
        .update(cases)
        .set({
          assigneeId: args.assigneeId,
          updatedAt: new Date(),
          ...(waitingOnRequester
            ? {}
            : { pendingParty: 'internal', pendingOn: target.name, pendingSince: new Date() }),
        })
        .where(eq(cases.id, args.caseId));
      const cand: Candidate = {
        id: target.id, email: target.email, name: target.name,
        capacityWeight: target.capacityWeight, openCases: 0,
      };
      await this.notifyAssignee(cand, row.caseRef, row.zoneId, row.requestTypes as string[], row.createdAt, row.dueAt, row.id);
      return { previous: row.assigneeId, zoneId: row.zoneId, caseRef: row.caseRef };
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'case.reassigned',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: result.zoneId,
      before: { assigneeId: result.previous },
      after: { assigneeId: args.assigneeId, reason: args.reason },
      sourceIp: args.ip,
    });
    return { ok: true };
  }

  private async candidates(client: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> }, zoneId: string): Promise<Candidate[]> {
    const res = await client.query(
      `SELECT u.id, u.email, u.name, u.capacity_weight,
              (SELECT count(*) FROM cases c
                WHERE c.assignee_id = u.id AND c.status NOT IN ('closed'))::int AS open_cases
         FROM users u
        WHERE u.zone_id = $1
          AND u.active
          AND u.role IN ('approver', 'zone_manager')
          AND (u.ooo_from IS NULL OR u.ooo_to IS NULL
               OR now() NOT BETWEEN u.ooo_from AND u.ooo_to)`,
      [zoneId],
    );
    return res.rows.map((r) => ({
      id: r.id, email: r.email, name: r.name,
      capacityWeight: r.capacity_weight, openCases: r.open_cases,
    }));
  }

  /**
   * Tell a zone about a new request.
   *
   * Cases are no longer routed to one named person: every approver in the zone
   * owns every request in it, so a case that nobody happened to be assigned can
   * no longer go unnoticed. Managers are copied on the same message and see the
   * same detail, including who the approvers are.
   */
  async notifyZone(caseId: string): Promise<number> {
    const data = await this.db.system(async (_db, client) => {
      const caseRes = await client.query(
        `SELECT c.id, c.case_ref, c.zone_id, c.request_types, c.created_at, c.due_at,
                c.requester_email_enc
           FROM cases c WHERE c.id = $1`,
        [caseId],
      );
      const row = caseRes.rows[0];
      if (!row) return null;

      // Approvers work the case; managers and admins for the zone are copied.
      const people = await client.query(
        `SELECT email, name, role FROM users
          WHERE active
            AND role IN ('approver', 'zone_manager', 'admin')
            AND (zone_id = $1 OR role = 'admin')
            AND (ooo_from IS NULL OR ooo_to IS NULL OR now() NOT BETWEEN ooo_from AND ooo_to)
          ORDER BY role, name`,
        [row.zone_id],
      );
      return { row, people: people.rows as { email: string; name: string; role: string }[] };
    });
    if (!data) return 0;

    const { row, people } = data;
    if (people.length === 0) {
      this.log.warn(`no active approvers or managers in ${row.zone_id}; ${row.case_ref} notified nobody`);
      return 0;
    }

    const approvers = people.filter((p) => p.role === 'approver');
    const approverList =
      approvers.length > 0
        ? approvers.map((a) => `${a.name} (${a.email})`).join('<br>')
        : 'No approver is currently active in this zone.';

    let requesterEmail = 'not available';
    try {
      if (row.requester_email_enc) {
        requesterEmail = this.crypto.decrypt(row.requester_email_enc);
      }
    } catch {
      // A case whose email cannot be decrypted must still raise a notification.
      requesterEmail = 'could not be decrypted';
    }

    const base = this.config.get<string>('INTERNAL_BASE_URL', 'http://127.0.0.1:5181');
    const vars = {
      case_ref: row.case_ref,
      zone: row.zone_id,
      request_type: (row.request_types ?? []).join(', ') || 'n/a',
      requester_email: requesterEmail,
      submission_date: stamp(row.created_at),
      due_date: row.due_at ? stamp(row.due_at) : 'n/a',
      case_url: `${base}/#/cases/${row.id}`,
      approvers: approverList,
    };

    let sent = 0;
    for (const person of people) {
      try {
        const result = await this.email.sendTransactional(person.email, 'case-new', vars);
        sent++;
        await this.db.system((sdb) =>
          sdb.insert(emailLog).values({
            caseId,
            provider: this.email.activeName(),
            fromAddr: 'transactional',
            toAddrs: [person.email],
            subject: result.subject ?? `[${row.zone_id}] New privacy request ${row.case_ref}`,
            bodyHtml: result.html,
            templateId: 'case-new',
            status: 'sent',
            providerMessageId: result.providerMessageId,
          }),
        );
      } catch (err) {
        this.log.error(`new-case notice to ${person.email} failed: ${(err as Error).message}`);
        await this.db.system((sdb) =>
          sdb.insert(emailLog).values({
            caseId,
            provider: this.email.activeName(),
            fromAddr: 'transactional',
            toAddrs: [person.email],
            subject: `[${row.zone_id}] New privacy request ${row.case_ref}`,
            templateId: 'case-new',
            status: 'failed',
            error: (err as Error).message,
          }),
        );
      }
    }
    this.log.log(`${row.case_ref}: notified ${sent}/${people.length} in ${row.zone_id}`);
    return sent;
  }

  private async notifyAssignee(
    target: Candidate,
    caseRef: string,
    zone: string,
    requestTypes: string[],
    createdAt: Date,
    dueAt: Date | null,
    caseId: string,
  ): Promise<void> {
    const base = this.config.get<string>('INTERNAL_BASE_URL', 'http://127.0.0.1:5181');
    try {
      const result = await this.email.sendTransactional(target.email, 'case-assigned', {
        case_ref: caseRef,
        zone,
        request_type: requestTypes.join(', ') || 'n/a',
        submission_date: createdAt.toISOString().slice(0, 10),
        due_date: dueAt ? dueAt.toISOString().slice(0, 10) : 'n/a',
        case_url: `${base}/#/cases/${caseId}`,
      });
      await this.db.system((sdb) =>
        sdb.insert(emailLog).values({
          caseId,
          provider: this.email.activeName(),
          fromAddr: 'transactional',
          toAddrs: [target.email],
          subject: result.subject ?? `[${zone}] Case ${caseRef} assigned to you`,
          bodyHtml: result.html,
          templateId: 'case-assigned',
          status: 'sent',
          providerMessageId: result.providerMessageId,
        }),
      );
    } catch (err) {
      this.log.error(`assignee notification failed for ${caseRef}: ${(err as Error).message}`);
      await this.db.system((sdb) =>
        sdb.insert(emailLog).values({
          caseId,
          provider: this.email.activeName(),
          fromAddr: 'transactional',
          toAddrs: [target.email],
          subject: `[${zone}] Case ${caseRef} assigned to you`,
          templateId: 'case-assigned',
          status: 'failed',
          error: (err as Error).message,
        }),
      );
    }
  }
}

/** Minute precision: a bare date is useless when an SLA can be minutes long. */
function stamp(value: string | Date): string {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
