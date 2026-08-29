// Does the case list actually use the index 0015 added?
//
// The spec argues that indexing the sort key alone is right, because RLS
// filters with app_zone_allows(zone_id) -- a function call the planner cannot
// turn into a range scan. That argument is reasoning, not evidence. This is
// the evidence, and it is only evidence if two things hold.
//
// 1. It has to connect as dsr_app. Every table is owned by dsr, and no
//    migration issues FORCE ROW LEVEL SECURITY, so a table owner bypasses
//    every policy: plans taken over DATABASE_URL -- the owner role throughout
//    this repo -- carry no app_zone_allows(zone_id) qualifier at all, and that
//    qualifier is the whole subject of the index argument. DbService connects
//    with DATABASE_URL_APP, so this does too.
// 2. It has to plan the query the application actually runs -- the approvers
//    CTE, the country LATERAL, the export's filters and keyset cursor. A bare
//    `SELECT id FROM cases ORDER BY created_at DESC` is a different query and
//    the planner owes it nothing.
//
//   DATABASE_URL_APP=... node server/scripts/explain-check.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL_APP ?? 'postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr';
const c = new pg.Client(url);
try {
  await c.connect();
} catch (e) {
  console.error(`No database reachable at ${url}: ${e.message}`);
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

/**
 * The plan Postgres chooses for `sql` under a given RLS context.
 *
 * Returns the root Plan node rather than a string. The checks below have to
 * ask where a Sort sits relative to the scan on `cases`, and substring
 * matching over the whole plan cannot tell a sort inside the approvers
 * aggregate from a sort of the case list itself.
 */
const plan = async (sql, { role = 'admin', zone = '*' } = {}) => {
  await c.query('BEGIN');
  try {
    await c.query(
      `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
      [role, zone],
    );
    const res = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    return res.rows[0]['QUERY PLAN'][0].Plan;
  } finally {
    await c.query('ROLLBACK');
  }
};

/** Every node in a plan tree, each carrying the nodes above it. */
function* nodes(node, ancestors = []) {
  yield { node, ancestors };
  for (const child of node.Plans ?? []) yield* nodes(child, [...ancestors, node]);
}

const scanOf = (root, relation) =>
  [...nodes(root)].find((n) => n.node['Relation Name'] === relation);

const describe = (hit) =>
  hit
    ? `${hit.node['Node Type']} on ${hit.node['Index Name'] ?? hit.node['Relation Name']}`
    : 'no scan found';

// Before anything else: a plan taken as a role that bypasses RLS is not a plan
// of this application's query. The owner bypass is silent -- no error, no
// warning, just a missing qualifier -- so it is asserted rather than assumed.
const who = await c.query(
  `SELECT current_user AS role,
          pg_get_userbyid(cl.relowner) = current_user AS owns_cases,
          (r.rolsuper OR r.rolbypassrls) AS bypasses
     FROM pg_class cl
     JOIN pg_roles r ON r.rolname = current_user
    WHERE cl.relname = 'cases' AND cl.relnamespace = 'public'::regnamespace`,
);
const w = who.rows[0];
check(
  `connected as a role row-level security applies to (${w ? w.role : 'unknown'})`,
  !!w && !w.owns_cases && !w.bypasses,
  'the table owner and any BYPASSRLS role skip every policy, so these plans would ' +
    'carry no app_zone_allows(zone_id) qualifier and would prove nothing — point ' +
    'DATABASE_URL_APP at dsr_app',
);

/**
 * The case-list query, verbatim from the LIST_SELECT constant in
 * server/src/cases/cases.service.ts, which is its source of truth.
 *
 * This file is .mjs and that one is TypeScript, so it cannot be imported and
 * this copy has to be kept in step by hand. If the list query changes there,
 * change it here or these checks quietly stop describing the application.
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
    LEFT JOIN LATERAL (
      SELECT value_json FROM case_fields
       WHERE case_id = c.id AND field_key = 'country' LIMIT 1
    ) cf ON true
    LEFT JOIN approvers app ON app.zone_id = c.zone_id
   WHERE true
`;

const LIST_TAIL = `ORDER BY c.created_at DESC, c.id DESC LIMIT 25`;
const EXPORT_TAIL = `ORDER BY c.created_at DESC, c.id DESC LIMIT 1000`;

// A representative listFilters() predicate. status and zone_id are the two
// filters with indexes of their own, so this is where cases_status_ix and
// cases_zone_ix compete with cases_created_ix for the same query -- and where
// losing costs the most: a plan that index-scans cases_status_ix and re-sorts
// pays that sort once per 1000-row batch, for every batch of the export.
const EXPORT_FILTER = `AND c.status = 'open' AND c.zone_id = 'EUR'`;

// The keyset cursor every batch after the first carries, shaped exactly as
// cursorClause() builds it in server/src/cases/keyset.ts.
const EXPORT_KEYSET = `AND (c.created_at, c.id) < ('2026-01-01T00:00:00Z'::timestamptz, gen_random_uuid())`;

/** The things the index argument claims, asserted against one plan. */
const checkListPlan = (label, root) => {
  const text = JSON.stringify(root);
  const hit = scanOf(root, 'cases');
  check(
    `${label}: the plan carries the RLS qualifier`,
    /app_zone_allows|app\.current_zone/.test(text),
    'no zone predicate in the plan — the policy was not applied to this query',
  );
  check(
    `${label}: reads cases through cases_created_ix`,
    !!hit &&
      String(hit.node['Node Type']).includes('Index') &&
      hit.node['Index Name'] === 'cases_created_ix',
    `scan was ${describe(hit)} — ${text.slice(0, 300)}`,
  );
  check(
    `${label}: does not fall back to a sequential scan of cases`,
    !!hit && hit.node['Node Type'] !== 'Seq Scan',
    `scan was ${describe(hit)}`,
  );
  // A Sort anywhere above the cases scan means the index did not supply the
  // ordering and the rows were collected and re-ordered instead. On the export
  // path that sort is paid once per batch rather than once per download.
  const sortedBy = hit
    ? hit.ancestors
        .filter((n) => String(n['Node Type']).includes('Sort'))
        .map((n) => n['Node Type'])
    : [];
  check(
    `${label}: the ordering comes from the index, not a sort`,
    !!hit && sortedBy.length === 0,
    hit ? `re-ordered by ${sortedBy.join(', ')}` : 'no scan on cases found',
  );
};

// 1. The list as an administrator sees it: no filters, one page.
const listPlan = await plan(`${LIST_SELECT} ${LIST_TAIL}`);
checkListPlan('list, unfiltered', listPlan);

// The country LATERAL, checked inside the real query rather than on its own:
// standing alone it is an uncorrelated lookup, and correlated is how it runs.
const fieldHit = scanOf(listPlan, 'case_fields');
check(
  'list, unfiltered: the country LATERAL uses the composite index',
  !!fieldHit && fieldHit.node['Index Name'] === 'case_fields_case_key_ix',
  `lookup was ${describe(fieldHit)}`,
);

// 2. Zone-pinned. This is the case the whole index argument turns on: with a
// zone that is not '*' the RLS qualifier actually discards rows, so the
// planner is genuinely choosing between walking the sort key and filtering, or
// using a zone index and re-sorting. The '*' plan above never puts it to that
// choice, which is why it was the only plan taken here and proved least.
checkListPlan(
  'list, zone-pinned EUR',
  await plan(`${LIST_SELECT} ${LIST_TAIL}`, { role: 'zone_manager', zone: 'EUR' }),
);

// 3. The export path: filters and a keyset cursor, at export batch size.
checkListPlan(
  'export, filtered and continued from a cursor',
  await plan(`${LIST_SELECT} ${EXPORT_FILTER} ${EXPORT_KEYSET} ${EXPORT_TAIL}`),
);
checkListPlan(
  'export, filtered and continued from a cursor, zone-pinned EUR',
  await plan(`${LIST_SELECT} ${EXPORT_FILTER} ${EXPORT_KEYSET} ${EXPORT_TAIL}`, {
    role: 'zone_manager',
    zone: 'EUR',
  }),
);

const auditPlan = JSON.stringify(
  await plan(
    `SELECT a.id FROM audit_log a
       WHERE (a.created_at, a.id) < (now()::timestamptz, 0::bigint)
       ORDER BY a.created_at DESC, a.id DESC LIMIT 1000`,
  ),
);
check(
  'audit log export keyset uses its own composite index',
  auditPlan.includes('audit_log_created_id_ix'),
  `plan was ${auditPlan.slice(0, 300)}`,
);

const duePlan = JSON.stringify(
  await plan(`SELECT c.id FROM cases c WHERE c.status <> 'closed' AND c.due_at < now()`),
);
check(
  'open-and-overdue uses the partial index',
  duePlan.includes('cases_due_open_ix'),
  `plan was ${duePlan.slice(0, 300)}`,
);

await c.end();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll plans use their index.');
process.exit(failures ? 1 : 0);
