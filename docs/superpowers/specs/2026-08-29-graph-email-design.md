# Graph-only email, configured from the environment

Status: approved for planning
Date: 2026-08-29
Sub-project 1 of 4 (email → RBAC/SSO seams → scale hardening → RHEL deployer)

## Context

The portal ships five email adapters: Gmail, Microsoft Graph, SMTP, Resend and a
console stub for development. Gmail is the default and carries the most weight —
two authentication modes, an OAuth consent flow with its own controller and
callback route, and the `googleapis` metapackage, which costs roughly 208 MB of
`node_modules` on a box that has already run out of disk once.

Microsoft Graph is the provider this deployment will actually use. Its adapter is
already complete: client-credentials token with a five-minute refresh margin,
`sendMail` as a shared mailbox, file attachments, and a `verifyConnection` that
proves the mailbox is reachable. Nothing about it needs rewriting.

What is wrong is everything around it. Provider choice is runtime-mutable state in
the `app_settings` table, so the effective configuration of a system that emails
data subjects about their identity documents depends on a database row rather than
on the file an operator can read on the server. Credentials can be entered through
a browser. A missing Graph key produces no failure until the first data-subject
email silently fails to send. And three code paths still assume Gmail regardless of
which adapter is active.

The goal: Graph and console are the only adapters, Graph is configured entirely
from the environment file, a missing key stops the service at boot rather than at
first send, and an operator can confirm the whole path over SSH with one command.

## Scope

In scope: adapter removal, environment-only configuration for the email group,
boot-time validation, a confirmation CLI, the six `email_log.provider` write sites,
and the Gmail fallback in the report from-address.

Out of scope: the RBAC and SSO work, scale hardening, and the RHEL deployment
script. Each is a later sub-project with its own spec. This spec does define the
`EMAIL_PROVIDER` and `GRAPH_*` keys that the deployer will later write.

## Architecture

`EmailDispatcher` in `server/src/email/email.module.ts` stays. It is the correct
seam — one resolver, adapters behind the `EmailProvider` interface — and keeping it
means a future provider is still one file plus one switch arm. What changes is that
`activeName()` resolves from configuration a browser cannot write.

`SettingsService` gains an `envOnly` flag on catalog entries:

- `get()` skips the database cache for a flagged key and resolves env → catalog
  default. A stale `app_settings` row cannot shadow the env file.
- `update()` rejects a flagged key with 400 and an explanatory message.
- `describeAll()` reports source `environment`, `default` or `unset`, never
  `database`.

One settings system rather than a second configuration path for email. The flag is
deliberately generic: later sub-projects reuse it for SSO client secrets.

## Configuration contract

`/etc/dsr/dsr-api.env`, mode 0640, owner `root:dsr`:

```
EMAIL_PROVIDER=graph
EMAIL_FROM_NAME=Privacy Team
PRIVACY_MAILBOX=privacy@company.com
GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=
```

`EMAIL_PROVIDER` accepts `graph` or `console`. The existing production guard on the
console adapter is unchanged: in production it throws unless `ALLOW_CONSOLE_EMAIL`
is `true`.

### Boot-time validation

