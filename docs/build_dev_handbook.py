"""Build the developer handbook (Word)."""
import json
from datetime import date

from docgen import (ROOT, add_toc, bullets, callout, code, figure, h1, h2, h3,
                    new_document, numbered, page_break, para, rich_para, table)

ROUTES = json.loads((ROOT / "docs" / "_routes.json").read_text(encoding="utf-8"))
INVENTORY = json.loads((ROOT / "docs" / "_inventory.json").read_text(encoding="utf-8"))

NOISE = ("package-lock.json", "/meta/", "form-source/inspect/", "tsconfig", "eslint")
OURS = {k: v for k, v in INVENTORY.items() if not any(n in k for n in NOISE)}

doc = new_document(
    "DSR Portal",
    "Developer Handbook",
    "Architecture, source map, pipelines and operations",
    f"Version 1.0  ·  {date.today():%d %B %Y}",
)
add_toc(doc)

# ========================================================== 1. architecture
h1(doc, "1. Architecture")

h2(doc, "1.1 The shape of the system")
para(doc,
     "Three deployable pieces sit behind one nginx instance. The API is the only "
     "component that talks to the database, and it is bound to the loopback "
     "interface, so nginx is the single public entrance.")
code(doc, """
                         ┌──────────────────────────────┐
   data subject ───────► │  nginx  :80                  │
                         │  ├─ /            public SPA  │  static files
   privacy team ───────► │  ├─ /admin       admin SPA   │  static files
                         │  ├─ /public/*  ─┐            │
                         │  └─ /internal/*─┴─ proxy ────┼──► API :3000 (loopback)
                         └──────────────────────────────┘        │
                                                                  │ pg
                                                        ┌─────────▼─────────┐
                                                        │ PostgreSQL 16     │
                                                        │  RLS per zone     │
                                                        └───────────────────┘
""")

table(doc, ["Component", "Technology", "Serves"], [
    ["Public form SPA", "React 19, Vite, vendored source CSS", "The 12 public request forms"],
    ["Admin console SPA", "React 19, Vite, Tailwind v4", "The internal case-management UI"],
    ["API", "NestJS 11, Node 22, Drizzle ORM", "All business logic and data access"],
    ["Database", "PostgreSQL 16 with row-level security", "Cases, forms, settings, audit"],
    ["Reverse proxy", "nginx 1.24", "TLS termination, static hosting, rate limits"],
], widths=[1.6, 2.2, 2.6])

h2(doc, "1.2 Design decisions worth knowing")
bullets(doc, [
    "**Zone isolation lives in the database, not the controllers.** The API connects as a non-owner role and sets `app.current_zone` per transaction; PostgreSQL policies do the filtering. A missing context yields zero rows, so the failure mode is closed.",
    "**Form schemas are verbatim form.io trees.** The originals were captured field-for-field and are stored unmodified, which is what makes the public replicas exact.",
    "**Form versions are immutable.** Publishing appends a new row; a case always renders against the version it was filed under.",
    "**Configuration resolves database, then environment, then default.** The runtime cache keeps reads synchronous so providers can stay drop-in.",
    "**No Redis.** Scheduling uses a PostgreSQL advisory lock, which is multi-instance safe and removes an entire moving part.",
])

page_break(doc)

# ============================================================ 2. source map
h1(doc, "2. Source map")
para(doc, f"{len(OURS)} first-party source files, {sum(OURS.values()):,} lines, excluding "
          "lock files, migration snapshots and vendored assets.")

h2(doc, "2.1 Top level")
table(doc, ["Path", "Contains"], [
    ["`server/`", "The NestJS API: every endpoint, all business logic, migrations and operational scripts."],
    ["`apps/public-form/`", "The public request SPA. Deliberately dependency-light; never ships admin code."],
    ["`apps/admin/`", "The internal console SPA."],
    ["`form-schema/`", "Normalised form definitions. The seed for the database; not read at runtime."],
    ["`form-source/`", "The raw captures from the source platform plus `extract.py`, which normalises them."],
    ["`deploy/`", "Provisioning, deployment, nginx and systemd configuration, plus the production smoke test."],
    ["`tools/`", "Playwright capture scripts used for fidelity checks and documentation screenshots."],
    ["`docs/`", "These documents and the scripts that generate them."],
], widths=[1.7, 4.7])

