// Does the case list actually use the index 0015 added?
//
// The spec argues that indexing created_at alone is right, because RLS filters
// with app_zone_allows(zone_id) -- a function call the planner cannot turn into
// a range scan. That argument is reasoning, not evidence. This is the evidence.
//
//   node server/scripts/explain-check.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr';
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

const plan = async (sql) => {
  await c.query('BEGIN');
  await c.query(
    `SELECT set_config('app.current_role','admin',true), set_config('app.current_zone','*',true)`,
  );
  const res = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`);
  await c.query('ROLLBACK');
  return JSON.stringify(res.rows[0]['QUERY PLAN']);
};

const listPlan = await plan(
  `SELECT c.id FROM cases c ORDER BY c.created_at DESC, c.id DESC LIMIT 25`,
);
check(
  'case list uses an index scan on created_at',
  listPlan.includes('cases_created_ix'),
  `plan was ${listPlan.slice(0, 300)}`,
);
check('case list does not fall back to a sequential scan', !listPlan.includes('"Seq Scan"'));

const fieldPlan = await plan(
  `SELECT value_json FROM case_fields WHERE case_id = gen_random_uuid() AND field_key = 'country' LIMIT 1`,
);
check('country lookup uses the composite index', fieldPlan.includes('case_fields_case_key_ix'));

const duePlan = await plan(
  `SELECT c.id FROM cases c WHERE c.status <> 'closed' AND c.due_at < now()`,
);
check('open-and-overdue uses the partial index', duePlan.includes('cases_due_open_ix'));

await c.end();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll plans use their index.');
process.exit(failures ? 1 : 0);
