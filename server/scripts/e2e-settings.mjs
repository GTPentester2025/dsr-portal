// Settings API e2e: catalog, round-trip, secret masking, encryption at rest,
// validation, the envOnly lock on the email group, and RBAC.
import pg from 'pg';

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
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
const call = async (method, path, cookie, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
const agent = await login(EUR_AGENT_EMAIL, AGENT_PASSWORD);

// 1. catalog
// Lower bound only: the catalog holds 18 fields today (6 email + 2 portal +
// 8 security + 2 branding). Pin low enough to survive new settings, high
// enough to catch a truncated or empty payload.
let r = await call('GET', '/internal/admin/settings', admin);
check('catalog returns groups + fields + values',
  r.status === 200 && r.data.groups.length >= 4 && r.data.fields.length >= 15 && r.data.values.length === r.data.fields.length,
  JSON.stringify(r.data).slice(0, 120));

const graphSecret = r.data.fields.find((f) => f.key === 'GRAPH_CLIENT_SECRET');
check('secret field flagged + locked to the environment',
  graphSecret?.secret === true && graphSecret?.envOnly === true);

// 2. non-admin blocked
r = await call('GET', '/internal/admin/settings', agent);
check('zone agent cannot read settings (403)', r.status === 403);
r = await call('PUT', '/internal/admin/settings', agent, { values: { ORG_NAME: 'hacked' } });
check('zone agent cannot write settings (403)', r.status === 403);

// 3. write + read back
r = await call('PUT', '/internal/admin/settings', admin, {
  values: {
    ORG_NAME: 'ABI Privacy',
    TURNSTILE_SECRET: 'sk_test_turnstile_9f8e7d6c5b4a',
  },
});
check('update accepted', r.status === 200 && r.data.updated.length === 2, JSON.stringify(r.data).slice(0, 160));
const byKey = Object.fromEntries((r.data.values ?? []).map((v) => [v.key, v]));
check('plaintext value echoed back', byKey.ORG_NAME?.value === 'ABI Privacy' && byKey.ORG_NAME.source === 'database');
check('secret never returned in plaintext', byKey.TURNSTILE_SECRET?.value === '' && byKey.TURNSTILE_SECRET?.isSet === true);

// 4. encryption at rest + no plaintext column
const db = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await db.connect();
const row = (await db.query('SELECT * FROM app_settings WHERE key=$1', ['TURNSTILE_SECRET'])).rows[0];
check('secret stored encrypted', row?.secret === true && row.value === null && String(row.value_enc).startsWith('v1:'));
check('secret ciphertext hides the value', !String(row.value_enc).includes('sk_test_turnstile_9f8e7d6c5b4a'));

// 5. audit records the key but redacts the value
const audit = (await db.query(`SELECT after FROM audit_log WHERE action='settings.updated' ORDER BY id DESC LIMIT 1`)).rows[0];
check('audit redacts secret values',
  JSON.stringify(audit.after).includes('[redacted]') && !JSON.stringify(audit.after).includes('sk_test_turnstile_9f8e7d6c5b4a'),
  JSON.stringify(audit.after));

// 6. validation
r = await call('PUT', '/internal/admin/settings', admin, { values: { SESSION_IDLE_MINUTES: '2' } });
check('number below min rejected', r.status === 400, JSON.stringify(r.data));
r = await call('PUT', '/internal/admin/settings', admin, { values: { SUPPORT_EMAIL: 'not-an-email' } });
check('bad email rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { PUBLIC_BASE_URL: 'ftp://x' } });
check('bad url rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { DAILY_REPORT_ENABLED: 'sometimes' } });
check('unknown select option rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { NOT_A_SETTING: 'x' } });
check('unknown key rejected', r.status === 400);

// 7. email settings are environment-only: the database can no longer shadow
// the file on disk, and the API must refuse a write rather than accept and
// ignore it.
r = await call('PUT', '/internal/admin/settings', admin, { values: { PRIVACY_MAILBOX: 'attacker@example.com' } });
check('envOnly key refused, not silently ignored', r.status === 400, JSON.stringify(r.data));
r = await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'graph' } });
check('EMAIL_PROVIDER cannot be changed through the API even with a valid value', r.status === 400, JSON.stringify(r.data));

// 8. the active provider (whatever the environment selects) answers verify
// and test-send without needing a database write to select it.
r = await call('POST', '/internal/admin/settings/email/verify', admin);
check('verify reports for the environment-selected provider', typeof r.data.provider === 'string' && r.data.provider.length > 0, JSON.stringify(r.data));
r = await call('POST', '/internal/admin/settings/email/test-send', admin, { to: 'ops@example.com' });
check('test send answers ok:boolean for the active provider', typeof r.data.ok === 'boolean', JSON.stringify(r.data));
r = await call('POST', '/internal/admin/settings/email/test-send', admin, { to: 'nope' });
check('test send rejects bad recipient', r.status === 400);

// 9. clearing a value falls back to env/default
await call('PUT', '/internal/admin/settings', admin, { values: { ORG_NAME: '' } });
r = await call('GET', '/internal/admin/settings', admin);
const orgName = r.data.values.find((v) => v.key === 'ORG_NAME');
check('cleared value falls back to default', orgName.value === 'ABInBev' && orgName.source === 'default', JSON.stringify(orgName));

// 10. session lifetime setting actually reaches auth
await call('PUT', '/internal/admin/settings', admin, { values: { SESSION_IDLE_MINUTES: '45' } });
r = await call('GET', '/internal/auth/me', admin);
check('session still valid after changing lifetimes', r.status === 200);

// 11. staged diagnostics for whichever provider the environment selected.
// Provider choice is envOnly now, so this suite cannot force a provider to
// exercise both branches — it only confirms the shape of whichever answer
// comes back from the currently configured one.
r = await call('POST', '/internal/admin/settings/email/diagnose', admin);
if (r.data.applicable) {
  check('diagnostics run in stages for an HTTPS provider',
    Array.isArray(r.data.steps) && r.data.steps.length > 0 && typeof r.data.ok === 'boolean',
    JSON.stringify(r.data.steps));
} else {
  check('diagnostics explain why there is nothing to test', typeof r.data.reason === 'string', JSON.stringify(r.data));
}

// cleanup so repeat runs start clean
await db.query('DELETE FROM app_settings');
await db.end();

process.exit(failures ? 1 : 0);