h2(doc, "2.2 The API, module by module")

h3(doc, "server/src/db")
table(doc, ["File", "Responsibility"], [
    ["`schema.ts`", "Every table, as Drizzle definitions. The single source of truth for the data model."],
    ["`db.module.ts`", "`DbService`. `withContext(ctx, fn)` opens a transaction and sets the RLS role and zone; `system(fn)` is the unrestricted equivalent for schedulers and intake."],
], widths=[1.7, 4.7])
callout(doc, "warn",
        "Never query outside `withContext` or `system`. A raw pool query has no RLS context and "
        "will return nothing, which reads like a bug but is the safety net working.")

h3(doc, "server/src/auth")
table(doc, ["File", "Responsibility"], [
    ["`auth.service.ts`", "Password verification with argon2id, session creation, idle and absolute expiry, and `zoneContextFor` which maps a user to their RLS context."],
    ["`auth.guard.ts`", "`AuthGuard` resolves the session cookie and attaches `req.user` and `req.zoneCtx`. `satisfies()` implements the role ladder."],
    ["`auth.controller.ts`", "Sign in, sign out, and `me`. Also owns `cookieSecure()`, which decides whether session cookies carry the Secure flag."],
    ["`auth.guard.spec.ts`", "Unit tests for the role ladder, including the auditor exclusion."],
], widths=[1.7, 4.7])

h3(doc, "server/src/public")
table(doc, ["File", "Responsibility"], [
    ["`public.controller.ts`", "The unauthenticated surface: drafts, verification send and consume, draft status, submission."],
    ["`verification.service.ts`", "Token generation and single-use consumption, rate limiting, CAPTCHA, uniform responses."],
    ["`intake.service.ts`", "Turns a verified submission into a case: validation, reference allocation, encryption, SLA clock, acknowledgement, auto-assignment."],
    ["`form-validation.ts`", "Server-side re-implementation of every client rule, including conditional visibility and datagrid rows."],
    ["`rate-limit.service.ts`", "Fixed-window counters in PostgreSQL, safe across instances."],
], widths=[1.7, 4.7])

h3(doc, "server/src/cases")
table(doc, ["File", "Responsibility"], [
    ["`cases.service.ts`", "Zone-scoped list and detail, decrypting identifiers for display."],
    ["`workflow.service.ts`", "Status transitions, the legality matrix, extension and closure rules."],
    ["`assignment.service.ts`", "Auto-assignment strategies, out-of-office skipping, assignee notification."],
    ["`sla.service.ts`", "The hourly sweep, breach detection, reminders, pause and resume."],
    ["`outbound.service.ts`", "Template CRUD, draft rendering with variable substitution, sending and logging."],
    ["`dashboard.service.ts`", "The aggregate queries behind the dashboard."],
], widths=[1.7, 4.7])

h3(doc, "server/src/forms")
table(doc, ["File", "Responsibility"], [
    ["`forms.service.ts`", "Form listing, retrieval, publication as a new version, restore, and `validateSchema` which refuses anything the renderer cannot draw."],
    ["`forms.controller.ts`", "Admin editing endpoints, plus the public schema delivery that makes edits go live."],
    ["`sla.controller.ts`", "SLA policy CRUD per zone and request type."],
], widths=[1.7, 4.7])

h3(doc, "server/src/email")
table(doc, ["File", "Responsibility"], [
    ["`email-provider.interface.ts`", "The single seam every adapter implements."],
    ["`email.module.ts`", "`EmailDispatcher`, which resolves the active adapter per call so providers can be switched at runtime."],
    ["`smtp.ts`", "Shared SMTP transport with IPv4 pinning and timeouts, plus the staged diagnostic."],
    ["`gmail.provider.ts`", "Gmail over SMTP app password or the Gmail API with OAuth2. Only the API path works on this host."],
    ["`smtp.provider.ts`", "Any SMTP server."],
    ["`resend.provider.ts`", "Resend over HTTPS."],
    ["`graph.provider.ts`", "Microsoft Graph, sending as a shared mailbox."],
    ["`console.provider.ts`", "Development adapter that writes to the log. Refused in production."],
    ["`templates.ts`", "System transactional templates with strict variable substitution."],
], widths=[1.7, 4.7])

