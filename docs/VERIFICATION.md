# What still needs a database

Five sub-projects were built without a reachable Postgres — Graph email, RBAC
hardening, SSO seams, scale hardening, and the RHEL deployer — plus a
`db.system()` audit afterwards. Everything here compiles, and its test suites
are green, but every claim that depends on the database was **reasoned from
the policy SQL rather than executed**.

This file is the list of what that leaves outstanding, in the order to do it.
It is not a deployment guide; `deploy/README-rhel.md` is that.

## 1. Apply the migrations

```bash
node server/scripts/migrate.mjs          # applies 0013 through 0018
```

Six are pending. None has been applied anywhere.

| Migration | What it does | What a failure means |
|---|---|---|
| `0013_role-matrix` | Role-aware RLS across fourteen tables, `app_role_may_write()`, and an `AS RESTRICTIVE FOR DELETE` companion on each | The entire RBAC sub-project is inert — the app enforces permissions, the database does not |
| `0014_auth-identities` | The table an identity provider will write to, inside the role matrix | The SSO seams have nowhere to attach |
| `0015_scale-indexes` | `cases (created_at DESC, id DESC)`, `case_fields (case_id, field_key)`, partial `cases (due_at) WHERE status <> 'closed'`, `audit_log (created_at DESC, id DESC)` | Every case-list page sorts the whole table |
| `0016_verification-tokens-rls` | Restricts writes and deletes on `verification_tokens` to `system` | **Highest risk.** Could stop data subjects verifying their email |
| `0017_form-drafts-rls` | Restricts reads *and* writes on `form_drafts` to `system` | Could stop draft creation and public attachment uploads |
| `0018_verification-tokens-zone` | Adds `zone_id`, backfills it from `form_versions`, scopes reads to it | The backfill may leave NULLs; see the check below |

### A trap in `0015`, worth checking before you migrate anything

`migrate.mjs` records applied migrations **by filename, with no content hash**,
and `0015` was amended after it was first written. It has never been applied
anywhere, so this is safe today. But if any environment ever ran the earlier
version, that filename is already marked done — the file becomes permanently
unrunnable there, and `cases_created_ix` stays single-column with nothing
reporting a problem.

```sql
SELECT * FROM schema_migrations ORDER BY 1;   -- before migrating an unfamiliar box
```

If `0015` appears, drop `cases_created_ix` and apply its statements by hand.

## 2. Verify, immediately

### The public form, end to end — do this first

`0016` and `0017` restrict the tables the intake flow writes to. Every write
path was traced and all six run under `db.system()`, which the policies permit
— but that is reasoning, not evidence.

1. Open a public intake form and request a verification link.
2. Click the link. The draft should convert to a case.
3. Upload an attachment to a draft.

If verification breaks, this restores the previous behaviour immediately:

```sql
DROP POLICY IF EXISTS verification_tokens_role ON verification_tokens;
DROP POLICY IF EXISTS verification_tokens_delete_role ON verification_tokens;
ALTER TABLE verification_tokens DISABLE ROW LEVEL SECURITY;
-- and the same three for form_drafts
```

### Then the scripted checks

```bash
node server/scripts/rls-check.mjs --roles                     # the role matrix bites
DATABASE_URL_APP=... node server/scripts/explain-check.mjs    # index scans, not seq scans
node deploy/smoke.mjs                                         # black-box HTTPS surface
```

`explain-check.mjs` must be run as `dsr_app`, not the owner: the owner bypasses
row-level security, so plans taken as `dsr` omit the `app_zone_allows()`
qualifier the whole index argument is about.

### Three spot checks

```sql
-- 0018's backfill: a form withdrawn mid-flight legitimately leaves NULL,
-- a large count means the form_key -> zone lookup is not matching.
SELECT count(*) FROM verification_tokens WHERE zone_id IS NULL;

-- 0015 as amended: this must name two columns, not one.
SELECT indexdef FROM pg_indexes WHERE indexname = 'cases_created_ix';

-- 0013: fourteen tables plus the three added since.
SELECT tablename FROM pg_tables t
 WHERE rowsecurity AND schemaname = 'public' ORDER BY 1;
```

And open a zone manager's report. **"Emails verified today" should show a
plausible number.** Zero means `0018`'s read policy is too tight and the
backfill did not populate their zone.

## 3. What only a live database can settle

- **The streaming CSV exports.** Batch-boundary continuity, the keyset cursor
  where rows share a `created_at`, real-socket backpressure, and whether a
  cancelled download aborts cleanly. Unit-tested against fakes; never against
  a socket.
- **Whether the indexes are used at all.** `explain-check.mjs` is the entire
  evidentiary basis for the scale sub-project and has never run.
- **`statement_timeout` killing a runaway query**, and the pool bounds
  behaving under real concurrency.
- **The 45 remaining `db.system()` call sites.** They were classified by
  reading: 24 are pre-authentication, nine are scheduled jobs with no acting
  user, and the rest carry written justifications. Only a live box shows
  whether a caller's own context would have sufficed.
- **`SlaService.recomputeAll`** holds one connection and an open transaction
  across N outbound Graph HTTPS calls. `statement_timeout` bounds statements,
  not transactions, so this is the one place a connection can still be held
  indefinitely. Self-limiting via its advisory lock; never observed under load.

## 4. Do not run these against production

`server/scripts/e2e-*.mjs` overwrite rows in `app_settings` while exercising
email-provider hot-swap, which would wipe real configuration. `smoke.mjs` is
the read-only one and the only one safe to point at a live portal.

## 5. Needs a RHEL host rather than a database

`deploy/dsr_deploy.py` has never run against a server — not `provision`, not
`deploy`, not `doctor`. `deploy/README-rhel.md` is the runbook.

The check worth doing deliberately, once the portal is healthy:

```bash
setsebool -P httpd_can_network_connect off
# confirm the portal now 502s
python3 deploy/dsr_deploy.py doctor
# confirm it names httpd_can_network_connect and prints the setsebool fix
setsebool -P httpd_can_network_connect on
```

A diagnostic that has never been shown to catch the fault it was written for
is one nobody should trust.

## 6. Housekeeping the owner still has to do

- Purge orphaned `GMAIL_*`, `SMTP_*` and `RESEND_API_KEY` rows from
  `app_settings`, left behind when the mail providers were dropped.
- Delete the dead `ADMIN_API_TOKEN` lines from `deploy/.secrets*.env`.
