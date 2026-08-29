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
  ON CONFLICT (email) DO NOTHING
`);
await admin.query(`
  INSERT INTO users (email, name, role, zone_id)
  VALUES ('rls-probe-global@example.com','RLS Probe Global','admin',NULL)
  ON CONFLICT (email) DO NOTHING
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
  const tryWrite = async (role, zone, sql) => {
    try {
      await app.query('BEGIN');
      await app.query(
        `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
        [role, zone],
      );
      await app.query(sql);
      await app.query('ROLLBACK');
      return true;
    } catch {
      await app.query('ROLLBACK');
      return false;
    }
  };

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

  const CASE_WRITE = `UPDATE cases SET status = 'in_progress' WHERE zone_id = 'EUR'`;
  const USER_WRITE = `UPDATE users SET capacity_weight = capacity_weight WHERE zone_id = 'EUR'`;
  const SETTING_WRITE = `INSERT INTO app_settings (key, value) VALUES ('rls_probe','x')
                         ON CONFLICT (key) DO UPDATE SET value = 'x'`;
  const CASE_DELETE = `DELETE FROM cases WHERE zone_id = 'EUR'`;
  const GLOBAL_USER_DELETE = `DELETE FROM users WHERE email = 'rls-probe-global@example.com'`;

  for (const role of ['super_admin', 'admin', 'zone_manager', 'approver']) {
    check(`${role} may write a case`, await tryWrite(role, 'EUR', CASE_WRITE));
  }
  check('auditor may not write a case', !(await tryWrite('auditor', '*', CASE_WRITE)));

  for (const role of ['super_admin', 'admin', 'zone_manager']) {
    check(`${role} may write a user`, await tryWrite(role, role === 'zone_manager' ? 'EUR' : '*', USER_WRITE));
  }
  check('approver may not write a user', !(await tryWrite('approver', 'EUR', USER_WRITE)));
  check('auditor may not write a user', !(await tryWrite('auditor', '*', USER_WRITE)));

  check('super_admin may write a setting', await tryWrite('super_admin', '*', SETTING_WRITE));
  check('admin may not write a setting', !(await tryWrite('admin', '*', SETTING_WRITE)));
  check('zone_manager may not write a setting', !(await tryWrite('zone_manager', 'EUR', SETTING_WRITE)));

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

// clean up seeded rows so other tests never collide with them
await admin.query(`DELETE FROM email_log; DELETE FROM case_fields; DELETE FROM sla_clocks; DELETE FROM case_status_history; DELETE FROM cases;`);

await app.end();
await admin.end();
process.exit(failures ? 1 : 0);