h3(doc, "server/src/settings and audit")
table(doc, ["File", "Responsibility"], [
    ["`settings/settings.catalog.ts`", "Declarative field catalog. Adding an entry here is all it takes to surface a new setting in the UI."],
    ["`settings/settings.service.ts`", "Resolution order, in-memory cache, encryption of secrets, validation, audit."],
    ["`settings/settings.controller.ts`", "Super-admin API, connection check, diagnostics, test send, and starting the Gmail authorisation."],
    ["`settings/gmail-oauth.service.ts`", "The OAuth2 authorisation-code flow: builds the consent URL, holds the pending `state`, exchanges the code, stores the refresh token."],
    ["`settings/gmail-callback.controller.ts`", "The unauthenticated redirect target Google returns to. Renders the success or failure page."],
    ["`audit/audit.service.ts`", "The single writer to the append-only audit log."],
], widths=[1.9, 4.5])

h2(doc, "2.3 The admin console")
table(doc, ["Path", "Responsibility"], [
    ["`src/lib/theme.tsx`", "Light, dark and system theme with a pre-paint boot script so there is no flash."],
    ["`src/lib/api.ts`", "The typed fetch wrapper and every shared type."],
    ["`src/lib/formTree.ts`", "Pure helpers for editing a form.io tree: flatten, move, update, remove, key uniqueness."],
    ["`src/components/ui.tsx`", "The primitive library: cards, buttons, fields, tables, modals, badges."],
    ["`src/components/AppShell.tsx`", "Sidebar, glass top bar, theme switch, user menu."],
    ["`src/components/CommandPalette.tsx`", "Ctrl+K navigation and actions."],
    ["`src/pages/`", "One file per screen; `FormEditorPage.tsx` is the largest and holds the builder."],
], widths=[2.0, 4.4])

h2(doc, "2.4 The public form SPA")
table(doc, ["Path", "Responsibility"], [
    ["`src/components/FieldRenderer.tsx`", "Renders the form.io tree using the source platform's own class names, which is what makes the vendored CSS apply exactly."],
    ["`src/components/Choices.tsx`", "Reimplements the choices.js dropdown DOM the original used."],
    ["`src/lib/conditional.ts`", "Show and hide evaluation, mirrored on the server."],
    ["`src/lib/validation.ts`", "Client-side validation, mirrored on the server."],
    ["`public/assets/css/`", "The vendored stylesheets, in load order."],
    ["`public/assets/fonts/`", "The 90 font files those stylesheets reference."],
], widths=[2.0, 4.4])

page_break(doc)

# ============================================================ 3. data model
h1(doc, "3. Data model")
para(doc, "Defined in `server/src/db/schema.ts` and migrated by the SQL files in "
          "`server/drizzle/`.")

