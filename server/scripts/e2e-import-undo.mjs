// Import undo e2e: two uploads, the second correcting the first, then undoing
// each and checking exactly what went and what stayed.
//
// Requires: running server on BASE, migrated schema, imported forms, and the
// three accounts from create-user.mjs.
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr';
const PASS = 'Sup3rSecretPass99';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uploadRoot = join(root, '.uploads');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  <-- ' + extra}`);
  if (!cond) failures++;
};

async function login(email) {
  const res = await fetch(`${BASE}/internal/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
const api = async (method, path, cookie, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
async function upload(cookie, filename, csv, zoneId) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), filename);
  form.append('zoneId', zoneId);
  const res = await fetch(`${BASE}/internal/migration/analyse`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const HEAD = 'Request Id,Requester Email,Requester Name,Request Type,Status,Created Date';
const row = (id, email, name, status) =>
  `${id},${email},${name},Access,${status},01-02-2026`;

const client = new pg.Client(DB);
await client.connect();
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

const admin = await login('admin@example.com');
const approver = await login('approver@example.com');
check('logged in', !!admin && !!approver);

// ---------------------------------------------------------------- upload one
const csv1 = [HEAD, row('EXT-A', 'a@example.com', 'Ada', 'Open'), row('EXT-B', 'b@example.com', 'Bo', 'Open')].join('\n');
const a1 = await upload(admin, 'first-export.csv', csv1, 'SAZ');
check('first file analysed', a1.status === 201 || a1.status === 200, JSON.stringify(a1.data).slice(0, 200));
const import1 = a1.data.id;
const c1 = await api('POST', `/internal/migration/imports/${import1}/commit`, admin, {});
check('first file committed 2 cases', c1.data?.imported === 2, JSON.stringify(c1.data));

const stamped = await q("SELECT case_ref FROM cases WHERE import_id = $1 ORDER BY case_ref", [import1]);
check('both cases carry the import id', stamped.length === 2, JSON.stringify(stamped));
const firstRefs = stamped.map((r) => r.case_ref);

// ---------------------------------------------------------------- upload two
// Same two source ids plus a new one: two updates, one creation.
const csv2 = [
  HEAD,
  row('EXT-A', 'a@example.com', 'Ada', 'Closed'),
  row('EXT-B', 'b@example.com', 'Bo', 'Closed'),
  row('EXT-C', 'c@example.com', 'Cy', 'Open'),
].join('\n');
const a2 = await upload(admin, 'second-export.csv', csv2, 'SAZ');
const import2 = a2.data.id;
const c2 = await api('POST', `/internal/migration/imports/${import2}/commit`, admin, {});
check('second file created one case', c2.data?.imported === 1, JSON.stringify(c2.data));
check('second file updated the other two', c2.data?.updated === 2, JSON.stringify(c2.data));

const owned2 = await q('SELECT case_ref FROM cases WHERE import_id = $1', [import2]);
check('the updated cases still belong to the first import', owned2.length === 1, JSON.stringify(owned2));

// -------------------------------------------------------------- an attachment
// Imported cases do not normally carry files, but the undo path deletes them,
// so give it one to delete.
const [{ id: caseC }] = await q("SELECT id FROM cases WHERE external_id = 'EXT-C'");
const storageKey = 'SAZ/undo-probe/probe.pdf';
const diskPath = join(uploadRoot, 'SAZ', 'undo-probe', 'probe.pdf');
mkdirSync(dirname(diskPath), { recursive: true });
writeFileSync(diskPath, '%PDF-1.4 probe');
await q(
  `INSERT INTO case_attachments
     (case_id, filename, mime_type, size_bytes, storage_key, sha256, zone_id, case_ref, source)
   SELECT id,'probe.pdf','application/pdf',14,$2,'deadbeef',zone_id,case_ref,'staff'
     FROM cases WHERE id = $1`,
  [caseC, storageKey],
);
check('the file is on disk', existsSync(diskPath), diskPath);

const auditBefore = (await q("SELECT count(*)::int n FROM audit_log"))[0].n;

// ------------------------------------------------------------------ refusals
const r1 = await api('POST', `/internal/migration/imports/${import2}/undo`, approver, { reason: 'wrong file uploaded entirely' });
check('an approver cannot undo an import', r1.status === 403, `${r1.status}`);
const r2 = await api('POST', `/internal/migration/imports/${import2}/undo`, admin, { reason: '' });
check('a blank reason is refused', r2.status === 400, `${r2.status}`);
const r3 = await api('POST', `/internal/migration/imports/${import2}/undo`, admin, { reason: 'oops' });
check('a perfunctory reason is refused', r3.status === 400, `${r3.status}`);

// An import committed before provenance existed cannot be undone, and must say
// so rather than reporting a successful no-op.
const [{ id: legacy }] = await q(
  `INSERT INTO case_imports (filename, zone_id, form_key, form_version, status, imported, undoable)
   VALUES ('legacy.csv','SAZ','saz-import',1,'committed',400,false) RETURNING id`,
);
const r4 = await api('POST', `/internal/migration/imports/${legacy}/undo`, admin, { reason: 'testing the legacy refusal' });
check('an untracked import is refused', r4.status === 400, `${r4.status}`);
check('and the refusal explains why', /cannot be identified/.test(r4.data?.message ?? ''), r4.data?.message);

const still = await q('SELECT count(*)::int n FROM cases');
check('nothing was deleted by those', still[0].n === 3, JSON.stringify(still));

// ---------------------------------------------------------------- undo two
const u2 = await api('POST', `/internal/migration/imports/${import2}/undo`, admin, {
  reason: 'Uploaded against the wrong zone, re-importing into MAZ instead.',
});
check('the second import can be undone', u2.status === 201 || u2.status === 200, JSON.stringify(u2.data));
console.log('   ', JSON.stringify(u2.data));
check('it deleted exactly the case it created', u2.data?.casesDeleted === 1, JSON.stringify(u2.data));
check('it reported the two it could not revert', u2.data?.updatedNotReverted === 2, JSON.stringify(u2.data));
check('it removed the stored file', u2.data?.filesRemoved === 1, JSON.stringify(u2.data));
check('and left none behind', u2.data?.filesFailed === 0, JSON.stringify(u2.data));
check('the file is gone from disk', !existsSync(diskPath), diskPath);

const survivors = await q('SELECT case_ref FROM cases ORDER BY case_ref');
check('the first import cases survive', survivors.length === 2 && survivors.every((s) => firstRefs.includes(s.case_ref)), JSON.stringify(survivors));
const closed = await q("SELECT count(*)::int n FROM cases WHERE status = 'closed'");
check('and keep the values the second upload wrote', closed[0].n === 2, JSON.stringify(closed));
const gone = await q("SELECT count(*)::int n FROM cases WHERE external_id = 'EXT-C'");
check('the created case is gone', gone[0].n === 0);
const orphanFields = await q('SELECT count(*)::int n FROM case_fields WHERE case_id = $1', [caseC]);
const orphanHist = await q('SELECT count(*)::int n FROM case_status_history WHERE case_id = $1', [caseC]);
const orphanAtt = await q('SELECT count(*)::int n FROM case_attachments WHERE case_id = $1', [caseC]);
const orphanSla = await q('SELECT count(*)::int n FROM sla_clocks WHERE case_id = $1', [caseC]);
check('its fields are gone', orphanFields[0].n === 0);
check('its timeline is gone', orphanHist[0].n === 0);
check('its attachment row is gone', orphanAtt[0].n === 0);
check('its SLA clock is gone', orphanSla[0].n === 0);

const [imp2] = await q('SELECT status, undone_at, undone_by_name FROM case_imports WHERE id = $1', [import2]);
check('the import is marked undone', imp2.status === 'undone', JSON.stringify(imp2));
check('it records who did it', imp2.undone_by_name === 'Test Admin', JSON.stringify(imp2));

const again = await api('POST', `/internal/migration/imports/${import2}/undo`, admin, { reason: 'trying to undo it a second time' });
check('it cannot be undone twice', again.status === 400, `${again.status}`);

// ------------------------------------------------------------------- audit
const auditAfter = (await q('SELECT count(*)::int n FROM audit_log'))[0].n;
check('earlier audit entries survive', auditAfter > auditBefore, `${auditBefore} -> ${auditAfter}`);
const [entry] = await q(
  "SELECT actor_name, after::text AS after FROM audit_log WHERE action = 'import.undone' ORDER BY created_at DESC LIMIT 1",
);
check('the undo is audited', !!entry);
check('it names who did it', entry?.actor_name === 'Test Admin', entry?.actor_name);
const after = JSON.parse(entry.after);
check('it records the reason', /wrong zone/.test(after.reason ?? ''), after.reason);
check('it lists every case reference removed', Array.isArray(after.caseRefs) && after.caseRefs.length === 1, JSON.stringify(after.caseRefs));
check('it records what it could not revert', after.updatedNotReverted === 2, String(after.updatedNotReverted));
check('it does NOT record requester identifiers', !/c@example\.com/.test(entry.after), entry.after.slice(0, 300));
// Scoped to this run's two imports: the database may carry entries from
// earlier runs, and a bare count would pass or fail for the wrong reason.
const commits = await q(
  "SELECT count(*)::int n FROM audit_log WHERE action = 'import.committed' AND entity_id = ANY($1::text[])",
  [[import1, import2]],
);
check('both commit entries are still there', commits[0].n === 2, JSON.stringify(commits));

// ---------------------------------------------------------------- undo one
const u1 = await api('POST', `/internal/migration/imports/${import1}/undo`, admin, {
  reason: 'Removing the whole trial import now the second one is gone.',
});
check('the first import can be undone too', u1.data?.casesDeleted === 2, JSON.stringify(u1.data));
const left = await q('SELECT count(*)::int n FROM cases');
check('no cases remain', left[0].n === 0, JSON.stringify(left));

// ------------------------------------------------------------------- cleanup
await q("DELETE FROM case_imports WHERE id = $1", [legacy]);
rmSync(join(uploadRoot, 'SAZ', 'undo-probe'), { recursive: true, force: true });
await client.end();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILURE(S)`);
