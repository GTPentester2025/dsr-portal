import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import { caseStatusHistory, cases, slaClocks, slaPolicies } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import type { PoolClient } from 'pg';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';

/**
 * SLA engine (spec §8). Recomputes every minute and can be invoked after any case
 * mutation. Multi-instance safe: a Postgres advisory lock ensures only one
 * instance runs a sweep at a time, and threshold bookkeeping makes reminder
 * sends idempotent.
 */
@Injectable()
export class SlaService {
  private readonly log = new Logger(SlaService.name);
  private static readonly SWEEP_LOCK = 749_312;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly settings: SettingsService,
  ) {}

  // Every minute, not hourly: an SLA can now be set in minutes, and a sweep
  // that runs less often than the shortest policy would report a breach long
  // after it happened. The advisory lock keeps concurrent instances safe and
  // the query is indexed, so the cost is negligible.
  @Interval(60 * 1000)
  async sweep(): Promise<void> {
    try {
      await this.recomputeAll();
    } catch (err) {
      this.log.error(`SLA sweep failed: ${(err as Error).message}`);
    }
  }

  async recomputeAll(): Promise<{
    breached: number;
    reminders: number;
    escalations: number;
  }> {
    return this.db.system(async (_db, client) => {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [SlaService.SWEEP_LOCK]);
      if (!lock.rows[0].ok) return { breached: 0, reminders: 0, escalations: 0 };

      // 1. Breaches: running clocks past due -> case Overdue (system-set).
      //
      // Imported cases are excluded here as well as having their clocks
      // stopped at import. Their status is whatever the source export said and
      // changes only by a later upload, so the sweep must not rewrite it —
      // and an imported backlog is entirely made of open, long-past-due cases,
      // which is exactly what this query looks for.
      const breachedRes = await client.query(
        `UPDATE sla_clocks sc
            SET state = 'breached'
          FROM cases c
         WHERE sc.case_id = c.id
           AND sc.state = 'running'
           AND sc.due_at < now()
           AND c.status NOT IN ('closed')
           AND c.source <> 'import'
        RETURNING sc.case_id`,
      );
      for (const row of breachedRes.rows) {
        await client.query(
          `UPDATE cases SET status = 'overdue', updated_at = now()
            WHERE id = $1 AND status NOT IN ('closed', 'overdue')`,
          [row.case_id],
        );
        await client.query(
          `INSERT INTO case_status_history (case_id, to_status, note)
           SELECT $1, 'overdue', 'SLA breached (system)'
            WHERE NOT EXISTS (
              SELECT 1 FROM case_status_history
               WHERE case_id = $1 AND to_status = 'overdue'
                 AND created_at > now() - interval '1 day')`,
          [row.case_id],
        );
      }

      // 2. Reminders at configured thresholds (idempotent via fired list).
      const due = await client.query(
        `SELECT sc.id AS clock_id, sc.case_id, sc.started_at, sc.due_at,
                sc.fired_thresholds, sp.reminder_thresholds,
                c.case_ref, c.zone_id, c.status,
                -- Reminders go to everyone who can act on the case. Keying this
                -- on a single assignee meant an unassigned case reminded nobody.
                (SELECT array_agg(u.email)
                   FROM users u
                  WHERE u.active
                    AND u.role IN ('approver', 'zone_manager')
                    AND u.zone_id = c.zone_id
                    AND (u.ooo_from IS NULL OR u.ooo_to IS NULL
                         OR now() NOT BETWEEN u.ooo_from AND u.ooo_to)) AS recipients
           FROM sla_clocks sc
           JOIN sla_policies sp ON sp.id = sc.policy_id
           JOIN cases c ON c.id = sc.case_id
          WHERE sc.state IN ('running', 'breached')
            AND c.status NOT IN ('closed')`,
      );
      let reminders = 0;
      for (const row of due.rows) {
        const fired: number[] = row.fired_thresholds ?? [];
        const thresholds: number[] = row.reminder_thresholds ?? [];
        const total = new Date(row.due_at).getTime() - new Date(row.started_at).getTime();
        const used = Date.now() - new Date(row.started_at).getTime();
        const frac = total > 0 ? used / total : 1;
        const toFire = thresholds.filter((t) => frac >= t && !fired.includes(t));
        const recipients: string[] = row.recipients ?? [];
        if (toFire.length === 0) continue;
        if (recipients.length === 0) {
          this.log.warn(`no active approver in ${row.zone_id}; ${row.case_ref} reminder not sent`);
          continue;
        }
        const worst = Math.max(...toFire);
        const ok = await this.send(recipients, 'sla-reminder', {
          case_ref: row.case_ref,
          zone: row.zone_id,
          due_date: this.stamp(row.due_at),
          pct: String(Math.round(worst * 100)),
        });
        if (!ok) continue; // do not mark fired — retry next sweep
        reminders++;
        await client.query(`UPDATE sla_clocks SET fired_thresholds = $1 WHERE id = $2`, [
          JSON.stringify([...fired, ...toFire]),
          row.clock_id,
        ]);
      }
      // 3. Escalations: threshold reached, and cases nobody has picked up.
      const escalations =
        (await this.escalateOnThreshold(client)) + (await this.escalateUnassigned(client));

      return { breached: breachedRes.rowCount ?? 0, reminders, escalations };
    });
  }

  /**
   * Escalate once a clock passes the policy's escalation threshold.
   *
   * Separate from the reminder pass: reminders go to the assignee, escalations
   * go to whoever owns the zone's escalation address, and they fire once per
   * case rather than once per threshold.
   */
  private async escalateOnThreshold(client: PoolClient): Promise<number> {
    const rows = await client.query(
      `SELECT sc.id AS clock_id, sc.case_id, sc.started_at, sc.due_at,
              sp.escalation_threshold,
              c.case_ref, c.zone_id, c.status, c.request_types,
              ac.escalation_email,
              u.name AS assignee_name
         FROM sla_clocks sc
         JOIN sla_policies sp ON sp.id = sc.policy_id
         JOIN cases c ON c.id = sc.case_id
    LEFT JOIN assignment_config ac ON ac.zone_id = c.zone_id
    LEFT JOIN users u ON u.id = c.assignee_id
        WHERE sc.escalated_at IS NULL
          AND sc.state IN ('running', 'breached')
          AND c.status NOT IN ('closed')
          AND c.source <> 'import'`,
    );

    let sent = 0;
    for (const row of rows.rows) {
      const threshold = Number(row.escalation_threshold ?? 0.9);
      const total = new Date(row.due_at).getTime() - new Date(row.started_at).getTime();
      const used = Date.now() - new Date(row.started_at).getTime();
      const frac = total > 0 ? used / total : 1;
      if (frac < threshold) continue;

      const to = await this.escalationRecipients(client, row.zone_id, row.escalation_email);
      if (to.length === 0) {
        // Nothing to send to. Mark it anyway so the query does not reconsider
        // this case every minute forever; setting an address is an admin task.
        this.log.warn(`no escalation recipient for zone ${row.zone_id}; skipping ${row.case_ref}`);
        await client.query('UPDATE sla_clocks SET escalated_at = now() WHERE id = $1', [row.clock_id]);
        continue;
      }

      const ok = await this.send(to, 'case-escalated', {
        case_ref: row.case_ref,
        zone: row.zone_id,
        request_type: (row.request_types ?? []).join(', ') || 'n/a',
        assignee: row.assignee_name ?? 'nobody',
        status: row.status,
        pct: String(Math.round(frac * 100)),
        due_date: this.stamp(row.due_at),
        case_url: this.caseUrl(row.case_id),
      });
      if (!ok) continue; // leave escalated_at null so the next sweep retries

      await client.query('UPDATE sla_clocks SET escalated_at = now() WHERE id = $1', [row.clock_id]);
      await this.audit.record({
        actorId: null,
        actorType: 'system',
        action: 'sla.escalated',
        entityType: 'case',
        entityId: row.case_id,
        zoneId: row.zone_id,
        after: { pct: Math.round(frac * 100), to },
      });
      sent++;
    }
    return sent;
  }

  /** Escalate cases still sitting with no assignee after the configured delay. */
  private async escalateUnassigned(client: PoolClient): Promise<number> {
    const rows = await client.query(
      `SELECT c.id AS case_id, c.case_ref, c.zone_id, c.status, c.request_types,
              c.created_at, c.due_at,
              ac.escalation_email
         FROM cases c
         JOIN assignment_config ac ON ac.zone_id = c.zone_id
        WHERE c.assignee_id IS NULL
          AND c.unassigned_escalated_at IS NULL
          AND c.status NOT IN ('closed')
          AND c.source <> 'import'
          AND c.created_at < now() - (ac.escalation_after_minutes * interval '1 minute')`,
    );

    let sent = 0;
    for (const row of rows.rows) {
      const to = await this.escalationRecipients(client, row.zone_id, row.escalation_email);
      if (to.length === 0) {
        this.log.warn(`no escalation recipient for zone ${row.zone_id}; skipping ${row.case_ref}`);
        await client.query('UPDATE cases SET unassigned_escalated_at = now() WHERE id = $1', [row.case_id]);
        continue;
      }

      const waitedMins = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60_000);
      const ok = await this.send(to, 'case-unassigned', {
        case_ref: row.case_ref,
        zone: row.zone_id,
        request_type: (row.request_types ?? []).join(', ') || 'n/a',
        waiting: humanizeMinutes(waitedMins),
        submission_date: this.stamp(row.created_at),
        due_date: row.due_at ? this.stamp(row.due_at) : 'n/a',
        case_url: this.caseUrl(row.case_id),
      });
      if (!ok) continue;

      await client.query('UPDATE cases SET unassigned_escalated_at = now() WHERE id = $1', [row.case_id]);
      await this.audit.record({
        actorId: null,
        actorType: 'system',
        action: 'case.unassigned_escalated',
        entityType: 'case',
        entityId: row.case_id,
        zoneId: row.zone_id,
        after: { waitedMinutes: waitedMins, to },
      });
      sent++;
    }
    return sent;
  }

  /**
   * Who hears about an escalation: the zone's configured address if there is
   * one, otherwise that zone's managers and admins. Falling back matters — an
   * unset address should not mean silence.
   */
  private async escalationRecipients(
    client: PoolClient,
    zoneId: string,
    configured: string | null,
  ): Promise<string[]> {
    if (configured) return [configured];
    const res = await client.query(
      `SELECT email FROM users
        WHERE zone_id = $1 AND active AND role IN ('zone_manager', 'admin')`,
      [zoneId],
    );
    return res.rows.map((r) => r.email as string);
  }

  /** Send to every recipient; true only if at least one delivery succeeded. */
  private async send(
    to: string[],
    templateId: string,
    vars: Record<string, string>,
  ): Promise<boolean> {
    let any = false;
    for (const addr of to) {
      try {
        await this.email.sendTransactional(addr, templateId, vars);
        any = true;
      } catch (err) {
        this.log.warn(`${templateId} to ${addr} failed: ${(err as Error).message}`);
      }
    }
    return any;
  }

  private caseUrl(caseId: string): string {
    const base = this.settings.get<string>('INTERNAL_BASE_URL', 'http://127.0.0.1:5181');
    return `${base}/#/cases/${caseId}`;
  }

  /** Minute precision: a date alone is useless for a short SLA. */
  private stamp(value: string | Date): string {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  /**
   * Push the response deadline out by hand.
   *
   * Separate from the 'extended' status transition: that one is a workflow step
   * with its own legal-transition rules, while this is the everyday act of
   * granting more time on a case that is already open. Both record a
   * justification, because an extension without a stated reason is not
   * defensible to a regulator.
   */
  async extend(
    ctx: ZoneContext,
    caseId: string,
    args: { value: number; unit: 'minutes' | 'hours' | 'days'; justification: string },
    actorId: string,
  ) {
    const factor = { minutes: 1, hours: 60, days: 1440 }[args.unit];
    if (!factor) throw new BadRequestException('Unit must be minutes, hours or days');
    const value = Number(args.value);
    if (!Number.isInteger(value) || value < 1 || value * factor > 525_600) {
      throw new BadRequestException('Extension must be a whole number, up to one year');
    }
    if (!args.justification?.trim()) {
      throw new BadRequestException('An extension needs a justification');
    }

    const result = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      if (row.status === 'closed') {
        throw new BadRequestException('A closed case cannot be extended');
      }

      const clock = await db.query.slaClocks.findFirst({ where: eq(slaClocks.caseId, caseId) });
      const addMs = value * factor * 60_000;
      // Extend from the current deadline, not from now: extending a case that
      // is already overdue should still move the bar forward by the full amount.
      const previousDue = clock?.dueAt ?? row.dueAt ?? new Date();
      const newDue = new Date(previousDue.getTime() + addMs);

      // 'overdue' is derived by the sweep, not chosen by a person, so granting
      // time has to undo it — otherwise the case reads Overdue while its clock
      // shows time remaining. Any status a human set is left alone.
      const restored = row.status === 'overdue' && newDue > new Date() ? 'open' : row.status;
      await db
        .update(cases)
        .set({ dueAt: newDue, status: restored, updatedAt: new Date() })
        .where(eq(cases.id, caseId));

      if (clock) {
        await db
          .update(slaClocks)
          .set({
            dueAt: newDue,
            // A breached clock that has been given more time is running again,
            // and must be able to breach a second time.
            state: clock.state === 'breached' ? 'running' : clock.state,
            escalatedAt: null,
            extensionJustification: args.justification,
          })
          .where(eq(slaClocks.id, clock.id));
      }

      await db.insert(caseStatusHistory).values({
        caseId,
        actorId,
        fromStatus: row.status,
        toStatus: restored,
        note: `SLA extended by ${value} ${args.unit} to ${newDue.toISOString().slice(0, 16).replace('T', ' ')} UTC — ${args.justification}`,
      });

      return { zoneId: row.zoneId, previousDue, newDue };
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'sla.extended',
      entityType: 'case',
      entityId: caseId,
      zoneId: result.zoneId,
      before: { dueAt: result.previousDue.toISOString() },
      after: {
        dueAt: result.newDue.toISOString(),
        by: `${value} ${args.unit}`,
        justification: args.justification,
      },
    });

    return { ok: true, dueAt: result.newDue.toISOString() };
  }

  /** Pause the clock while awaiting the requester (policy-gated, spec §8). */
  async pause(ctx: ZoneContext, caseId: string, actorId: string) {
    const zoneId = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      const clock = await db.query.slaClocks.findFirst({ where: eq(slaClocks.caseId, caseId) });
      if (!clock || clock.state !== 'running') throw new BadRequestException('Clock is not running');
      const policy = await db.query.slaPolicies.findFirst({ where: eq(slaPolicies.id, clock.policyId) });
      if (!policy?.pauseAllowed) {
        throw new BadRequestException('This zone/request type does not permit pausing the SLA clock');
      }
      await db.update(slaClocks).set({ state: 'paused', pausedAt: new Date() }).where(eq(slaClocks.id, clock.id));
      return row.zoneId;
    });
    await this.audit.record({
      actorId, actorType: 'user', action: 'sla.paused',
      entityType: 'case', entityId: caseId, zoneId,
    });
    return { ok: true };
  }

  /** Resume: paused duration is excluded — due date shifts by the gap. */
  async resume(ctx: ZoneContext, caseId: string, actorId: string) {
    const zoneId = await this.db.withContext(ctx, async (db) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, caseId) });
      if (!row) throw new NotFoundException();
      const clock = await db.query.slaClocks.findFirst({ where: eq(slaClocks.caseId, caseId) });
      if (!clock || clock.state !== 'paused' || !clock.pausedAt) {
        throw new BadRequestException('Clock is not paused');
      }
      const pausedSecs = Math.floor((Date.now() - clock.pausedAt.getTime()) / 1000);
      const newDue = new Date(clock.dueAt.getTime() + pausedSecs * 1000);
      await db
        .update(slaClocks)
        .set({
          state: 'running',
          pausedAt: null,
          pausedTotalSecs: clock.pausedTotalSecs + pausedSecs,
          dueAt: newDue,
        })
        .where(eq(slaClocks.id, clock.id));
      await db.update(cases).set({ dueAt: newDue, updatedAt: new Date() }).where(eq(cases.id, caseId));
      return row.zoneId;
    });
    await this.audit.record({
      actorId, actorType: 'user', action: 'sla.resumed',
      entityType: 'case', entityId: caseId, zoneId,
    });
    return { ok: true };
  }
}

/** "3 minutes", "2 hours", "4 days" — whichever unit reads naturally. */
function humanizeMinutes(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins < 1440) {
    const h = Math.round(mins / 60);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(mins / 1440);
  return `${d} day${d === 1 ? '' : 's'}`;
}