h2(doc, "3.1 Tables")
table(doc, ["Table", "Purpose", "Notes"], [
    ["`zones`", "EUR, SAZ, MAZ", "Reference data"],
    ["`users`", "Internal users", "Role, zone, capacity, out-of-office, argon2id hash"],
    ["`internal_sessions`", "Signed-in sessions", "Idle and absolute expiry, revocation"],
    ["`form_versions`", "Every published form schema", "Append-only; unique on (form_key, version)"],
    ["`statuses`, `status_transitions`", "The workflow", "Configurable; illegal moves rejected server-side"],
    ["`sla_policies`", "Deadlines per zone and type", "Target days, calendar, holidays, pause, reminders"],
    ["`assignment_config`", "Routing per zone", "Strategy, escalation contact, round-robin cursor"],
    ["`form_drafts`", "Pre-submission sessions", "Holds the verified email; never a case"],
    ["`verification_tokens`", "Magic links", "SHA-256 hashed, single use, 15-minute TTL"],
    ["`rate_counters`", "Fixed-window counters", "Verification sends and failed sign-ins"],
    ["`cases`", "The request itself", "Encrypted identifiers, HMAC lookup column, status, due date"],
    ["`case_fields`", "Submitted answers", "Encrypted where the field is an identifier"],
    ["`case_status_history`", "Every transition", "Actor, from, to, note"],
    ["`case_comments`, `case_attachments`", "Case collateral", "Attachment rows carry scan status and an opaque storage key"],
    ["`sla_clocks`", "One clock per case", "State, due date, paused total, fired reminders"],
    ["`templates`", "Response library", "Versioned; zone and request type optional"],
    ["`email_log`", "Every message", "Provider, recipients, status, provider message id"],
    ["`audit_log`", "The evidence trail", "Append-only, enforced by trigger and revoked grants"],
    ["`app_settings`", "Runtime configuration", "Secrets stored as ciphertext only"],
    ["`schema_migrations`", "Applied migrations", "Written by `scripts/migrate.mjs`"],
], widths=[1.9, 2.1, 2.4])

h2(doc, "3.2 Row-level security")
para(doc, "Applied in migration `0001_rls-audit-seeds.sql`.")
code(doc, """
CREATE OR REPLACE FUNCTION app_zone_allows(zone text) RETURNS boolean AS $$
  SELECT current_setting('app.current_zone', true) = '*'
      OR current_setting('app.current_zone', true) = zone;
$$ LANGUAGE sql STABLE;

ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY cases_zone_isolation ON cases
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id));
""")
bullets(doc, [
    "Child tables (`case_fields`, `sla_clocks`, `email_log`, …) inherit isolation through an `EXISTS` clause on the parent case.",
    "The API connects as `dsr_app`, which is not the table owner, so it cannot bypass policies.",
    "With no context set, `current_setting` returns null and every policy evaluates false: zero rows.",
    "`scripts/rls-check.mjs` proves all of the above, including against the production database.",
])

h2(doc, "3.3 Encryption")
bullets(doc, [
    "AES-256-GCM, with encryption and HMAC keys derived from `CRYPTO_MASTER_KEY` via HKDF.",
    "Ciphertext is `v1:iv:ciphertext:tag`; the version prefix leaves room for a KMS-wrapped `v2`.",
    "`requester_email_hmac` is a deterministic keyed hash, so equality lookups work without decrypting.",
    "Field-level encryption applies to a fixed set of identifier keys, listed in `intake.service.ts`.",
])

page_break(doc)

# =============================================================== 4. flows
h1(doc, "4. Pipelines and flows")

h2(doc, "4.1 Public intake, end to end")
code(doc, """
browser                    API                          database        email
  │  POST /public/drafts    │                              │              │
  ├────────────────────────►│ insert form_drafts ─────────►│              │
  │◄── draftId + dsr_sid ───┤                              │              │
  │                         │                              │              │
  │  POST verification/send │                              │              │
  ├────────────────────────►│ validate, CAPTCHA, rate limit│              │
  │                         │ insert verification_tokens ─►│              │
  │◄── {accepted} ~0.5s ────┤ dispatch in background ──────┼─────────────►│
  │                         │                              │              │
  │  GET consume?token=…    │ atomic single-use UPDATE ───►│              │
  │◄── confirmed page ──────┤ mark draft verified          │              │
  │                         │                              │              │
  │  POST /public/submissions                              │              │
  ├────────────────────────►│ re-validate every field      │              │
  │                         │ check session verified email │              │
  │                         │ allocate ref, encrypt, insert│              │
  │                         │ start SLA clock, audit ─────►│              │
  │◄── {caseRef} ───────────┤ acknowledgement + assign ────┼─────────────►│
""")
numbered(doc, [
    "**Draft.** A session cookie (`dsr_sid`, HttpOnly, SameSite=Strict) and a draft row are created. Nothing personal is stored.",
    "**Verification send.** The address is validated, CAPTCHA checked if configured, and two rate limits consumed. A 256-bit token is generated, stored as a SHA-256 hash, and the plaintext goes only into the emailed URL.",
    "**Uniform response.** The endpoint always returns `{status:'accepted'}` after a minimum of 400 ms, whatever happened internally, so nothing can be probed. Delivery happens in the background, so a slow provider cannot stall the request.",
    "**Consume.** A single conditional UPDATE claims the token. A replay affects zero rows and gets the same generic page.",
    "**Submit.** Every field is re-validated against the stored schema; unknown fields are rejected rather than ignored. The submitted email must match the session's verified email.",
    "**Persist.** Reference allocation, encryption, field rows, status history and the SLA clock all happen in one transaction.",
    "**After.** Acknowledgement email and auto-assignment run outside the transaction and never block the response.",
])

