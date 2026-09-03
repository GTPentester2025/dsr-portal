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
import { collectInputs, type Component } from '../public/form-validation';
import { slaBucketSql } from './sla-buckets';

export interface CaseListQuery {
  status?: string;
  zone?: string;
  /** A user id, or the literal 'none' for unassigned cases. */
  assigneeId?: string;
  /** Drill-down from the dashboard: 'overdue' | 'at_risk' | 'on_track' | 'closed'. */
  slaState?: string;
  requestType?: string;
  /** ISO dates, inclusive, on created_at. */
  from?: string;
  to?: string;
  /** 'normal' | 'high'. */
  priority?: string;
  /** One tag; a case matches when its tags contain it. */
  tag?: string;
  /** 'hide' removes actively snoozed cases from the view. */
  snoozed?: string;
  /**
   * Free text: matched against the case reference and external id (contains),
   * and — when it looks like an address — the requester's email, which is
   * held encrypted and therefore matched by HMAC, exactly.
   */
  search?: string;
  /** Precomputed by the service from `search`; never accepted from a client. */
  searchEmailHmac?: string;
  sort?: 'created' | 'due' | 'status';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** Sort keys the list accepts, mapped to SQL. Whitelist — never interpolate input. */
const SORTS: Record<string, string> = {
  // NULLS LAST on due: a case with no clock belongs at the end whichever way
  // the deadline column is sorted.
  due_asc: 'c.due_at ASC NULLS LAST, c.created_at DESC, c.id DESC',
  due_desc: 'c.due_at DESC NULLS LAST, c.created_at DESC, c.id DESC',
  created_asc: 'c.created_at ASC, c.id ASC',
  created_desc: 'c.created_at DESC, c.id DESC',
  status_asc: 'c.status ASC, c.created_at DESC, c.id DESC',
  status_desc: 'c.status DESC, c.created_at DESC, c.id DESC',
};

function orderBy(q: CaseListQuery): string {
  return SORTS[`${q.sort ?? 'created'}_${q.dir ?? 'desc'}`] ?? SORTS.created_desc;
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
  if (q.assigneeId === 'none') {
    clauses.push('c.assignee_id IS NULL');
  } else if (q.assigneeId) {
    add(`c.assignee_id = $${params.length + 1}`, q.assigneeId);
  }
  if (q.requestType) add(`c.request_types ? $${params.length + 1}`, q.requestType);
  if (q.priority) add(`c.priority = $${params.length + 1}`, q.priority);
  if (q.tag) add(`c.tags ? $${params.length + 1}`, q.tag);
  // A snooze that has lapsed is over; only a future one hides the case.
  if (q.snoozed === 'hide') {
    clauses.push(`(c.snoozed_until IS NULL OR c.snoozed_until <= now())`);
  }
  if (q.from) add(`c.created_at >= $${params.length + 1}`, q.from);
  // Inclusive of the whole end day rather than midnight on it.
  if (q.to) add(`c.created_at < ($${params.length + 1}::date + interval '1 day')`, q.to);

  // Server-side search. The requester's address is stored encrypted, so free
  // text cannot match it — the service precomputes an HMAC when the term looks
  // like an address, and that matches the whole address exactly, the same way
  // intake dedup does.
  const term = q.search?.trim();
  if (term) {
    const like = `(c.case_ref ILIKE $${params.length + 1}
       OR c.external_id ILIKE $${params.length + 1}
       OR c.external_request_id ILIKE $${params.length + 1})`;
    if (q.searchEmailHmac) {
      params.push(`%${term}%`, q.searchEmailHmac);
      clauses.push(`(${like} OR c.requester_email_hmac = $${params.length})`);
    } else {
      params.push(`%${term}%`);
      clauses.push(like);
    }
  }

  // Mirrors the dashboard's SLA buckets exactly; a drill-down that disagreed
  // with the card it came from would be worse than no drill-down. One shared
  // definition (sla-buckets.ts) is what makes that a guarantee, not a hope.
  const buckets = slaBucketSql('c');
  if (q.slaState && q.slaState in buckets) {
    clauses.push(buckets[q.slaState as keyof typeof buckets]);
  }

  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * A single label for how far a case has travelled, spanning the two things the
 * status column deliberately does not cover: that closing a case and getting
 * the outcome report in front of the requester are different events, and that
 * a closed case may still be inside its appeal window.
 *
 * Kept as a derived label rather than extra statuses so the SLA engine, the
 * dashboard and the transition table keep working off the seven states they
 * were built around.
 */
export function progressOf(r: Record<string, unknown>): string {
  if (r.report_accessed_at) return 'Report accessed by data subject';
  if (r.report_published_at) return 'Report published';
  if (r.appeal_status === 'requested' || r.appeal_status === 'under_review') return 'Under appeal';
  if (r.status === 'closed') return 'Closed — report not sent';
  return String(r.status ?? '');
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
  SELECT c.id, c.case_ref, c.zone_id, c.form_key, c.form_version, c.request_types, c.status,
         c.assignee_id, c.due_at, c.created_at, c.requester_email_enc, c.requester_name_enc,
         c.pending_party, c.pending_on,
         c.closed_at, c.outcome_code, c.closure_note, c.residency,
         c.skip_completion_notification, c.completed_after_deadline, c.auto_extended,
         c.report_published_at, c.report_accessed_at,
         c.can_be_appealed, c.can_appeal_until, c.is_appeal, c.appeal_status,
         c.priority, c.tags, c.snoozed_until,
         c.source, c.source_status, c.external_id, c.external_request_id,
         asg.name AS assignee_name, asg.email AS assignee_email,
         -- The export's keyset cursor, and only that: it is not shaped into a
         -- row and never reaches the CSV. timestamptz is stored to the
         -- microsecond and a JS Date holds milliseconds, so the key has to
         -- leave Postgres as text or a batch boundary rounds down and skips
         -- every row inside the millisecond it landed in.
         c.created_at::text AS created_at_iso,
         cf.value_json #>> '{}' AS country,
         COALESCE(app.names, '') AS approvers,
         COALESCE(app.emails, ARRAY[]::text[]) AS approver_emails
    FROM cases c
    LEFT JOIN users asg ON asg.id = c.assignee_id
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

  /**
   * The email HMAC for a search term, when the term is one whole address.
   *
   * Substring search over an encrypted column is not possible, and decrypting
   * every row to grep it would defeat the point of the encryption. Whole-value
   * HMAC equality is the same trade intake dedup already makes.
   */
  private withSearchHmac(q: CaseListQuery): CaseListQuery {
    const term = q.search?.trim();
    if (!term || !term.includes('@')) return { ...q, searchEmailHmac: undefined };
    return { ...q, searchEmailHmac: this.crypto.lookupHmac(term) };
  }

  /** Zone visibility comes from RLS via ctx — no zone filter in app code. */
  async list(ctx: ZoneContext, rawQ: CaseListQuery) {
    const q = this.withSearchHmac(rawQ);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    return this.db.withContext(ctx, async (_db, client) => {
      const { sql: filterSql, params } = listFilters(q);
      const rows = await client.query(
        `${LIST_SELECT} ${filterSql}
          ORDER BY ${orderBy(q)}
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
      ...this.shapeLifecycle(r),
    };
  }

  /**
   * The lifecycle facts the case record keeps beyond its status: when the
   * outcome report went out, whether the deadline was missed, and where the
   * case is in its appeal window. Shared by the list, the detail view and the
   * export so all three agree.
   */
  private shapeLifecycle(r: Record<string, unknown>) {
    return {
      formVersion: (r.form_version ?? null) as number | null,
      closedAt: (r.closed_at ?? null) as string | null,
      outcomeCode: (r.outcome_code ?? null) as string | null,
      residency: (r.residency ?? null) as string | null,
      skipCompletionNotification: Boolean(r.skip_completion_notification),
      completedAfterDeadline: (r.completed_after_deadline ?? null) as boolean | null,
      autoExtended: Boolean(r.auto_extended),
      reportPublishedAt: (r.report_published_at ?? null) as string | null,
      reportAccessedAt: (r.report_accessed_at ?? null) as string | null,
      canBeAppealed: Boolean(r.can_be_appealed),
      canAppealUntil: (r.can_appeal_until ?? null) as string | null,
      priority: (r.priority ?? 'normal') as string,
      tags: (r.tags ?? []) as string[],
      snoozedUntil: (r.snoozed_until ?? null) as string | null,
      isAppeal: Boolean(r.is_appeal),
      appealStatus: (r.appeal_status ?? null) as string | null,
      source: (r.source ?? 'portal') as string,
      sourceStatus: (r.source_status ?? null) as string | null,
      externalId: (r.external_id ?? null) as string | null,
      externalRequestId: (r.external_request_id ?? null) as string | null,
      assigneeName: (r.assignee_name ?? null) as string | null,
      assigneeEmail: (r.assignee_email ?? null) as string | null,
      requesterName: this.safeDecrypt(r.requester_name_enc as string | null),
      /** Where the case sits in the delivery lifecycle, as one label. */
      progress: progressOf(r),
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
  async *streamExportRows(ctx: ZoneContext, rawQ: CaseListQuery, batchSize = 1000) {
    const q = this.withSearchHmac(rawQ);
    // Interpolated into the SQL, so it is bounded and made whole here rather
    // than bound as a parameter: a parameterised LIMIT costs the planner the
    // row estimate that makes it walk the index instead of sorting the table.
    const size = Math.min(5_000, Math.max(1, Math.trunc(batchSize) || 1));
    let cursor: Cursor | null = null;
    for (;;) {
      const batch: Record<string, unknown>[] = await this.db.withContext(
        ctx,
        async (_db, client) => {
          const { sql: filterSql, params } = listFilters(q);
          const keyset = cursorClause(cursor, params.length + 1);
          const rows = await client.query(
            `${LIST_SELECT} ${filterSql}${keyset.sql}
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ${size}`,
            [...params, ...keyset.params],
          );
          return rows.rows as Record<string, unknown>[];
        },
        // An export legitimately outlives an interactive query, but it must
        // still lose the race with nginx's proxy_read_timeout of 60s: a batch
        // cancelled by Postgres reaches the abort path and marks the file,
        // where a connection cut by nginx just stops. Per batch, not a total.
        { statementTimeoutMs: 45_000 },
      );
      if (batch.length === 0) return;
      // The answers, fetched for this batch only. The export used to carry ten
      // columns of metadata for a record that holds forty, which is a case
      // list rather than a case export. Batched with the rows so memory stays
      // bounded by the batch, not by the size of the result.
      const fields = await this.fieldsForCases(
        ctx,
        batch.map((r) => r.id as string),
      );
      yield batch.map((r) => ({
        ...this.shapeListRow(r),
        fields: fields.get(r.id as string) ?? {},
      }));
      // From the text column, never from the shaped row: shapeListRow hands
      // back whatever pg parsed created_at into, which is a Date.
      cursor = nextCursor(
        batch.map((r) => ({ createdAt: r.created_at_iso as string, id: r.id as string })),
      );
      if (batch.length < size) return;
    }
  }

  /**
   * Every answer held against the given cases, decrypted.
   *
   * Exporting is already the disclosure and the controller audits it as one,
   * so the encrypted fields are resolved here rather than handed over as
   * ciphertext nobody can read.
   */
  private async fieldsForCases(
    ctx: ZoneContext,
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const byCase = new Map<string, Record<string, unknown>>();
    if (ids.length === 0) return byCase;
    const rows = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT case_id, field_key, value_json, value_enc, encrypted
           FROM case_fields WHERE case_id = ANY($1::uuid[])`,
        [ids],
      );
      return r.rows as {
        case_id: string; field_key: string;
        value_json: unknown; value_enc: string | null; encrypted: boolean;
      }[];
    });
    for (const f of rows) {
      const bag = byCase.get(f.case_id) ?? {};
      bag[f.field_key] = f.encrypted ? this.safeDecrypt(f.value_enc) : f.value_json;
      byCase.set(f.case_id, bag);
    }
    return byCase;
  }

  /**
   * Which answer columns the export needs, before a single row is streamed.
   *
   * The header has to be written first and cannot be revised afterwards, so
   * the set of field keys is established in one pass over the filtered cases
   * rather than accumulated as rows go by.
   */
  async exportFieldKeys(
    ctx: ZoneContext,
    rawQ: CaseListQuery,
  ): Promise<{ keys: string[]; formKeys: string[] }> {
    const q = this.withSearchHmac(rawQ);
    return this.db.withContext(ctx, async (_db, client) => {
      const { sql: filterSql, params } = listFilters(q);
      const keys = await client.query(
        `SELECT DISTINCT f.field_key
           FROM case_fields f
           JOIN cases c ON c.id = f.case_id
          WHERE true ${filterSql}
          ORDER BY f.field_key`,
        params,
      );
      // Which forms are in this export, so the headers are labelled by the
      // forms the answers actually came from.
      const forms = await client.query(
        `SELECT DISTINCT c.form_key FROM cases c WHERE true ${filterSql}`,
        params,
      );
      return {
        keys: keys.rows.map((x: { field_key: string }) => x.field_key),
        formKeys: forms.rows.map((x: { form_key: string }) => x.form_key),
      };
    });
  }

  /**
   * Human labels for form field keys, in form order, for the forms the given
   * cases were submitted under.
   *
   * Without this the export headers read `cpf_brazil` and
   * `does_your_request_involve_any_campaign_or_promotion`, which is a database
   * dump rather than the record the previous tool produced. Later versions of
   * a form win on ties, since that is the wording currently in use.
   */
  async fieldLabels(formKeys: string[]): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const wanted = [...new Set(formKeys.filter(Boolean))];
    if (wanted.length === 0) return labels;

    const schemas = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT DISTINCT ON (form_key) form_key, schema FROM form_versions
          WHERE form_key = ANY($1::text[]) ORDER BY form_key, version DESC`,
        [wanted],
      );
      return r.rows as { form_key: string; schema: { components?: Component[] } }[];
    });

    // Twelve forms label `requestDetails` twelve different ways. Taking the
    // first one seen would put another country's wording on this country's
    // column, so a key the exported forms disagree about falls back to the key
    // itself: unlovely, but unambiguous, which prose that is quietly wrong is
    // not.
    const seen = new Map<string, Set<string>>();
    for (const sc of schemas) {
      for (const [key, c] of collectInputs(sc.schema?.components ?? [])) {
        const label = c.label?.trim() || key;
        const bag = seen.get(key) ?? new Set<string>();
        bag.add(label);
        seen.set(key, bag);
        if (!labels.has(key)) labels.set(key, label);
      }
    }
    for (const [key, variants] of seen) {
      if (variants.size > 1) labels.set(key, key);
    }
    return labels;
  }

  /** Distinct request types across the caller's visible cases, for filters. */
  async requestTypes(ctx: ZoneContext): Promise<string[]> {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT DISTINCT rt.value AS t
           FROM cases c, jsonb_array_elements_text(c.request_types) rt(value)
          ORDER BY t`,
      );
      return r.rows.map((x: { t: string }) => x.t);
    });
  }

  async detail(ctx: ZoneContext, id: string, viewerId?: string) {
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
          // The stored name wins: it is the one that survives the account
          // being deleted, and it is what the row was written with.
          actorName: sql<string | null>`COALESCE(${caseStatusHistory.actorName}, ${users.name})`,
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
                a.actor_type,
                COALESCE(a.actor_name, u.name) AS actor_name,
                COALESCE(a.actor_email, u.email) AS actor_email,
                u.role AS actor_role
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

      // Who a reply should copy in by default, on the connection this method
      // is already holding.
      //
      // This used to open a second one under system(), on the reasoning that
      // RLS scopes `users` to the caller's zone. That is true and beside the
      // point: the zone asked about is row.zoneId, and the caller only reached
      // this line because cases_zone_isolation let them read that row -- so
      // app_zone_allows(row.zoneId) is already true for them, and
      // users_zone_role returns the same approvers either way.
      //
      // Dropping it also stops the hottest read path in the service checking
      // out two pooled connections at once to answer one case view.
      const approverRows = await client.query(
        `SELECT email FROM users
          WHERE active AND role = 'approver' AND zone_id = $1
          ORDER BY name`,
        [row.zoneId],
      );

      // Other cases from the same person, and the appeal pair if there is
      // one. The linkage existed only as prose in a timeline note ("Appealed —
      // see DSR-…"); these give the screen something to actually link, and the
      // requester match is what lets an operator spot a duplicate before
      // working — or deleting — the wrong one. Matched by HMAC because the
      // address itself is encrypted. RLS still applies: a related case in a
      // zone the caller cannot see simply does not come back.
      const related = await client.query(
        `SELECT id, case_ref, status, created_at, is_appeal, source
           FROM cases
          WHERE requester_email_hmac = $1 AND id <> $2
          ORDER BY created_at DESC
          LIMIT 10`,
        [row.requesterEmailHmac, id],
      );
      const appealLinks = await client.query(
        `SELECT id, case_ref, 'appeal_of' AS rel FROM cases WHERE id = $2
          UNION ALL
         SELECT id, case_ref, 'appealed_by' AS rel FROM cases WHERE appeal_of_case_id = $1`,
        [id, row.appealOfCaseId],
      );

      // The internal discussion. The stored author name wins over the live
      // one — it survives the account being deleted, same as status history.
      const comments = await client.query(
        `SELECT cm.id, cm.body, cm.created_at,
                COALESCE(cm.author_name, u.name) AS author_name,
                u.email AS author_email
           FROM case_comments cm
      LEFT JOIN users u ON u.id = cm.author_id
          WHERE cm.case_id = $1
          ORDER BY cm.created_at ASC`,
        [id],
      );

      const watcherRows = await client.query(
        `SELECT w.user_id, u.name FROM case_watchers w
           JOIN users u ON u.id = w.user_id
          WHERE w.case_id = $1
          ORDER BY u.name`,
        [id],
      );

      // What the case has been sent out to, and where that got to.
      const delegations = await client.query(
        `SELECT d.id, d.stage, d.note, d.created_at, d.accepted_at, d.closed_at,
                g.name AS group_name, COALESCE(d.accepted_by_name, m.name) AS accepted_by, u.name AS sent_by
           FROM case_delegations d
           JOIN case_groups g ON g.id = d.group_id
      LEFT JOIN case_group_members m ON m.id = d.accepted_by_member_id
      LEFT JOIN users u ON u.id = d.created_by
          WHERE d.case_id = $1
          ORDER BY d.created_at DESC`,
        [id],
      );

      return {
        ...row,
        approverEmails: approverRows.rows.map((r: { email: string }) => r.email),
        requesterEmailEnc: undefined,
        requesterEmailHmac: undefined,
        requesterNameEnc: undefined,
        requesterEmail: this.safeDecrypt(row.requesterEmailEnc),
        requesterName: row.requesterNameEnc ? this.safeDecrypt(row.requesterNameEnc) : null,
        // Same derivation as the list, from the snake_case shape it expects.
        progress: progressOf({
          status: row.status,
          appeal_status: row.appealStatus,
          report_published_at: row.reportPublishedAt,
          report_accessed_at: row.reportAccessedAt,
        }),
        fields: fields.map((f) => ({
          key: f.fieldKey,
          value: f.encrypted ? this.safeDecrypt(f.valueEnc ?? '') : f.valueJson,
          encrypted: f.encrypted,
        })),
        history,
        activity: activityRows.rows,
        slaClock: clock ?? null,
        emails,
        delegations: delegations.rows,
        relatedCases: related.rows,
        appealOf: appealLinks.rows.find((r: { rel: string }) => r.rel === 'appeal_of') ?? null,
        appeals: appealLinks.rows.filter((r: { rel: string }) => r.rel === 'appealed_by'),
        comments: comments.rows,
        watchers: watcherRows.rows.map((w: { user_id: string; name: string }) => ({
          userId: w.user_id,
          name: w.name,
        })),
        amWatching: viewerId
          ? watcherRows.rows.some((w: { user_id: string }) => w.user_id === viewerId)
          : false,
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
    // The caller's context, matching the `extra` read directly above: this
    // method already has one, and case_attachments is scoped by its parent
    // case's zone, which detail() has already resolved under that same ctx.
    const files = await this.db.withContext(ctx, async (_db, client) => {
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

/** A row as the export streams it: the case, plus the answers on it. */
export type CaseExportRow = CaseListRow & { fields: Record<string, unknown> };