A new `validateEmailConfig()` in `server/src/email/email-config.ts` runs in
`main.ts` before `app.listen()`. When `EMAIL_PROVIDER=graph`, all four of
`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and `PRIVACY_MAILBOX`
must be non-empty. On failure it logs every missing key by name, names the env file
path, and exits non-zero.

Failing at boot is the point. systemd reports a service that refused to start, and
an operator sees the reason in `journalctl` within seconds. The current behaviour
is a service that starts healthy and drops the first verification email a data
subject is waiting on.

Validation reads through `SettingsService` so `envOnly` resolution is exercised on
the same path the adapter uses at runtime.

## Confirmation path

`server/scripts/verify-email.mjs`, following the existing `server/scripts/*.mjs`
convention (`migrate.mjs`, `import-forms.mjs`, `create-user.mjs`):

```bash
node server/scripts/verify-email.mjs
node server/scripts/verify-email.mjs --send someone@company.com
```

Four checks, each reported pass or fail with the reason, stopping at the first
failure and exiting non-zero:

1. All required keys present, read from the same env file systemd uses.
2. DNS and TCP to `login.microsoftonline.com` on 443.
3. Client-credentials token request succeeds.
4. `GET /users/{PRIVACY_MAILBOX}` returns the mailbox.

Step 4 earns its place. A token proves the app registration and secret are valid;
it says nothing about whether `Mail.Send` was granted admin consent, or whether the
application access policy actually scopes to this mailbox. Step 4 separates
"credentials are right" from "this will send mail", and those two failures need
different fixes.

`--send` adds a real `sendMail` to the given address. The non-zero exit lets the
deployment script gate a release on a working mail path.

## Removals

Deleted:

| File | Lines |
|---|---|
| `server/src/email/gmail.provider.ts` | 211 |
| `server/src/settings/gmail-oauth.service.ts` | 149 |
| `server/src/settings/gmail-callback.controller.ts` | 74 |
| `server/src/email/smtp.provider.ts` | 114 |
| `server/src/email/resend.provider.ts` | 115 |
| `server/src/email/smtp.ts` | 228 (110 extracted first) |
| `server/scripts/gmail-oauth.mjs` | — |

Dependencies dropped from `server/package.json`: `googleapis`, `nodemailer`,
`@types/nodemailer`.

### Extraction before deletion

`smtp.ts` exports `diagnoseHttpsEndpoint` and the `DiagnosticStep` type, both used
by `EmailDispatcher.diagnose()` on the Graph path. Move to a new
`server/src/email/net-diagnostics.ts`: `DiagnosticStep`, `timed`, `tcpProbe`,
`explain` reduced to the transport-level cases (`ENOTFOUND`, `ECONNREFUSED`,
`ETIMEDOUT`, `EHOSTUNREACH`, certificate errors), a `NET_TIMEOUTS` constant, and
`diagnoseHttpsEndpoint` itself. Roughly 110 lines kept of 228. Do this first, as a
separate commit, so the deletion that follows is mechanical.

`EmailDispatcher.diagnose()` then collapses: no SMTP branch, no Gmail app-password
branch, no host lookup table. Graph resolves to `graph.microsoft.com`; console
returns null.

### Other edits

- `settings.catalog.ts`: remove the six `GMAIL_*` keys and the six `smtp`/`resend`
  keys; `EMAIL_PROVIDER` options reduce to `graph` and `console`, default `graph`;
  remaining email keys gain `envOnly: true`.
- `settings.module.ts`: drop `GmailCallbackController` and `GmailOauthService`.
- `settings.controller.ts`: drop `email/gmail/authorize` and
  `email/gmail/redirect-uri`. Keep `email/verify`, `email/diagnose` and
  `email/test-send`, all already `@Roles('super_admin')` — they become a read-only
  Email health panel giving the same confirmation as the CLI from a browser,
  without exposing configuration.
- `apps/admin/src/pages/SettingsPage.tsx`: remove the Gmail branch; render
  `envOnly` keys read-only with their source badge.
- `deploy/deploy.sh`: remove `ADMIN_API_TOKEN`, which no server code reads.
- Updated: `server/.env.example`, `README.md`, `docs/build_dev_handbook.py`,
  `docs/build_user_guide.py`, `deploy/smoke.mjs`, `server/scripts/e2e-settings.mjs`.

## Bugs fixed

### `email_log.provider` never records the real adapter

`email_log.provider` is `text NOT NULL` (`schema.ts:321`), but no write path fills
it with the provider that actually sent the message:

- `public/intake.service.ts:294` — literal `'gmail'`
- `cases/assignment.service.ts:289,304,341,356` — literal `'active'`
- `cases/outbound.service.ts:302` — literal `'active'`

Six sites, none correct. `settings.controller.ts:111` is the only caller that
already resolves `EmailDispatcher.activeName()`, and it does so for a template
variable rather than a log row.

All six take their value from `activeName()`. The email log is audit evidence for
a regulated process; a column that records `'active'` for every message cannot
answer "which system sent this", which is exactly what it exists to answer.

### Gmail fallback for the report from-address

`cases/report.service.ts:361` resolves `PRIVACY_MAILBOX` and falls back to
`GMAIL_USER`, then to `privacy@example.com`. With `GMAIL_USER` deleted from the
catalog the fallback becomes dead; the remaining literal would send a report from
a non-existent example.com address. Replaced by a single `PRIVACY_MAILBOX` read,
which boot validation now guarantees is set.

### Not a bug

`email/system-template.service.ts:174` also contains `provider: 'gmail'`, but it is
sample data for the template preview screen, not a log write. It changes to
`'graph'` for accuracy of the preview and nothing more.

## Testing

Unit:

- `email-config.spec.ts` — table-driven over each missing key and each combination,
  asserting the named key appears in the error. Provider `console` passes with no
  Graph keys set.
- `settings.service.spec.ts` — an `envOnly` key with both a database row and an env
  value resolves to the env value; `update()` on that key rejects; `describeAll()`
  never reports source `database` for it.
- `email.module.spec.ts` — dispatcher resolves `graph` and `console`, and throws a
  named error for any other value.
- `templates.spec.ts` — unchanged, must stay green.

Integration: `verify-email.mjs` against a wrong tenant id fails at step 3, not step
4; against a valid tenant with a mailbox outside the access policy it fails at step
4. These are the two failures operators will actually hit, and the script is only
worth having if it tells them apart.

Manual: one `--send` to a real inbox; confirm the `email_log` row records provider
`graph`.

Regression: `node deploy/smoke.mjs` passes with its Gmail assertions updated.

## Verification

On a machine with the service installed:

```bash
node server/scripts/verify-email.mjs                     # 4 checks pass
node server/scripts/verify-email.mjs --send you@co.com   # mail arrives

# boot validation actually stops the service
sudo sed -i 's/^GRAPH_CLIENT_SECRET=.*/GRAPH_CLIENT_SECRET=/' /etc/dsr/dsr-api.env
sudo systemctl restart dsr-api                           # expected to fail
journalctl -u dsr-api -n 20                              # names the missing key
# restore the secret, restart, confirm healthy

# env wins over a stale database row
psql -c "INSERT INTO app_settings (key, value) VALUES ('EMAIL_PROVIDER','console')
         ON CONFLICT (key) DO UPDATE SET value = 'console'"
sudo systemctl restart dsr-api
# /internal/settings needs a super_admin cookie, so read the resolved value
# from the CLI, which uses the same SettingsService path:
node server/scripts/verify-email.mjs        # reports provider graph, not console

grep -rn "googleapis\|nodemailer" server/package.json              # no matches
npm --prefix server ci && npm --prefix server run build            # clean
```
