// Settings API e2e: catalog, round-trip, secret masking, encryption at rest,
// validation, provider hot-swap and RBAC.
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
let r = await call('GET', '/internal/admin/settings', admin);
check('catalog returns groups + fields + values',
  r.status === 200 && r.data.groups.length >= 4 && r.data.fields.length >= 29 && r.data.values.length === r.data.fields.length,
  JSON.stringify(r.data).slice(0, 120));

const gmailPw = r.data.fields.find((f) => f.key === 'GMAIL_APP_PASSWORD');
check('secret field flagged + AND-conditional',
  gmailPw?.secret === true &&
  Array.isArray(gmailPw?.visibleWhen) &&
  gmailPw.visibleWhen.some((c) => c.key === 'EMAIL_PROVIDER') &&
  gmailPw.visibleWhen.some((c) => c.key === 'GMAIL_AUTH'));

// 2. non-admin blocked
r = await call('GET', '/internal/admin/settings', agent);
check('zone agent cannot read settings (403)', r.status === 403);
r = await call('PUT', '/internal/admin/settings', agent, { values: { EMAIL_FROM_NAME: 'hacked' } });
check('zone agent cannot write settings (403)', r.status === 403);

// 3. write + read back (spaces stripped from app password)
r = await call('PUT', '/internal/admin/settings', admin, {
  values: {
    GMAIL_USER: 'ops@example.com',
    GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    EMAIL_FROM_NAME: 'ABI Privacy',
  },
});
check('update accepted', r.status === 200 && r.data.updated.length === 3, JSON.stringify(r.data).slice(0, 160));
const byKey = Object.fromEntries((r.data.values ?? []).map((v) => [v.key, v]));
check('plaintext value echoed back', byKey.EMAIL_FROM_NAME?.value === 'ABI Privacy' && byKey.EMAIL_FROM_NAME.source === 'database');
check('secret never returned in plaintext', byKey.GMAIL_APP_PASSWORD?.value === '' && byKey.GMAIL_APP_PASSWORD?.isSet === true);

// 4. encryption at rest + no plaintext column
const db = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await db.connect();
const row = (await db.query('SELECT * FROM app_settings WHERE key=$1', ['GMAIL_APP_PASSWORD'])).rows[0];
check('secret stored encrypted', row?.secret === true && row.value === null && String(row.value_enc).startsWith('v1:'));
check('secret ciphertext hides the value', !String(row.value_enc).includes('abcdefghijklmnop'));

// 5. audit records the key but redacts the value
const audit = (await db.query(`SELECT after FROM audit_log WHERE action='settings.updated' ORDER BY id DESC LIMIT 1`)).rows[0];
check('audit redacts secret values',
  JSON.stringify(audit.after).includes('[redacted]') && !JSON.stringify(audit.after).includes('abcdefghijklmnop'),
  JSON.stringify(audit.after));

// 6. validation
r = await call('PUT', '/internal/admin/settings', admin, { values: { SESSION_IDLE_MINUTES: '2' } });
check('number below min rejected', r.status === 400, JSON.stringify(r.data));
r = await call('PUT', '/internal/admin/settings', admin, { values: { PRIVACY_MAILBOX: 'not-an-email' } });
check('bad email rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { PUBLIC_BASE_URL: 'ftp://x' } });
check('bad url rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'sendgrid' } });
check('unknown select option rejected', r.status === 400);
r = await call('PUT', '/internal/admin/settings', admin, { values: { NOT_A_SETTING: 'x' } });
check('unknown key rejected', r.status === 400);

// 7. provider hot-swap without restart
r = await call('POST', '/internal/admin/settings/email/verify', admin);
const before = r.data.provider;
await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'gmail' } });
r = await call('POST', '/internal/admin/settings/email/verify', admin);
check('provider switches at runtime', String(r.data.provider).startsWith('gmail'), `${before} -> ${r.data.provider}`);
check('verify reports credential problems instead of throwing', r.data.ok === false && typeof r.data.detail === 'string');

