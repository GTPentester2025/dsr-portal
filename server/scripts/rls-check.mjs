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

// clean up seeded rows so other tests never collide with them
await admin.query(`DELETE FROM email_log; DELETE FROM case_fields; DELETE FROM sla_clocks; DELETE FROM case_status_history; DELETE FROM cases;`);

await app.end();
await admin.end();
process.exit(failures ? 1 : 0);
