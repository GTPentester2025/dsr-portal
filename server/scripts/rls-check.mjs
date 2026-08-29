// Cross-zone IDOR guard check (spec §9): connect as dsr_app and prove a
// MAZ-scoped context cannot read or update EUR rows.
import pg from 'pg';

const admin = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await admin.connect();

// seed two cases directly as the owner role (bypasses RLS by design)
await admin.query(`DELETE FROM email_log; DELETE FROM case_fields; DELETE FROM sla_clocks; DELETE FROM case_status_history; DELETE FROM cases;`);
await admin.query(`
  INSERT INTO cases (case_ref, zone_id, form_key, form_version, requester_email_enc, requester_email_hmac, status)
  VALUES ('DSR-EUR-2026-00001','EUR','eur-1',27,'enc','h1','new'),
         ('DSR-MAZ-2026-00001','MAZ','maz-mexico',23,'enc','h2','new')
`);

// seed users for the --roles matrix: one zone-scoped, one global (zone_id
// IS NULL) -- both inserted as the owner role, which bypasses RLS.
await admin.query(`
  INSERT INTO users (email, name, role, zone_id)
  VALUES ('rls-probe@example.com','RLS Probe','approver','EUR')
  ON CONFLICT (email) DO UPDATE SET role = 'approver', zone_id = 'EUR'
`);
await admin.query(`
  INSERT INTO users (email, name, role, zone_id)
  VALUES ('rls-probe-global@example.com','RLS Probe Global','admin',NULL)
  ON CONFLICT (email) DO UPDATE SET role = 'admin', zone_id = NULL
`);

const app = new pg.Client(process.env.DATABASE_URL_APP ?? 'postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr');
await app.connect();

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failures++;
};

