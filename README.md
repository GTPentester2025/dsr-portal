# Multi-Zone DSR Portal

Self-hosted Data Subject Request intake and case management platform for three
zones — **EUR**, **SAZ**, **MAZ** — covering 12 country/region intake
forms, with email verification, ticketing, auto-assignment, SLA tracking,
templated responses, dashboards, RBAC and hard zone isolation.

Built against `../dsr-portal-build-prompt.md` (the spec). Spec references below
use its section numbers.

## Layout

```
form-schema/         normalized schemas (single source of truth) + manifest + countries snapshot
apps/public-form/    public intake SPA (React/Vite, minimal bundle, no admin code)
apps/admin/          internal case-management SPA (React/Vite)
server/              NestJS API — intake, verification, cases, SLA, email, RBAC
docker-compose.yml   production-shaped deployment
```

## Quick start (dev, Windows-friendly — no Docker needed)

```bash
# 1. database (embedded Postgres on 127.0.0.1:5433, UTF8)
cd server && node scripts/dev-db.mjs        # keep running

# 2. migrations + form import + a first admin user
DATABASE_URL=postgres://dsr:dsr@127.0.0.1:5433/dsr npx drizzle-kit migrate
node scripts/import-forms.mjs
node scripts/create-user.mjs admin@you.com "Your Name" admin "" "SomePassw0rdLong!"

# 3. API (console email adapter logs emails to .email-out.jsonl)
EMAIL_PROVIDER=console EMAIL_CONSOLE_FILE=.email-out.jsonl \
ADMIN_API_TOKEN=devtoken node dist/main.js   # after: npm run build

# 4. front-ends
cd apps/public-form && npm run dev   # http://localhost:5180  (proxies /public)
cd apps/admin && npm run dev         # http://localhost:5181  (proxies /internal)
```

Gmail testing: set `EMAIL_PROVIDER=gmail`, `GMAIL_AUTH=app-password`,
`GMAIL_USER`, `GMAIL_APP_PASSWORD` (Google account → App passwords). Admin
panel → "Test connection" exercises the active provider, or:
`curl -H "X-Admin-Token: $ADMIN_API_TOKEN" localhost:3000/admin/email/verify`.

## Test suites (all runnable now)

| Script | Covers |
|---|---|
| `server/scripts/rls-check.mjs` | cross-zone IDOR at the database layer, fail-closed context, audit append-only |
| `server/scripts/e2e-intake.mjs` | full §3 verification flow, replay, uniform responses, rate limits, unknown-field rejection, encryption at rest, ack email |
| `server/scripts/e2e-auth.mjs` | login/logout, session revocation, RBAC, cross-zone IDOR via API |
| `server/scripts/e2e-workflow.mjs` | transitions matrix, system-only Overdue, extension/closure rules, templates, outbound, SLA breach sweep, audit trail |
| `npx jest src/email` | template rendering, HTML escaping, missing-variable failure |
| `apps/public-form`: `node --experimental-strip-types scripts/smoke.mjs` | renderer validation/conditional logic against all 12 real schemas |

## Architecture decisions (deviations from the spec's suggestions)

- **12 forms, not 3.** The source estate is 2 EUR + 6 SAZ + 4 MAZ country
  forms. One schema per form (`form-schema/{key}.json`), zone recorded on each;
  schemas are **verbatim form.io component trees** so field fidelity is exact
  by construction (§2). Re-run `form-source/extract.py` + `scripts/import-forms.mjs`
  when a source form changes — the version lands in `form_versions` and old
  cases keep rendering against their stored version (§5).
- **No Redis.** Scheduling/reminders run on `@nestjs/schedule` with a Postgres
  advisory lock (multi-instance safe, idempotent). If queue depth ever demands
  it, `pg-boss` is installed and the jobs sit behind service seams — or swap to
  BullMQ per the spec; nothing outside the services would change.
- **Zone isolation is Postgres RLS**, not app filtering (§9). The app connects
  as non-owner `dsr_app`; every query runs in a transaction that sets
  `app.current_role` / `app.current_zone`. No context ⇒ zero rows (fail closed).
  `scripts/rls-check.mjs` proves it.
