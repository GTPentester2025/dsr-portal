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
EMAIL_PROVIDER=console EMAIL_CONSOLE_FILE=.email-out.jsonl node dist/main.js   # after: npm run build

# 4. front-ends
cd apps/public-form && npm run dev   # http://localhost:5180  (proxies /public)
cd apps/admin && npm run dev         # http://localhost:5181  (proxies /internal)
```

Microsoft Graph testing: set `EMAIL_PROVIDER=graph` plus `GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and `PRIVACY_MAILBOX` (see "Email
delivery" below). All five email keys are environment-only — there is no
Gmail, SMTP or Resend adapter, and no in-app way to set any of them. Admin
panel → "Test connection" exercises the active provider, or run
`node server/scripts/verify-email.mjs` from the host.

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
- **Email adapters:** `graph` (Microsoft Graph, client credentials, send-as a
  shared mailbox) and `console` (dev/e2e; refused in production unless
  `ALLOW_CONSOLE_EMAIL=true`). Selection and every Graph credential are
  environment-only — `EMAIL_PROVIDER`, `PRIVACY_MAILBOX`, `GRAPH_TENANT_ID`,
  `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` — so a database
  row can never shadow the file on the server, and the settings API refuses
  to write one (§4).

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
  `PRIVACY_MAILBOX`, `EMAIL_PROVIDER=graph`, all in `/opt/dsr/server/.env` —
  see "Email delivery" below. Confirm the whole path with
  `node server/scripts/verify-email.mjs`.
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

# Deployment

| Surface | URL |
|---|---|
| Public intake portal | `$PORTAL_BASE/` |
| Internal console | `$PORTAL_BASE/admin/` |
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

### The deployment secrets file

`deploy.sh` sources a per-host, gitignored secrets file —
`deploy/.secrets.<host>.env`, chosen with `SECRETS_FILE=` and defaulting to
`deploy/.secrets.blr.env`. Everything the script writes into
`/opt/dsr/server/.env` comes from there, and it rewrites that file wholesale on
every deploy: a value not in the secrets file does not survive the next release.

| Variable | What it is |
|---|---|
| `DB_PASS` | password for the `dsr` database owner |
| `APP_PASS` | password for the RLS-constrained `dsr_app` role |
| `CRYPTO_MASTER_KEY` | 32 bytes, base64 — encrypts every secret setting at rest |
| `COOKIE_SECURE` | optional; `true` unless you are deliberately on plain HTTP |
| `EMAIL_PROVIDER` | optional; `graph` (the default) or `console` |
| `PRIVACY_MAILBOX` | the shared mailbox the portal sends as |
| `GRAPH_TENANT_ID` | Azure directory (tenant) ID |
| `GRAPH_CLIENT_ID` | Azure application (client) ID |
| `GRAPH_CLIENT_SECRET` | the client secret's value |

> **Upgrading an existing server: add the five email variables before your next
> deploy.** They are new. The provider and its Graph credentials used to live in
> `app_settings`; they are now environment-only, in the very file `deploy.sh`
> truncates and rewrites. If they are absent, `deploy.sh` stops with a `FATAL:`
> naming them and uploads nothing — which is the good outcome. Skipping that
> guard would leave the API exiting at boot, systemd restarting it every three
> seconds, and nginx proxying the public intake form and the admin console to a
> dead process.

Useful one-liners:

```bash
ssh -i <key> "$DEPLOY_HOST" 'systemctl status dsr-api'
ssh -i <key> "$DEPLOY_HOST" 'journalctl -u dsr-api -f'
node deploy/smoke.mjs            # 24 production checks (ADMIN_PW required)
```

## Configuration is done in the GUI

Sign in as an administrator and open **Settings**. Most of what used to be an
environment variable is editable there: portal URLs, Turnstile keys, session
lifetimes and rate limits, branding.

- Values resolve **database → environment → catalog default**, so anything set
  in the UI wins and takes effect immediately (no restart).
- Secrets are AES-256-GCM encrypted with the KMS-ready envelope format and are
  **never** returned to the browser — the UI only shows whether one is set.
- Every change is written to the audit log with secret values redacted.
- "Test connection" probes the active provider; "Run diagnostics" checks it
  stage by stage; "Send test" delivers a real message through it.

**Email delivery is the one group that is not editable here.** `EMAIL_PROVIDER`,
`PRIVACY_MAILBOX` and the three `GRAPH_*` credentials are
**environment-only**: the Settings screen shows them read-only with "Set in
`/opt/dsr/server/.env`", and `PUT /internal/admin/settings` returns `400` for
any of the five. A database row can never shadow the file on the server, and a
missing Graph credential stops the service at boot rather than dropping the
first data-subject email. See "Email delivery" below.

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


## Email delivery

Microsoft Graph is the only production email adapter. `console` exists for
dev/e2e only and refuses to run in production unless
`ALLOW_CONSOLE_EMAIL=true`. Five keys select and configure it, all
**environment-only** — read from `/opt/dsr/server/.env` (the same file
`deploy.sh` writes for every other server setting; `chmod 600`, owned by
`dsr:dsr`, loaded by systemd as `dsr-api`'s `EnvironmentFile`), ignored as an
`app_settings` row, and rejected with `400` if anything tries to write one
through the settings API:

```
EMAIL_PROVIDER=graph                    # graph | console
PRIVACY_MAILBOX=privacy@company.com

GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=
```

There is no sender-name key. The display name recipients see is whatever the
privacy shared mailbox carries in Exchange, so change it there rather than in
this file.

When `EMAIL_PROVIDER=graph`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET` and `PRIVACY_MAILBOX` must all be non-empty or the
service **refuses to start** — `journalctl -u dsr-api` names every key that
is missing, rather than the old failure mode of a healthy service silently
dropping the first verification email a data subject is waiting on.

### Azure app registration

1. In Microsoft Entra ID, register an application. Under **API permissions**
   add Microsoft Graph → **Application permissions** → `Mail.Send`, then
   **grant admin consent** — an application permission does nothing until a
   tenant admin consents to it.
2. Under **Certificates & secrets**, create a client secret. You need three
   values: the **directory (tenant) ID**, the **application (client) ID**,
   and the secret's **value** (shown once, at creation).
3. Restrict the app to a single mailbox with an **application access
   policy**, from Exchange Online PowerShell:
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId privacy@company.com -AccessRight RestrictAccess `
     -Description "DSR portal: Mail.Send restricted to the privacy mailbox"
   ```
   Without this policy, `Mail.Send` lets the app send as **any** mailbox in
   the tenant, not just the one the portal should use.
4. Write the four `GRAPH_*`/`PRIVACY_MAILBOX` values and `EMAIL_PROVIDER=graph`
   into `/opt/dsr/server/.env` on the server, then `systemctl restart dsr-api`.
   Set the sender's display name on the mailbox itself in Exchange; the portal
   has no setting for it.

### Confirming it works

`server/scripts/verify-email.mjs` proves the whole path from the host,
independent of whether the build or the service is currently healthy. The
file is `chmod 600` and owned by `dsr`, so read it as that user or with sudo:

```bash
cd /opt/dsr/server
sudo -u dsr bash -c 'set -a; . ./.env; set +a; node scripts/verify-email.mjs'
# or, already root on the box:
set -a; . /opt/dsr/server/.env; set +a
node scripts/verify-email.mjs                          # 4 checks, sends nothing
node scripts/verify-email.mjs --send you@company.com   # also sends a real message
```

In order: configuration present, `login.microsoftonline.com` resolves, a
client-credentials token is issued, and the privacy mailbox is reachable
through Graph — which is what actually proves `Mail.Send` consent and the
access policy, not just a syntactically valid app registration. A failure
names the stage and a remediation hint. The same checks back the Settings
screen's **Test connection** and **Run diagnostics**.

Graph sends over HTTPS (port 443) only. This host blocks the standard
outbound SMTP ports (25, 465, 587) as DigitalOcean's default anti-spam
policy, but that block is irrelevant here — nothing in this portal opens an
SMTP connection.

### Behaviour when mail cannot be delivered

The public verification endpoint answers in about half a second regardless of
provider health. The token is written first, then the message is dispatched in
the background, so a blocked or slow provider never stalls the request and
never leaks timing information. Delivery failures are logged with the reason:

```bash
ssh -i <key> "$DEPLOY_HOST" 'journalctl -u dsr-api -f | grep -i verification'
```
