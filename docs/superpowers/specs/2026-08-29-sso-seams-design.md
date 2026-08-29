# SSO seams: an identity table, a strategy split, and a dormant break-glass rule

Status: approved for planning
Date: 2026-08-29
Sub-project 2b of 5 (email → RBAC hardening → **SSO seams** → scale hardening → RHEL deployer)

## Context

Sub-project 2a moved authorization onto named permissions and enforced a role
matrix in Postgres. Authentication was left alone, and it has one shape problem:
`AuthService.login()` does two unrelated jobs in a single method. It finds a user
and verifies an argon2 hash — the part that knows about passwords — and then
mints a session row, writes an audit entry and returns a `SessionUser` — the part
that would be identical for any authentication method.

Everything downstream is already provider-agnostic. `resolveSession` takes an
opaque session id and knows nothing about how it was obtained; `users.password_hash`
is nullable; `is_break_glass` has existed since migration 0002. The only thing
standing between this portal and an external identity provider is that the one
method which could accept a different kind of credential has the password check
welded into it.

This sub-project does not wire an identity provider. It creates the table an IdP
will write to, splits the method so a second strategy has somewhere to attach, and
writes the break-glass rule that decides who may still use a password once SSO is
live — with that rule dormant until a flag says otherwise.

## Scope

In scope: the `auth_identities` table and its RLS policies, the strategy split
inside `AuthService`, the `canUsePassword` policy function, and the `SSO_ENABLED`
setting that keeps it dormant.

Out of scope: any identity provider, OIDC, group-to-role mapping, JIT
provisioning, and any admin UI. Also deliberately out of scope, with reasons
given below: restricting password *reset* while SSO is enabled.

## Architecture

### The split

`AuthService.login()` becomes three steps rather than one method:

```ts
// The strategy. The only code that knows a password exists.
PasswordStrategy.authenticate(email, password, ip): Promise<AuthenticatedIdentity | null>

// Provider-agnostic. Mints the session, audits the success, returns SessionUser.
AuthService.startSession(identity, ip, via): Promise<{ sessionId: string; user: SessionUser }>
```

`login()` then reads: apply the break-glass rule, call the strategy, call
`startSession`. When an Entra strategy arrives it calls the same `startSession`,
so there is one place that creates a session and one place that records a
successful sign-in — rather than two implementations that drift.

**No strategy registry.** One interface, one implementation. A registry holding a
single entry is a guess about the shape of the second one, and adding it later is
a switch statement. The seam that matters is `startSession` being callable by
something that is not the password path.

The timing-oracle defence stays inside `PasswordStrategy`: an unknown user is
still verified against a dummy hash so a failed lookup and a wrong password take
the same time. That behaviour belongs to the password strategy specifically and
moves with it.

### `auth_identities`

```sql
id           uuid primary key default gen_random_uuid()
user_id      uuid not null references users(id)
provider     text not null
subject      text not null
created_at   timestamptz not null default now()
last_login_at timestamptz
unique (provider, subject)
index on (user_id)
```

`subject` is the IdP's stable identifier for the account — the `sub` claim, not
an email address, which changes. `UNIQUE(provider, subject)` is what stops two
portal users claiming one external identity.

Nothing else is stored. No claims, no tokens, no cached group membership. Those
are identity-provider state that goes stale the moment it is written, and a
cached copy invites being treated as authoritative by code that should have asked
the provider. This system holds identity documents; the less it retains about
people, the smaller the thing that can leak.

**The table joins the role matrix.** Sub-project 2a put fourteen tables under
role-aware RLS. Adding a fifteenth immediately afterwards and leaving it outside
would be where that matrix starts to decay. `auth_identities` has no zone column,
so it takes the `app_settings` shape:

```sql
USING (true)
WITH CHECK (app_role_may_write(ARRAY['system','super_admin']))
```

plus the `AS RESTRICTIVE FOR DELETE` companion that 2a established, because a
`FOR ALL` policy's `WITH CHECK` does not govern `DELETE`. Identity links are
written by the sign-in path under `system()` and, later, unlinked by a super
admin. No other role has any business writing them.