- **Field-level encryption** (AES-256-GCM envelope, HKDF-derived keys, HMAC
  lookup column for email equality) with `CRYPTO_MASTER_KEY` in dev; the `v1:`
  ciphertext prefix reserves room for a KMS-wrapped `v2:` in production.
- **Email adapters:** `gmail` (app-password SMTP or OAuth2 API), `graph`
  (client credentials, send-as shared mailbox), `console` (dev/e2e; refused in
  production). Selection is exactly one env var (§4).

## Statuses & SLA defaults (need Legal sign-off — spec §14)

Seeded: `New → Open → Pending → Pending Approver → Extended → Overdue → Closed`
with a transitions matrix in `status_transitions` (edit via SQL/admin later).
`Overdue` is system-set by the SLA sweep only. `Extended` demands justification
+ new due date and reminds the agent about the GDPR Art. 12(3) notification.
Closure demands an outcome code + note.

Seeded SLA fallbacks (calendar days, per zone `*`): EUR 30 (pause allowed,
+60 ext), SAZ 15, MAZ 20 (pause allowed, +10). **These are placeholders** —
fill the real per-zone × per-request-type matrix in `sla_policies` once Legal
confirms (§14.3/.4), including business-day calendars and holiday lists.

## Production deployment notes (§9, §12)

- `docker-compose.yml` sketches the topology: DB on an internal network, API
  reachable from the edge only for `/public/*`; the admin bundle and
  `/internal/*` must never be exposed on the public vhost.
- Edge requirements not implemented in-app (do these at the proxy/WAF):
  TLS 1.3 termination, global rate limiting + bot management on every public
  endpoint, request size limits (app also caps JSON at 256 KB).
- CAPTCHA: set `TURNSTILE_SECRET` (+ site key in the form) — the verification
  send endpoint validates it server-side; unset = dev mode (skipped).
- SSO: internal auth is session-based with an OIDC-shaped user model; local
  break-glass credentials exist only via `scripts/create-user.mjs`
  (argon2id, 14+ char policy, rate-limited login, idle + absolute timeouts).
  Wire your IdP before go-live and enforce MFA there.
- Azure for Graph: app registration + `Mail.Send` **application** permission
  + admin consent + an application access policy restricting the app to the
  privacy shared mailbox. Config: `GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET`,
  `PRIVACY_MAILBOX`, `EMAIL_PROVIDER=graph`.
- `npm audit`: 4 moderate findings, all inside `drizzle-kit`'s dev-time
  esbuild toolchain — never deployed at runtime.

## Known gaps / next steps

- Attachment upload endpoint (schema + storage-key model ready; needs object
  storage + AV scan wiring per §5).
- Escalation emails for unacknowledged cases (config fields exist; sweep hook
  pending) and requester-facing extension notification template.
- Full-text case search, saved views, bulk actions (§11) — list filters exist.
- Retention/purge job with legal hold (§9 Data).
- OIDC login + MFA enforcement; CSRF double-submit token if the internal app
  is ever served cross-site (cookies are `SameSite=Strict` today).
- Pixel-level visual QA of the 12 public forms against their design reference.

---

# Deployment (203.0.113.10)

| Surface | URL |
|---|---|
| Public intake portal | https://203-0-113-10.sslip.io/ |
| Internal console | https://203-0-113-10.sslip.io/admin/ |
| API (loopback only) | 127.0.0.1:3000, proxied by nginx |

Stack on the host: nginx 1.24 (TLS terminator + static host + reverse proxy),
Node 22 running the API under systemd as `dsr-api`, PostgreSQL 16, 2 GB swap,
UFW allowing only 22/80/443.

## Deploying a change

```bash
bash deploy/deploy.sh          # build, upload, migrate, restart, health-check
```

The script is idempotent: it rebuilds all three bundles, mirrors them with
tar-over-ssh, runs `scripts/migrate.mjs` (tracked in `schema_migrations`),
re-imports the form schemas, then restarts the service.

Useful one-liners:

```bash
ssh -i <key> root@203.0.113.10 'systemctl status dsr-api'
ssh -i <key> root@203.0.113.10 'journalctl -u dsr-api -f'
node deploy/smoke.mjs            # 24 production checks (ADMIN_PW required)
```

## Configuration is done in the GUI

