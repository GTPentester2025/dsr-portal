// Auth + RBAC + cross-zone IDOR e2e (spec §9). Requires running server and
// test users from create-user.mjs, plus at least one EUR case (e2e-intake).
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';

// Accounts under test. The defaults are the seeded dev users; override them to
// run this suite against a deployed environment, where those users do not exist.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'AdminPassw0rd12345';
const EUR_AGENT_EMAIL = process.env.E2E_EUR_AGENT_EMAIL ?? 'eur.agent@example.com';
const MAZ_AGENT_EMAIL = process.env.E2E_MAZ_AGENT_EMAIL ?? 'maz.agent@example.com';
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD ?? 'AgentPassw0rd12345';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
};

async function login(email, password) {
  const res = await fetch(`${BASE}/internal/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: res.status, cookie, data: await res.json().catch(() => null) };
}
const get = async (path, cookie) => {
  const res = await fetch(BASE + path, { headers: { cookie } });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// unauthenticated blocked
let r = await get('/internal/cases', '');
check('unauthenticated cases list 401', r.status === 401);

// wrong password rejected + is uniform
const bad = await login(ADMIN_EMAIL, 'WrongPassword123');
check('bad password 401', bad.status === 401);
const ghost = await login('ghost@example.com', 'WrongPassword123');
check('unknown user 401 (same shape)', ghost.status === 401 && JSON.stringify(ghost.data?.message) === JSON.stringify(bad.data?.message));

// admin login + me
const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
check('admin login ok', admin.status === 200 && admin.cookie.startsWith('dsr_int='));
r = await get('/internal/auth/me', admin.cookie);
check('me returns an administrative role', ['admin', 'super_admin'].includes(r.data?.role), r.data?.role);

// admin sees the EUR case from intake e2e
r = await get('/internal/cases', admin.cookie);
check('admin sees >=1 case', r.status === 200 && r.data.total >= 1, JSON.stringify(r.data));
const eurCase = r.data.items.find((c) => c.zoneId === 'EUR');
check('admin sees EUR case with decrypted email', /^requester(\+\d+)?@example\.com$/.test(eurCase?.requesterEmail ?? ''));

// admin detail works + has fields/history/clock
r = await get(`/internal/cases/${eurCase.id}`, admin.cookie);
check('admin case detail 200', r.status === 200);
check('detail decrypts encrypted field values', r.data.fields.some((f) => f.key === 'email' && /^requester(\+\d+)?@example\.com$/.test(String(f.value)) && f.encrypted));
check('detail includes history + sla clock', r.data.history.length >= 1 && r.data.slaClock?.state === 'running');

// MAZ agent: list excludes EUR, detail on EUR case 404s (IDOR guard)
const maz = await login(MAZ_AGENT_EMAIL, AGENT_PASSWORD);
check('maz agent login ok', maz.status === 200);
r = await get('/internal/cases', maz.cookie);
check('maz agent sees zero EUR cases', r.status === 200 && r.data.items.every((c) => c.zoneId === 'MAZ'));
r = await get(`/internal/cases/${eurCase.id}`, maz.cookie);
check('maz agent EUR case by id -> 404', r.status === 404);

// EUR agent CAN see it
const eur = await login(EUR_AGENT_EMAIL, AGENT_PASSWORD);
r = await get(`/internal/cases/${eurCase.id}`, eur.cookie);
check('eur agent same case -> 200', r.status === 200);

// settings are super-admin only, and the ladder is enforced over HTTP
r = await get('/internal/admin/settings', admin.cookie);
check('super admin reaches settings', r.status === 200, `status ${r.status}`);
r = await get('/internal/admin/settings', eur.cookie);
check('zone agent cannot reach settings', r.status === 403, `status ${r.status}`);
r = await get('/internal/forms', maz.cookie);
check('zone agent cannot reach the form builder', r.status === 403, `status ${r.status}`);

// logout revokes session
await fetch(`${BASE}/internal/auth/logout`, { method: 'POST', headers: { cookie: admin.cookie } });
r = await get('/internal/cases', admin.cookie);
check('revoked session 401', r.status === 401);

process.exit(failures ? 1 : 0);