h2(doc, "4.2 Authentication and authorisation")
code(doc, """
request ─► AuthGuard
             ├─ read dsr_int cookie
             ├─ resolveSession()  ── idle + absolute expiry, user still active
             ├─ satisfies(role, @Roles)      ← the ladder, auditor excluded
             └─ attach req.user, req.zoneCtx ─► controller ─► DbService.withContext
                                                                 └─ SET LOCAL app.current_zone
""")
para(doc, "The ladder is `zone_agent < zone_manager < admin < super_admin`. `auditor` sits "
          "outside it: it never inherits write access, and a route open to auditors does not "
          "become open to every ladder role. That subtlety is unit-tested in `auth.guard.spec.ts`.")

h2(doc, "4.3 Email dispatch")
code(doc, """
caller ─► EMAIL_PROVIDER (EmailDispatcher)
             └─ settings.get('EMAIL_PROVIDER')   ← read per call, not at boot
                  ├─ gmail   → SMTP app password (blocked here) | Gmail API over OAuth2
                  ├─ smtp    → any SMTP server
                  ├─ resend  → HTTPS API
                  ├─ graph   → Microsoft Graph over HTTPS
                  └─ console → log only, refused in production
""")
bullets(doc, [
    "Because the adapter is resolved per call, changing the provider in Settings takes effect immediately.",
    "SMTP transports pin to IPv4 and set connection, greeting and socket timeouts. Both were real production faults: a host without an IPv6 route produced `ENETUNREACH`, and an untimed socket produced a gateway timeout.",
    "`diagnoseSmtp` checks DNS, TCP, TLS and authentication separately and maps common errors to an operator-facing explanation.",
    "This host blocks outbound 25, 465 and 587 but leaves **2525** open, so a relay such as SendGrid, Brevo or Mailgun works through the Custom SMTP provider on that port. Gmail publishes no alternative port, which is why Gmail must go over the API.",
])

h3(doc, "Gmail authorisation")
code(doc, """
admin presses Connect
  ├─ POST settings/email/gmail/authorize      ← super_admin only
  │     └─ GmailOauthService.begin()
  │           ├─ state = 32 random bytes, held in memory with the origin
  │           └─ returns accounts.google.com/o/oauth2/v2/auth?...
  │                 access_type=offline  prompt=consent  scope=gmail.send
  ├─ user consents on Google
  └─ GET internal/admin/settings/email/gmail/callback?code&state   ← unauthenticated
        ├─ state looked up and consumed (single use)
        ├─ code exchanged for a refresh token
        ├─ GMAIL_OAUTH_REFRESH_TOKEN stored encrypted
        ├─ GMAIL_AUTH=oauth2, EMAIL_PROVIDER=gmail
        └─ GMAIL_USER filled from the Gmail profile API
""")
bullets(doc, [
    "The callback route cannot require a session, because Google redirects the browser to it from a different origin. `state` is what ties the callback back to the administrator who started it, and it is consumed on first use.",
    "The pending state lives in memory rather than in the session cookie, because that cookie is `SameSite=Strict` and is therefore not sent on Google's cross-site redirect.",
    "The redirect URI is derived from `PORTAL_INTERNAL_URL` and shown on the Settings screen with a copy button, so it matches what is registered in Google Cloud byte for byte.",
])