async function inZone(zone, role, fn) {
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`, [role, zone]);
  const r = await fn();
  await app.query('COMMIT');
  return r;
}

// MAZ agent sees only MAZ
let rows = (await inZone('MAZ', 'approver', () => app.query('SELECT case_ref FROM cases ORDER BY case_ref'))).rows;
check('MAZ agent sees exactly 1 case', rows.length === 1 && rows[0].case_ref === 'DSR-MAZ-2026-00001');

// MAZ agent cannot fetch EUR row by id (sequential-ID attack)
rows = (await inZone('MAZ', 'approver', () => app.query(`SELECT * FROM cases WHERE case_ref='DSR-EUR-2026-00001'`))).rows;
check('MAZ agent cannot fetch EUR case by ref', rows.length === 0);

// MAZ agent cannot update EUR row
const upd = await inZone('MAZ', 'approver', () => app.query(`UPDATE cases SET status='open' WHERE case_ref='DSR-EUR-2026-00001'`));
check('MAZ agent update on EUR case affects 0 rows', upd.rowCount === 0);

// MAZ agent cannot insert a case into EUR
let insertBlocked = false;
try {
  await inZone('MAZ', 'approver', () => app.query(`
    INSERT INTO cases (case_ref, zone_id, form_key, form_version, requester_email_enc, requester_email_hmac, status)
    VALUES ('DSR-EUR-2026-09999','EUR','eur-1',27,'enc','h3','new')`));
} catch { insertBlocked = true; await app.query('ROLLBACK'); }
check('MAZ agent cannot insert into EUR', insertBlocked);

// admin '*' sees both
rows = (await inZone('*', 'admin', () => app.query('SELECT case_ref FROM cases'))).rows;
check('admin sees both cases', rows.length === 2);

// no zone context set at all => sees nothing (fail closed)
rows = (await app.query('SELECT case_ref FROM cases')).rows;
check('no zone context => zero rows (fail closed)', rows.length === 0);

// audit log append-only
await admin.query(`INSERT INTO audit_log (action, entity_type) VALUES ('test','x')`);
let blocked = false;
try { await admin.query(`DELETE FROM audit_log`); } catch { blocked = true; }
check('audit_log DELETE blocked even for owner', blocked);

// --roles: prove the write matrix from 0013_role-matrix.sql. Zone isolation is
// covered above; this asserts who may write, per role, per table.
if (process.argv.includes('--roles')) {
  // Three outcomes, never two. "No exception thrown" is not evidence that a
  // write was permitted: an UPDATE whose WHERE matches nothing succeeds
  // without WITH CHECK ever being evaluated, so a missing seed, a wrong zone
  // term or a read that RLS blocked outright would turn every positive
  // assertion below green while proving nothing at all. An RLS refusal on
  // INSERT/UPDATE raises (42501), a zero-row match does not, so the two stay
  // distinguishable: 'refused' was thrown, 'nothing' matched no row, and only
  // 'wrote' means the policy ran against a real row and allowed it. This is
  // the same discipline tryDelete below already applies by counting rowCount.
  const attemptWrite = async (role, zone, sql) => {
    try {
      await app.query('BEGIN');
      await app.query(
        `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
        [role, zone],
      );
      const r = await app.query(sql);
      await app.query('ROLLBACK');
      return r.rowCount ? 'wrote' : 'nothing';
    } catch {
      await app.query('ROLLBACK');
      return 'refused';
    }
  };

  // For the WITH CHECK assertions, 'nothing' is neither answer -- it means the
  // probe never reached the policy. Both helpers count it as a failure and say
  // so, because a silent zero-row match is the failure mode being fixed here.
  const decide = async (role, zone, sql, want) => {
    const outcome = await attemptWrite(role, zone, sql);
    if (outcome === 'nothing') {
      console.log(`     (${role} @ ${zone}) matched no rows: ${sql.trim().split('\n')[0]}`);
    }
    return outcome === want;
  };

  /** Permitted: the policy was evaluated against a real row and allowed it. */
  const mayWrite = (role, zone, sql) => decide(role, zone, sql, 'wrote');

  /** Refused: the policy raised on a real row. */
  const mayNotWrite = (role, zone, sql) => decide(role, zone, sql, 'refused');

  // DELETE is governed by a RESTRICTIVE USING-only policy (0013): a role that
  // fails it does not raise, it just leaves the row unmatched, so rowCount
  // (not a thrown error) is what distinguishes "blocked" from "allowed".
  const tryDelete = async (role, zone, sql) => {
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
      [role, zone],
    );
    let deleted = 0;
    try {
      const r = await app.query(sql);
      deleted = r.rowCount;
    } catch {
      deleted = 0;
    } finally {
      await app.query('ROLLBACK');
    }
    return deleted > 0;
  };

  const CASE_WRITE = `UPDATE cases SET status = 'open' WHERE zone_id = 'EUR'`;
  const USER_WRITE = `UPDATE users SET capacity_weight = capacity_weight WHERE zone_id = 'EUR'`;
  const SETTING_WRITE = `INSERT INTO app_settings (key, value) VALUES ('rls_probe','x')
                         ON CONFLICT (key) DO UPDATE SET value = 'x'`;
  const CASE_DELETE = `DELETE FROM cases WHERE zone_id = 'EUR'`;
  const GLOBAL_USER_DELETE = `DELETE FROM users WHERE email = 'rls-probe-global@example.com'`;
  const GLOBAL_USER_WRITE = `UPDATE users SET zone_id = 'EUR' WHERE email = 'rls-probe-global@example.com'`;

  for (const role of ['super_admin', 'admin', 'zone_manager', 'approver']) {
    check(`${role} may write a case`, await mayWrite(role, 'EUR', CASE_WRITE));
  }
  check('auditor may not write a case', await mayNotWrite('auditor', '*', CASE_WRITE));

  for (const role of ['super_admin', 'admin', 'zone_manager']) {
    check(`${role} may write a user`, await mayWrite(role, role === 'zone_manager' ? 'EUR' : '*', USER_WRITE));
  }
  check('approver may not write a user', await mayNotWrite('approver', 'EUR', USER_WRITE));
  check('auditor may not write a user', await mayNotWrite('auditor', '*', USER_WRITE));

  check('super_admin may write a setting', await mayWrite('super_admin', '*', SETTING_WRITE));
  check('admin may not write a setting', await mayNotWrite('admin', '*', SETTING_WRITE));
  check('zone_manager may not write a setting', await mayNotWrite('zone_manager', 'EUR', SETTING_WRITE));

  // users_update_zone (0013): a global account must not be selectable for
  // UPDATE from inside a zone. That policy is RESTRICTIVE and blocks through
  // USING, so like DELETE it leaves the row unmatched instead of raising --
  // 'nothing' is the pass here and only 'wrote' is the failure.
  check(
    'zone_manager may not pull a global user (zone_id IS NULL) into their zone',
    (await attemptWrite('zone_manager', 'EUR', GLOBAL_USER_WRITE)) !== 'wrote',
  );
  check(
    'admin may rezone a global user (zone_id IS NULL)',
    (await attemptWrite('admin', '*', GLOBAL_USER_WRITE)) === 'wrote',
  );

  // DELETE coverage (spec: 0013's users_delete_role hole, closed in Task 7).
  check('auditor may not delete a case', !(await tryDelete('auditor', '*', CASE_DELETE)));
  check(
    'zone_manager may not delete a global user (zone_id IS NULL)',
    !(await tryDelete('zone_manager', 'EUR', GLOBAL_USER_DELETE)),
  );
  check(
    'admin may delete a global user (zone_id IS NULL)',
    await tryDelete('admin', '*', GLOBAL_USER_DELETE),
  );
}

// Clean up everything this script seeded, so other tests never collide with
// it -- the probe users as much as the cases. rls-probe-global@example.com is
// an admin-role account with zone_id IS NULL, which is precisely the row shape
// 0013 exists to protect; it has no password so it cannot sign in, but leaving
// one lying around in every database this script has ever run against is not
// something to do by omission.
await admin.query(`DELETE FROM email_log; DELETE FROM case_fields; DELETE FROM sla_clocks; DELETE FROM case_status_history; DELETE FROM cases;`);
await admin.query(
  `DELETE FROM users WHERE email IN ('rls-probe@example.com','rls-probe-global@example.com')`,
);

await app.end();
await admin.end();
process.exit(failures ? 1 : 0);