### The break-glass rule, dormant by construction

A new `SSO_ENABLED` setting: `envOnly`, `type: 'boolean'`, default `'false'`, in
the `security` group. `envOnly` means the database cannot shadow it and the
settings API refuses to write it — the same mechanism sub-project 1 built for the
mail configuration.

**It must be read as `settings.get<string>('SSO_ENABLED', 'false') === 'true'`,
never for truthiness.** `SettingsService.get()` returns a string, and the string
`'false'` is truthy in JavaScript — so `if (settings.get('SSO_ENABLED'))` would
enable enforcement precisely when the setting says not to, locking every
non-super-admin out of a portal with no identity provider. This is the single
most dangerous line in the sub-project and the spec names it deliberately.

Two facts about being the first boolean setting: `'boolean'` is a declared
`SettingType` but no catalog entry has ever used it, so `SettingsService.validate()`
has no boolean branch and the admin SPA's rendering of that type is unexercised.
Neither matters here — an `envOnly` key is rejected by `updateMany()` before
`validate()` runs, and the SPA renders `envOnly` fields read-only — but a later
sub-project adding a *writable* boolean will need to close both gaps.

```ts
canUsePassword(user: { role: Role; isBreakGlass: boolean }, ssoEnabled: boolean): string | null
```

Returns `null` when password authentication is permitted, otherwise the reason.

- `ssoEnabled === false` → always `null`. **This is today's behaviour, unchanged,
  for every user.**
- `ssoEnabled === true` → `null` only for `super_admin`, or for any user flagged
  `is_break_glass`. Everyone else is refused, with an `auth.login_refused_sso`
  audit row recording who tried.

Dormancy is the whole design here. Enforcement written without the flag would
lock every non-super-admin out of a portal that has no identity provider to let
them back in. The flag makes the dangerous state unreachable until someone
deliberately sets it, and makes both states testable now.

`login()` must begin selecting `is_break_glass`. It does not today, which is why
that column has been inert since migration 0002 — set by `create-user.mjs`,
displayed by the Team page, and read by nothing that makes a decision.

## Testing

`break-glass.spec.ts`, table-driven across role × `is_break_glass` ×
`SSO_ENABLED`, following the pure-function convention this codebase uses
throughout — no Nest `TestingModule`.

The flag-off half of that table is the important half: it is a regression guard
proving that nobody's ability to sign in changes today. The flag-on half
documents what will happen when someone flips it, before they flip it on a live
system.

`AuthService` stays database-bound and keeps its existing coverage. The split is
verified by the build and by `startSession` having exactly one caller now and a
second one later.

## Verification

```bash
npm --prefix server test                      # the break-glass matrix
npm --prefix server run build
node server/scripts/migrate.mjs               # applies 0014

# the table is under the role matrix like everything else
psql -c "BEGIN; SELECT set_config('app.current_role','admin',true),
                       set_config('app.current_zone','*',true);
         INSERT INTO auth_identities (user_id, provider, subject)
           VALUES ((SELECT id FROM users LIMIT 1),'probe','x'); ROLLBACK;"
# expected: new row violates row-level security policy

# and password login is untouched while the flag is off
grep -n "SSO_ENABLED" server/.env.example     # documented, default false
```

Manual, on a real box: sign in as each role with `SSO_ENABLED` unset and confirm
nothing changed. That is the only check that matters before this ships, because
the entire risk of this sub-project is that a dormant rule turns out not to be
dormant.

## What this deliberately leaves undone

**Password reset stays available to everyone.** With `SSO_ENABLED=true` an
administrator can still reset a password for a user who cannot use one. Blocking
it means touching `resetPasswordFor` and `changeOwnPassword`, and a wrong guess
there removes someone's account-recovery path. The SSO sub-project should decide
it against a real tenant, where the consequences of both choices are visible.

**No `/me` change and no admin UI.** `auth_identities` will be empty until an
identity provider writes to it, so there is nothing to display. A screen built
against imagined data is a screen rebuilt when the data arrives.