h2(doc, "4.4 The SLA engine")
code(doc, """
@Interval(1h) ─► recomputeAll()
                  ├─ pg_try_advisory_xact_lock  ← only one instance proceeds
                  ├─ running clocks past due    → state=breached, case=overdue
                  └─ per clock: elapsed / total → fire unfired reminder thresholds
""")
bullets(doc, [
    "Idempotent by construction: fired thresholds are recorded, so a reminder is never sent twice.",
    "A send failure does not mark the threshold fired, so the next sweep retries it.",
    "`Overdue` is only ever set here, never by a user.",
    "Pause records the moment; resume adds the paused duration to the due date so no time is lost or gained.",
])

h2(doc, "4.5 Publishing a form")
code(doc, """
builder ─► PUT /internal/forms/:key
             ├─ zone check (a zone manager may only touch their own)
             ├─ merge onto the current schema, key and zone pinned
             ├─ validateSchema()  ── types, unique keys, labels, options,
             │                       and the mandatory 'email' field
             ├─ INSERT form_versions (version = max + 1)
             └─ audit form.published
public form ─► GET /public/forms/:key   ← always the newest version
existing case ─► rendered against cases.form_version  ← unchanged
""")
callout(doc, "note",
        "This is why the public SPA reads schemas from the API rather than the static files in "
        "`form-schema/`. Those files are only the import seed.")

h2(doc, "4.6 Settings resolution")
code(doc, """
SettingsService.get(key)
   ├─ in-memory cache  ← app_settings, refreshed on write and every 60s
   ├─ process env
   └─ catalog default
""")
para(doc, "Reads are synchronous so the service is a drop-in replacement for `ConfigService`. "
          "Secrets are encrypted on write and never returned to the client; the API reports only "
          "whether one is set and where the effective value comes from.")

page_break(doc)

# ================================================================= 5. api
h1(doc, "5. HTTP API reference")
para(doc, f"{len(ROUTES)} endpoints. Everything under `/public/` is unauthenticated by design; "
          "everything under `/internal/` requires a session cookie and, where shown, a role.")

public = [r for r in ROUTES if r["path"].startswith("/public")]
internal = [r for r in ROUTES if r["path"].startswith("/internal")]

h2(doc, "5.1 Public endpoints")
table(doc, ["Method", "Path", "Purpose"], [
    [r["method"], f"`{r['path']}`", d] for r, d in zip(public, [
        "Form manifest for the public picker",
        "One form schema, newest published version",
        "Start a draft session",
        "Request a verification email (uniform response)",
        "Consume a magic link",
        "Poll whether this session is verified",
        "Submit a verified request",
    ])
], widths=[0.8, 2.8, 2.8])

h2(doc, "5.2 Internal endpoints")
table(doc, ["Method", "Path", "Roles"],
      [[r["method"], f"`{r['path']}`", r["roles"]] for r in internal],
      widths=[0.8, 3.2, 2.4])

page_break(doc)

# ============================================================== 6. frontend
h1(doc, "6. Front-end notes")

h2(doc, "6.1 Theming")
para(doc, "Tailwind v4 `@theme` maps each `--color-*` utility onto a `--t-*` variable that is "
          "redefined per theme. Utilities such as `bg-surface` therefore follow the active theme "
          "with no `dark:` variants anywhere in the components.")
code(doc, """
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme { --color-surface: var(--t-surface); }
:root            { --t-surface: #ffffff; }
[data-theme=dark]{ --t-surface: #0d0d0d; }
""")
para(doc, "A blocking inline script in `index.html` stamps `data-theme` before React mounts, "
          "which is what prevents a flash of the wrong palette.")

h2(doc, "6.2 The form builder")
figure(doc, "form-editor-dark", "The builder in dark appearance")
bullets(doc, [
    "`formTree.ts` holds pure functions over the component tree. Every node is addressed by a **path** of segments, because components nest through both `components` and `columns[].components`.",
    "All mutations clone before editing, so React state updates stay predictable.",
    "Field keys are made unique on insert; the server validates uniqueness again on publish.",
    "The palette comes from the API, so the builder can never offer a type the renderer cannot draw.",
])