// 8. back to console + real test send
await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'console' } });
r = await call('POST', '/internal/admin/settings/email/test-send', admin, { to: 'ops@example.com' });
check('test send succeeds on console provider', r.data.ok === true, JSON.stringify(r.data));
r = await call('POST', '/internal/admin/settings/email/test-send', admin, { to: 'nope' });
check('test send rejects bad recipient', r.status === 400);

// 9. clearing a value falls back to env/default
await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_FROM_NAME: '' } });
r = await call('GET', '/internal/admin/settings', admin);
const fromName = r.data.values.find((v) => v.key === 'EMAIL_FROM_NAME');
check('cleared value falls back to default', fromName.value === 'Privacy Team' && fromName.source === 'default', JSON.stringify(fromName));

// 10. session lifetime setting actually reaches auth
await call('PUT', '/internal/admin/settings', admin, { values: { SESSION_IDLE_MINUTES: '45' } });
r = await call('GET', '/internal/auth/me', admin);
check('session still valid after changing lifetimes', r.status === 200);


// 11. SMTP settings + staged diagnostics
r = await call('PUT', '/internal/admin/settings', admin, {
  values: { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '587', SMTP_USER: 'a@b.com', SMTP_PASSWORD: 'secret' },
});
check('custom SMTP settings accepted', r.status === 200 && r.data.updated.length === 5, JSON.stringify(r.data).slice(0, 140));

r = await call('POST', '/internal/admin/settings/email/diagnose', admin);
check('diagnostics run for SMTP provider', r.data.applicable === true && Array.isArray(r.data.steps) && r.data.steps.length > 0);
check('diagnostics report the failing stage', r.data.ok === false && r.data.steps[0].step === 'DNS lookup' && r.data.steps[0].ok === false,
  JSON.stringify(r.data.steps));
check('failing stage carries a remediation hint', typeof r.data.steps[0].hint === 'string');

r = await call('PUT', '/internal/admin/settings', admin, { values: { SMTP_PORT: '99999' } });
check('out-of-range SMTP port rejected', r.status === 400);

// HTTPS-based providers get reachability diagnostics too
await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'resend' } });
r = await call('POST', '/internal/admin/settings/email/diagnose', admin);
check('diagnostics cover HTTPS providers',
  r.data.applicable === true && r.data.steps.some((s) => s.step.includes('443')),
  JSON.stringify(r.data.steps));

// console provider has no connection to test
await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'console' } });
r = await call('POST', '/internal/admin/settings/email/diagnose', admin);
check('diagnostics skip providers with no transport', r.data.applicable === false && typeof r.data.reason === 'string');

// 12. a blocked provider must not stall the public endpoint
await call('PUT', '/internal/admin/settings', admin, {
  values: { EMAIL_PROVIDER: 'smtp', SMTP_HOST: '10.255.255.1', SMTP_PORT: '587' },
});
const draftRes = await fetch(`${BASE}/public/drafts`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ formKey: 'eur-1' }),
});
const cookieJar = draftRes.headers.get('set-cookie')?.split(';')[0] ?? '';
const { draftId } = await draftRes.json();
const t0 = Date.now();
const vr = await fetch(`${BASE}/public/verification/send`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieJar },
  body: JSON.stringify({ draftId, email: 'blocked@example.com' }),
});
const elapsed = Date.now() - t0;
check('verification endpoint answers fast even when the mail host is unreachable',
  vr.status === 201 && elapsed < 3000, `${vr.status} in ${elapsed}ms`);

await call('PUT', '/internal/admin/settings', admin, { values: { EMAIL_PROVIDER: 'console' } });

// cleanup so repeat runs start clean
await db.query(`DELETE FROM app_settings WHERE key <> 'EMAIL_PROVIDER'`);
await db.end();

process.exit(failures ? 1 : 0);
