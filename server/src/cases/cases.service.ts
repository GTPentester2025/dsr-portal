import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import {
  caseFields,
  caseStatusHistory,
  cases,
  emailLog,
  slaClocks,
  users,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { cursorClause, nextCursor, type Cursor } from './keyset';

export interface CaseListQuery {
  status?: string;
  zone?: string;
  assigneeId?: string;
  /** Drill-down from the dashboard: 'overdue' | 'at_risk' | 'on_track' | 'closed'. */
  slaState?: string;
  requestType?: string;
  /** ISO dates, inclusive, on created_at. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Shared by the paged list and the CSV export so the file a manager downloads
 * always contains exactly the rows they were looking at.
 */
function listFilters(q: CaseListQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value?: unknown) => {
    if (value !== undefined) params.push(value);
    clauses.push(clause);
  };

  if (q.status) add(`c.status = $${params.length + 1}`, q.status);
  if (q.zone) add(`c.zone_id = $${params.length + 1}`, q.zone);
  if (q.assigneeId) add(`c.assignee_id = $${params.length + 1}`, q.assigneeId);
  if (q.requestType) add(`c.request_types ? $${params.length + 1}`, q.requestType);
  if (q.from) add(`c.created_at >= $${params.length + 1}`, q.from);
  // Inclusive of the whole end day rather than midnight on it.
  if (q.to) add(`c.created_at < ($${params.length + 1}::date + interval '1 day')`, q.to);

  // Mirrors the dashboard's SLA buckets exactly; a drill-down that disagreed
  // with the card it came from would be worse than no drill-down.
  switch (q.slaState) {
    case 'closed':
      clauses.push(`c.status = 'closed'`);
      break;
    case 'overdue':
      clauses.push(`c.status <> 'closed' AND c.due_at < now()`);
      break;
    case 'at_risk':
      clauses.push(`c.status <> 'closed' AND c.due_at BETWEEN now() AND now() + interval '3 days'`);
      break;
    case 'on_track':
      clauses.push(`c.status <> 'closed' AND c.due_at > now() + interval '3 days'`);
      break;
    default:
      break;
  }

  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * One row per case with the columns an operator actually works from: when it
 * arrived, which country it came from, and who can act on it. Approvers are
 * derived from the zone because cases are not assigned to individuals.
 */
const LIST_SELECT = `
  WITH approvers AS (
    SELECT zone_id,
           string_agg(name, ', ' ORDER BY name) AS names,
           array_agg(email ORDER BY name) AS emails
      FROM users
     WHERE active AND role = 'approver'
     GROUP BY zone_id
  )
  SELECT c.id, c.case_ref, c.zone_id, c.form_key, c.request_types, c.status,
         c.assignee_id, c.due_at, c.created_at, c.requester_email_enc,
         c.pending_party, c.pending_on,
         cf.value_json #>> '{}' AS country,
         COALESCE(app.names, '') AS approvers,
         COALESCE(app.emails, ARRAY[]::text[]) AS approver_emails
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT value_json FROM case_fields
       WHERE case_id = c.id AND field_key = 'country' LIMIT 1
    ) cf ON true
    LEFT JOIN approvers app ON app.zone_id = c.zone_id
   WHERE true`;


@Injectable()
export class CasesService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

  /** Zone visibility comes from RLS via ctx — no zone filter in app code. */
  async list(ctx: ZoneContext, q: CaseListQuery) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    return this.db.withContext(ctx, async (_db, client) => {
      const { sql: filterSql, params } = listFilters(q);
      const rows = await client.query(
        `${LIST_SELECT} ${filterSql}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const counted = await client.query(
        `SELECT count(*)::int AS n FROM cases c WHERE true ${filterSql}`,
        params,
      );
      return {
        total: counted.rows[0].n as number,
        page,
        pageSize,
        items: rows.rows.map((r) => this.shapeListRow(r)),
      };
    });
  }

  /** camelCase for the client, with the encrypted address resolved once. */
  private shapeListRow(r: Record<string, unknown>) {
    return {
      id: r.id as string,
      caseRef: r.case_ref as string,
      zoneId: r.zone_id as string,
      formKey: r.form_key as string,
      requestTypes: (r.request_types ?? []) as string[],
      status: r.status as string,
      assigneeId: (r.assignee_id ?? null) as string | null,
      dueAt: r.due_at as string | null,
      createdAt: r.created_at as string,
      country: (r.country ?? null) as string | null,
      approvers: (r.approvers ?? '') as string,
      // Used to pre-fill Cc when an agent replies from the case screen.
      approverEmails: (r.approver_emails ?? []) as string[],
      requesterEmail: this.safeDecrypt(r.requester_email_enc as string | null),
      pendingParty: (r.pending_party ?? null) as string | null,
      pendingOn: (r.pending_on ?? null) as string | null,
    };
  }

  /**
   * Every case matching the filters, yielded a batch at a time.
   *
   * The old implementation capped at 10,000 rows and built the whole array in
   * memory, so a larger filter silently exported a prefix -- an operator had no
   * way to know the file was short. Batching by keyset bounds memory to one
   * batch and removes the cap.
   *
   * Each batch is its own short transaction, so an export is not a consistent
   * snapshot: a case created mid-export may or may not appear. For an
   * operational CSV that is the right trade against holding one transaction
   * open for the length of a large download.
   */
  async *streamExportRows(ctx: ZoneContext, q: CaseListQuery, batchSize = 1000) {
    let cursor: Cursor | null = null;
    for (;;) {
      const batch: ReturnType<typeof this.shapeListRow>[] = await this.db.withContext(
        ctx,
        async (_db, client) => {
          const { sql: filterSql, params } = listFilters(q);
          const keyset = cursorClause(cursor, params.length + 1);
          const rows = await client.query(
            `${LIST_SELECT} ${filterSql}${keyset.sql}
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ${batchSize}`,
            [...params, ...keyset.params],
          );
          return rows.rows.map((r) => this.shapeListRow(r));
        },
        // An export legitimately outlives an interactive query. Each batch is
        // its own transaction, so this is a per-batch budget, not a total.
        { statementTimeoutMs: 60_000 },
      );
      if (batch.length === 0) return;
      yield batch;
      cursor = nextCursor(batch as { createdAt: unknown; id: string }[]);
      if (batch.length < batchSize) return;
    }
  }

  async detail(ctx: ZoneContext, id: string) {
    return this.db.withContext(ctx, async (db, client) => {
      const row = await db.query.cases.findFirst({ where: eq(cases.id, id) });
      if (!row) throw new NotFoundException();
      const fields = await db.select().from(caseFields).where(eq(caseFields.caseId, id));
      // Join the actor in: a timeline that cannot say who did something is not
      // much of an audit trail. actorId is null for system-driven entries.
      const history = await db
        .select({
          id: caseStatusHistory.id,
          actorId: caseStatusHistory.actorId,
          fromStatus: caseStatusHistory.fromStatus,
          toStatus: caseStatusHistory.toStatus,
          note: caseStatusHistory.note,
          createdAt: caseStatusHistory.createdAt,
          actorName: users.name,
          actorEmail: users.email,
          actorRole: users.role,
        })
        .from(caseStatusHistory)
        .leftJoin(users, eq(users.id, caseStatusHistory.actorId))
        .where(eq(caseStatusHistory.caseId, id))
        .orderBy(desc(caseStatusHistory.createdAt));
      const clock = await db.query.slaClocks.findFirst({ where: eq(slaClocks.caseId, id) });

      // Everything recorded against this case, including actions that left the
      // status untouched: SLA extensions, sends, views.
      const activityRows = await client.query(
        `SELECT a.id, a.action, a.created_at, a.before, a.after, a.source_ip,
                a.actor_type, u.name AS actor_name, u.email AS actor_email, u.role AS actor_role
           FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = 'case' AND a.entity_id = $1
          ORDER BY a.created_at DESC
          LIMIT 200`,
        [id],
      );
      const emails = await db
        .select()
        .from(emailLog)
        .where(eq(emailLog.caseId, id))
        .orderBy(desc(emailLog.createdAt));

      // Who a reply should copy in by default. Read through the system role
      // because RLS scopes `users` to the caller's own zone context.
      const approverRows = await this.db.system(async (_sdb, sclient) =>
        sclient.query(
          `SELECT email FROM users
            WHERE active AND role = 'approver' AND zone_id = $1
            ORDER BY name`,
          [row.zoneId],
        ),
      );

      return {
        ...row,
        approverEmails: approverRows.rows.map((r: { email: string }) => r.email),
        requesterEmailEnc: undefined,
        requesterEmailHmac: undefined,
        requesterNameEnc: undefined,
        requesterEmail: this.safeDecrypt(row.requesterEmailEnc),
        requesterName: row.requesterNameEnc ? this.safeDecrypt(row.requesterNameEnc) : null,
        fields: fields.map((f) => ({
          key: f.fieldKey,
          value: f.encrypted ? this.safeDecrypt(f.valueEnc ?? '') : f.valueJson,
          encrypted: f.encrypted,
        })),
        history,
        activity: activityRows.rows,
        slaClock: clock ?? null,
        emails,
      };
    });
  }

  /**
   * Everything needed to render a case as a document.
   *
   * Built from the same detail query the screen uses, plus the list row for the
   * derived country and approvers, so the PDF cannot show different facts from
   * the page it was printed from.
   */
  async buildDocument(ctx: ZoneContext, id: string) {
    const detail = (await this.detail(ctx, id)) as Record<string, any>;
    const extra = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `${LIST_SELECT} AND c.id = $1 LIMIT 1`,
        [id],
      );
      return r.rows[0] ?? {};
    });
    const files = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT filename, size_bytes, source, created_at
           FROM case_attachments WHERE case_id = $1 ORDER BY created_at`,
        [id],
      );
      return r.rows;
    });

    return {
      caseRef: detail.caseRef,
      zoneId: detail.zoneId,
      status: detail.status,
      formKey: detail.formKey,
      createdAt: detail.createdAt,
      dueAt: detail.dueAt ?? null,
      closedAt: detail.closedAt ?? null,
      requesterEmail: detail.requesterEmail,
      requesterName: detail.requesterName ?? null,
      requestTypes: (detail.requestTypes ?? []) as string[],
      country: (extra.country ?? null) as string | null,
      pendingOn: detail.pendingOn ?? null,
      pendingParty: detail.pendingParty ?? null,
      approvers: (extra.approvers ?? '') as string,
      outcomeCode: detail.outcomeCode ?? null,
      closureNote: detail.closureNote ?? null,
      fields: detail.fields ?? [],
      history: (detail.history ?? []).map((h: Record<string, unknown>) => ({
        fromStatus: (h.fromStatus ?? null) as string | null,
        toStatus: h.toStatus as string,
        note: (h.note ?? null) as string | null,
        createdAt: String(h.createdAt),
        actorName: (h.actorName ?? null) as string | null,
      })),
      emails: (detail.emails ?? []).map((e: Record<string, unknown>) => ({
        subject: e.subject as string,
        toAddrs: (e.toAddrs ?? []) as string[],
        status: e.status as string,
        createdAt: String(e.createdAt),
      })),
      attachments: files,
    };
  }

  private safeDecrypt(payload: string | null): string {
    if (!payload) return '';
    try {
      return this.crypto.decrypt(payload);
    } catch {
      return '(decryption failed)';
    }
  }
}

/**
 * One case as the list and the CSV export see it.
 *
 * Derived from the shaping rather than written out a second time: a
 * hand-copied interface is free to drift from the columns the export
 * actually contains.
 */
export type CaseListRow = ReturnType<CasesService['shapeListRow']>;