Sign in as an administrator and open **Settings**. Everything that used to be
an environment variable is editable there: email provider and Gmail app
password, Microsoft Graph credentials, portal URLs, Turnstile keys, session
lifetimes and rate limits, branding.

- Values resolve **database → environment → catalog default**, so anything set
  in the UI wins and takes effect immediately (no restart).
- Secrets are AES-256-GCM encrypted with the KMS-ready envelope format and are
  **never** returned to the browser — the UI only shows whether one is set.
- Every change is written to the audit log with secret values redacted.
- "Test connection" probes the active provider; "Send test" delivers a real
  message through it.

## HTTPS

The site is served over TLS at **https://203-0-113-10.sslip.io** with a real
Let's Encrypt certificate. Public CAs will not issue for a bare IP, so the
hostname comes from sslip.io, which resolves any dashed IP embedded in its name
straight back to that IP — no domain purchase, no DNS to manage.

```bash
bash deploy/enable-tls-ip.sh                 # this host, via sslip.io
bash deploy/enable-tls.sh privacy.example.com ops@example.com   # a real domain
```

In place now: HTTP→HTTPS 301, HSTS on every path, `COOKIE_SECURE=true` so
session cookies carry `Secure`, and `certbot.timer` for renewal.

> `deploy/nginx.conf` in this repo is HTTP-only, so a deploy would overwrite
> certbot's TLS blocks. `deploy.sh` therefore re-runs `certbot install --nginx
> --redirect` after pushing the config. Do not remove that step — TLS would
> disappear on the next release without any error.

Moving to a real domain later: point it at the server, run `enable-tls.sh`,
then update the two `PORTAL_*_URL` values in Settings.


## Email delivery on this host — important

The droplet **blocks the standard outbound SMTP ports**. Verified from the
server:

```
BLOCKED  smtp.gmail.com:25 / :465 / :587
BLOCKED  smtp.sendgrid.net:587, smtp-relay.brevo.com:587
OPEN     smtp.sendgrid.net:2525, smtp-relay.brevo.com:2525, smtp.mailgun.org:2525
OPEN     email-smtp.us-east-1.amazonaws.com:2587
OPEN     443 to every provider API
```

This is DigitalOcean's standard anti-spam policy on new accounts, not a portal
bug. **Gmail app passwords can never work here** — Gmail offers no port other
than the blocked ones. The submission ports 2525 and 2587 are open, so a relay
does work.

Run **Settings, Email delivery, Run diagnostics** to see this live: it reports
DNS, TCP, TLS and authentication separately, so the failing layer is explicit.

Four ways forward, all usable today:

1. **Gmail over OAuth2 — two clicks, keeps Gmail as the sender.** Sends through
   the Gmail API over HTTPS, so the SMTP block is irrelevant. In Google Cloud
   enable the Gmail API, create a **Web application** OAuth client, and paste in
   the redirect URI the Settings screen shows (copy button next to it):
   `https://203-0-113-10.sslip.io/internal/admin/settings/email/gmail/callback`.
   Then in Settings set provider **Gmail**, authentication **OAuth2**, paste the
   client ID and secret, save, and press **Connect Google account**. The portal
   completes the exchange, stores the refresh token encrypted and fills in the
   Gmail address itself.
2. **A relay on port 2525.** Choose **Custom SMTP** and press a preset —
   SendGrid, Brevo or Mailgun — which fills host, port and encryption. Only the
   username and password are left. 587 times out; 2525 does not. Verified from
   the server: all three complete a TLSv1.3 STARTTLS handshake on 2525.
3. **Resend.** Verify a sending domain, create an API key, choose provider
   **Resend**. Pure HTTPS.
4. **Microsoft Graph.** Also HTTPS-only; works here if you have a tenant.

Asking DigitalOcean to lift the block is still worth doing, but nothing waits
on it.

### Behaviour when mail cannot be delivered

The public verification endpoint answers in about half a second regardless of
provider health. The token is written first, then the message is dispatched in
the background, so a blocked or slow provider never stalls the request and
never leaks timing information. Delivery failures are logged with the reason:

```bash
ssh -i <key> root@203.0.113.10 'journalctl -u dsr-api -f | grep -i verification'
```