h2(doc, "6.3 Fidelity of the public replica")
bullets(doc, [
    "The renderer emits the source platform's own class names, so its vendored stylesheets apply unchanged.",
    "Hidden components stay mounted with `visibility:hidden;position:absolute`, matching the original DOM.",
    "Tailwind's preflight is neutralised inside `.c-dsp-form-page`, and Tailwind's `.flex` is overridden there because it collides with the vendored grid class of the same name.",
    "`tools/capture.mjs` and `tools/compare.mjs` screenshot the live original and the replica for side-by-side comparison.",
])

page_break(doc)

# ============================================================== 7. delivery
h1(doc, "7. Build, test and deploy")

h2(doc, "7.1 Local development")
code(doc, """
cd server && node scripts/dev-db.mjs         # embedded PostgreSQL on :5433
DATABASE_URL=postgres://dsr:dsr@127.0.0.1:5433/dsr node scripts/migrate.mjs
node scripts/import-forms.mjs                # seed the 12 form schemas
node scripts/seed-templates.mjs              # seed the template library
node scripts/create-user.mjs you@co.com "You" super_admin "" "AStrongPassw0rd!"

npm run build && EMAIL_PROVIDER=console node dist/main.js

cd apps/public-form && npm run dev           # :5180
cd apps/admin       && npm run dev           # :5181
""")

h2(doc, "7.2 Test suites")
table(doc, ["Command", "Covers"], [
    ["`node scripts/rls-check.mjs`", "Cross-zone IDOR at the database layer, fail-closed context, append-only audit"],
    ["`node scripts/e2e-intake.mjs`", "The whole verification flow, replay, uniform responses, rate limits, encryption at rest"],
    ["`node scripts/e2e-auth.mjs`", "Sign in, session revocation, RBAC, cross-zone IDOR through the API"],
    ["`node scripts/e2e-workflow.mjs`", "Transition matrix, system-only Overdue, extension and closure rules, SLA breach sweep"],
    ["`node scripts/e2e-settings.mjs`", "Settings round trip, secret masking, validation, provider hot-swap, diagnostics"],
    ["`npx jest`", "Template rendering and the role ladder"],
    ["`node deploy/smoke.mjs`", "Production smoke: headers, auth, settings, public surface"],
], widths=[2.3, 4.1])
callout(doc, "note",
        "`e2e-workflow` needs an open case; run `e2e-intake` first. Both are safe to re-run.")

h2(doc, "7.3 Deployment")
code(doc, """
bash deploy/deploy.sh
  ├─ build server, admin, public-form
  ├─ tar-over-ssh to /opt/dsr and /var/www/dsr      (rsync is absent on Windows)
  ├─ write /opt/dsr/server/.env, chmod 600
  ├─ npm ci --omit=dev
  ├─ node scripts/migrate.mjs                        (tracked in schema_migrations)
  ├─ node scripts/import-forms.mjs
  ├─ install systemd unit + nginx site, nginx -t
  ├─ re-apply TLS if a certificate exists   (certbot install --nginx --redirect)
  └─ restart dsr-api, reload nginx, health check
""")
callout(doc, "warn",
        "The nginx config in the repo is HTTP-only. Pushing it overwrites certbot's TLS server "
        "blocks, which is why `deploy.sh` re-runs `certbot install` on every release. Removing "
        "that step silently drops the site back to plain HTTP.")
table(doc, ["File", "Purpose"], [
    ["`deploy/provision.sh`", "One-time host setup: swap, Node 22, PostgreSQL, nginx, firewall"],
    ["`deploy/setup-db.sh`", "Creates the `dsr` owner and the restricted `dsr_app` role"],
    ["`deploy/deploy.sh`", "The repeatable release"],
    ["`deploy/nginx.conf`", "Routing, security headers, CSP, rate limits"],
    ["`deploy/dsr-api.service`", "systemd unit with filesystem hardening"],
    ["`deploy/enable-tls.sh`", "Let's Encrypt for a real domain name"],
    ["`deploy/enable-tls-ip.sh`", "Let's Encrypt for a host with no domain, via sslip.io wildcard DNS"],
    ["`deploy/.secrets.env`", "Generated secrets. chmod 600, never committed"],
], widths=[2.0, 4.4])

