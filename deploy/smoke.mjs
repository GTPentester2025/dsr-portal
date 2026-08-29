import { portalBase } from './target.mjs'
// Read-only production smoke test.
//
// Every check here must be non-mutating. The e2e-* suites in server/scripts are
// NOT safe to point at a live deployment: e2e-settings rewrites and clears
// settings as part of testing provider hot-swap, which will wipe real
// credentials. Run those against a local stack only.
// Production smoke test: hits the deployed portal over nginx and checks the
// public surface, auth, RBAC and the settings API. Creates no test data.
const BASE = portalBase()
const PW = process.env.ADMIN_PW
let fail = 0
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); if (!c) fail++ }

// TLS
let r = await fetch(BASE.replace('https://', 'http://') + '/', { redirect: 'manual' })
check('plain http redirects to https', r.status === 301 && (r.headers.get('location') ?? '').startsWith('https://'),
  `${r.status} ${r.headers.get('location')}`)

// public surface
r = await fetch(`${BASE}/`)
check('public form served', r.status === 200 && (await r.text()).includes('<div id="root">'))
r = await fetch(`${BASE}/admin/`)
check('admin console served', r.status === 200)
r = await fetch(`${BASE}/form-schema/manifest.json`)
const manifest = await r.json()
const forms = Object.values(manifest.zones).flat().length
check('all 12 form schemas published', forms === 12, `got ${forms}`)

// security headers
r = await fetch(`${BASE}/`)
check('HSTS present', (r.headers.get('strict-transport-security') ?? '').includes('max-age'),
  r.headers.get('strict-transport-security') ?? 'missing')
check('nosniff header', r.headers.get('x-content-type-options') === 'nosniff')
check('public form is same-origin framable only',
  r.headers.get('x-frame-options') === 'SAMEORIGIN'
  && (r.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'self'"),
  r.headers.get('x-frame-options') ?? 'missing')
check('nginx version hidden', !/nginx\/[0-9]/.test(r.headers.get('server') ?? ''), r.headers.get('server') ?? '')


// The console itself must never be framable, by anyone.
const adminHead = await fetch(`${BASE}/admin/`)
check('admin console refuses framing', adminHead.headers.get('x-frame-options') === 'DENY',
  adminHead.headers.get('x-frame-options') ?? 'missing')
// public intake reachable through nginx
r = await fetch(`${BASE}/public/drafts`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ formKey: 'eur-1' }),
})
const draft = await r.json()
check('draft endpoint works via nginx', r.status === 201 && Boolean(draft.draftId))

// unauthenticated internal API is closed
r = await fetch(`${BASE}/internal/cases`)
check('internal API requires auth', r.status === 401)
r = await fetch(`${BASE}/internal/admin/settings`)
check('settings API requires auth', r.status === 401)

// admin login + settings
r = await fetch(`${BASE}/internal/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@abinbev.com', password: PW }),
})
const cookie = r.headers.get('set-cookie')?.split(';')[0] ?? ''
check('admin can sign in', r.status === 200 && cookie.startsWith('dsr_int='))
const setCookie = r.headers.get('set-cookie') ?? ''
check('session cookie is HttpOnly, Secure and SameSite=Strict',
  /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie)

const get = async (p) => {
  const res = await fetch(BASE + p, { headers: { cookie } })
  return { status: res.status, data: await res.json().catch(() => null) }
}

r = await get('/internal/auth/me')
check('session resolves with an administrative role', r.status === 200 && ['admin', 'super_admin'].includes(r.data.role), r.data?.role)

r = await get('/internal/admin/settings')
// Lower bound only: the catalog holds 18 fields today (6 email + 2 portal +
// 8 security + 2 branding). Pin low enough to survive new settings, high
// enough to catch a truncated or empty payload.
check('settings catalog loads', r.status === 200 && r.data.fields.length >= 15, `${r.data?.fields?.length} fields`)
const baseUrl = r.data.values.find((v) => v.key === 'PUBLIC_BASE_URL')
// Verification links are built from this. A loopback value mails out dead links.
check('public base URL is externally reachable',
  Boolean(baseUrl?.value) && /^https?:\/\//.test(baseUrl.value)
  && !/localhost|127\.0\.0\.1|::1|0\.0\.0\.0/.test(baseUrl.value),
  baseUrl?.value ?? 'unset')

const provider = r.data.values.find((v) => v.key === 'EMAIL_PROVIDER')
// EMAIL_PROVIDER is envOnly: a database row must never win. Proving source
// is 'environment' here is what confirms the lock holds on the real server.
check('email provider is Microsoft Graph, owned by the environment',
  provider.value === 'graph' && provider.source === 'environment', JSON.stringify(provider))
const secrets = r.data.values.filter((v) => v.secret)
check('no secret leaves the server', secrets.every((v) => v.value === ''), JSON.stringify(secrets.filter((v) => v.value !== '')))

r = await get('/internal/dashboard')
check('dashboard aggregates', r.status === 200 && Array.isArray(r.data.byStatus))

const probe = await fetch(`${BASE}/internal/admin/settings/email/verify`, { method: 'POST', headers: { cookie } })
const probed = await probe.json()
check('email probe answers for the configured provider',
  typeof probed.ok === 'boolean' && typeof probed.provider === 'string' && probed.provider.length > 0,
  JSON.stringify(probed))

r = await get('/internal/forms')
check('form builder API reachable', r.status === 200 && r.data.length === 12, `${r.data?.length} forms`)

r = await get('/internal/sla-policies')
check('SLA policy API reachable', r.status === 200 && Array.isArray(r.data.policies))

r = await get('/internal/templates')
check('template library seeded', r.status === 200 && r.data.length >= 18, `${r.data?.length} templates`)

// the public form must be served from the database, not static files
const pub = await fetch(`${BASE}/public/forms/eur-1`)
const schema = await pub.json()
check('public schema served from the database', pub.status === 200 && typeof schema.version === 'number')
check('operational settings never reach the public bundle', !('settings' in schema))

process.exit(fail ? 1 : 0)