callout(doc, "warn",
        "nginx `add_header` inside a `location` block **discards** inherited headers. Every "
        "location that adds one must restate the full baseline. This bit us once already.")

page_break(doc)

# ============================================================ 8. operations
h1(doc, "8. Operations")

h2(doc, "8.1 Everyday commands")
code(doc, """
systemctl status dsr-api
journalctl -u dsr-api -f
journalctl -u dsr-api -f | grep -i verification     # email delivery problems

sudo -u postgres psql dsr                          # database shell
node deploy/smoke.mjs                              # verify a release
""")

h2(doc, "8.2 Known constraints on the current host")
bullets(doc, [
    "**Outbound SMTP is blocked on 25, 465 and 587**, so Gmail app passwords can never work here. Port **2525** is open, so a relay works through the Custom SMTP provider. Resend, Gmail over OAuth2 and Microsoft Graph all send over HTTPS and are unaffected.",
    "**TLS is in place** for `203-0-113-10.sslip.io`, issued by Let's Encrypt and renewed by `certbot.timer`. `COOKIE_SECURE` defaults to `true`. sslip.io resolves any dashed IP in its name back to that IP, which is how a certificate is possible without owning a domain. Moving to a real domain means re-running `deploy/enable-tls.sh` and updating `PORTAL_*_URL`.",
    "**One vCPU and 2 GB.** A 2 GB swap file is configured and the API is capped at a 384 MB heap.",
])

h2(doc, "8.3 Extending the system")
h3(doc, "Add a setting")
para(doc, "Append an entry to `SETTINGS` in `settings.catalog.ts`. The API, the validation and "
          "the Settings screen all pick it up; nothing else needs touching. Mark it `secret: true` "
          "to have it encrypted and masked.")

h3(doc, "Add an email provider")
numbered(doc, [
    "Implement `EmailProvider` in a new file under `server/src/email/`.",
    "Register it in `email.module.ts` and add a case to `EmailDispatcher.active()`.",
    "Add the provider option and its credential fields to the settings catalog.",
    "If it speaks SMTP, reuse `createSmtpTransport` so it inherits the IPv4 pinning and timeouts.",
])

h3(doc, "Add a form field type")
numbered(doc, [
    "Add the type to `FIELD_TYPES` in `forms.service.ts` so publication accepts it.",
    "Add it to the palette in `forms.controller.ts`.",
    "Render it in the public `FieldRenderer.tsx`, and validate it in both `form-validation.ts` and the client `validation.ts`.",
    "Add it to `TYPE_LABEL` and `TYPE_ICON` in `formTree.ts` so the builder labels it.",
])

h3(doc, "Add a role")
numbered(doc, [
    "Add it to the `SessionUser` union and to `RANK` in `auth.guard.ts`, or leave it off the ladder if it should not inherit.",
    "Extend `auth.guard.spec.ts` first; the ladder is security-critical and the tests are the specification.",
    "Add it to `ROLES` in `admin-users.controller.ts` and to the console's nav guards.",
])

h2(doc, "8.4 Outstanding work")
table(doc, ["Item", "Notes"], [
    ["Attachment upload endpoint", "Schema and storage-key model exist; needs object storage and virus scanning"],
    ["Escalation emails", "Configuration fields exist; the sweep hook is not wired"],
    ["Full-text case search", "List filters exist; no cross-field search yet"],
    ["Retention and purge job", "Per-zone retention with a documented legal-hold override"],
    ["Single sign-on and MFA", "The user model is OIDC-shaped; only break-glass credentials today"],
    ["Real SLA matrix", "Shipped values are placeholders pending Legal sign-off"],
], widths=[2.0, 4.4])

out = ROOT / "docs" / "DSR Portal - Developer Handbook.docx"
doc.save(out)
print(f"written: {out}")
