# RBAC hardening: named permissions and a real role matrix in the database

Status: approved for planning
Date: 2026-08-29
Sub-project 2a of 5 (email → **RBAC hardening** → SSO seams → scale hardening → RHEL deployer)

## Context

Authorization in this portal is expressed as role literals scattered through the
code. Roughly 35 `@Roles('admin', 'zone_manager')` decorators across nine
controllers decide who may call what, and a privilege ladder in
`auth/auth.guard.ts` lets a higher role satisfy a lower requirement. The ladder
needs an explicit exception — `auditor` must never inherit, because it is a
read-only lane — and that exception is 25 lines of subtle code that a reader has
to hold in their head to know whether any given route is safe.

Beneath that, zone isolation is enforced properly: every query runs through
`DbService.withContext()`, which opens a transaction and sets
`app.current_zone`, and Postgres row-level security keys on it. That part works.

Role isolation at the database does not exist. `app.current_role` is set on every
transaction and **no policy reads it**. Worse, `DbService.system()` — which
hardcodes `role: 'system', zone: '*'` — is used at more than sixty call sites
across eighteen files, including the entire administrative surface. Every write
to `users`, `form_versions`, `sla_policies`, `system_templates` and
`app_settings` currently declares itself fully privileged before it reaches the
database.

So a bug in a controller guard is the only thing standing between an auditor and
a write. For a system holding identity documents on behalf of data subjects,
that single layer is thin.

This sub-project replaces the role literals with named permissions, extracts the
duplicated user-administration rules into one tested function, and makes
`app.current_role` load-bearing by writing a role matrix into RLS across
fourteen tables — including moving the administrative writes off `system()` so
those policies are actually reachable.

## Scope

In scope: the permission layer, the `canAssignRole` policy function, the RLS role
matrix, the `db.system()` migration for the administrative surface, and passing
`super_admin` through to the database context.

Out of scope: SSO. `auth_identities`, the login strategy seam and break-glass
policy are sub-project 2b, which depends on the permission layer this one builds
but not on its RLS work. Also out of scope: a full audit of all sixty `system()`
call sites. This spec moves the ~20 that gate administrative tables and leaves
the rest, each documented, for the scale-hardening sub-project.

## Architecture

### Permissions replace roles at the decision point

A single `ROLE_PERMISSIONS` map in `server/src/auth/permissions.ts` becomes the
one place authorization is decided:

| Permission | Roles | Covers |
|---|---|---|
| `cases.work` | admin, zone_manager, approver | status changes, assignment, SLA extend/pause/resume, draft and send email, pending, attachments |
| `team.manage` | admin, zone_manager | user CRUD, assignment config, user export |
| `config.manage` | admin, zone_manager | forms, SLA policies, response templates |
| `reports.run` | admin, zone_manager | the report controller |
| `audit.read` | admin, auditor | audit log and its export |
| `system.operate` | admin | SLA recompute, report send, system templates |
| `instance.administer` | super_admin | settings, administrative password reset |

`@Roles('admin', 'zone_manager')` becomes `@Requires('team.manage')`. The guard
resolves the session user's role to its permission set and checks membership.

**The ladder and its exception both disappear.** `satisfies()` today needs a
`RANK` table, a minimum-threshold calculation over the required roles, and a
hard-coded `auditor` carve-out to stop a read-only role inheriting write access.
With explicit per-role grants none of that is needed: `super_admin` holds the
permissions it should hold, `auditor` holds `audit.read` and nothing else, and
the answer to "what can this role do" is a table you read rather than an
algorithm you simulate.

Grouping forms, SLA policies and response templates under one `config.manage`
rather than three permissions is deliberate. The same two roles hold all three
today, and three permissions with identical grants is a distinction that costs
maintenance and buys nothing until the grants actually diverge.

### Reads stay zone-scoped; only writes are role-gated

The RLS matrix constrains `WITH CHECK` (writes). `USING` (reads) keeps its
existing zone-only predicate. Role-gating reads would mean encoding, in SQL, the
same visibility rules the permission layer already enforces at the route — two
implementations of one rule, in two languages, drifting apart. The value of the
database layer here is that it cannot be talked out of refusing a write.

For the two global tables, `system_templates` and `app_settings`, there is no
zone to scope by, so `USING` is unrestricted and only `WITH CHECK` carries the
role term. Restricting reads on `app_settings` would break
`SettingsService.refresh()`, which loads the cache at boot before any user
context exists, and would buy little: secret values are envelope-encrypted at
rest and masked by `describeAll()` before they reach any response.

One consequence of zone-scoping `users` is worth stating so it is not later
"fixed": `app_zone_allows(NULL)` yields NULL, which fails the check. Users with
no zone — admins, auditors, super admins — are therefore writable only from a
`zone = '*'` context. That is the intended rule. A `zone_manager` pinned to EUR
must not be able to edit a global account, and this is the database enforcing it
rather than the controller.

### User administration is a policy function, not a permission

`admin-users.controller.ts:56-60` and `:99-107` contain near-identical logic: a
`zone_manager` may not create or promote to `admin` or `super_admin`, may not
touch a user outside their own zone, and only a `super_admin` may mint another
`super_admin`. Two copies of a privilege-escalation rule is exactly where a bug
hides — fix one, miss the other.

This becomes one function, `canAssignRole(actor, targetRole, targetZone)`, in
`server/src/auth/admin-policy.ts`, called from both the create and update paths.
It stays outside the permission table on purpose: the decision depends on the
*target* row's role and zone, not only on the actor's, and a permission lookup
that takes the target as context has stopped being a lookup.

## The RLS role matrix

A new predicate sits alongside the existing `app_zone_allows(text)`:

```sql
CREATE OR REPLACE FUNCTION app_role_may_write(allowed text[]) RETURNS boolean AS $$
  SELECT current_setting('app.current_role', true) = ANY(allowed);
$$ LANGUAGE sql STABLE;
```

Fourteen tables carry the matrix. Seven already have RLS and gain a role term in
their `WITH CHECK`; seven have it enabled for the first time.

| Table | Write roles | Zone-scoped | RLS today |
|---|---|---|---|
| `cases` | system, admin, zone_manager, approver | yes | yes |
| `case_fields` | system, admin, zone_manager, approver | via parent case | yes |
| `case_status_history` | system, admin, zone_manager, approver | via parent case | yes |
| `case_comments` | system, admin, zone_manager, approver | via parent case | yes |
| `case_attachments` | system, admin, zone_manager, approver | via parent case | yes |
| `sla_clocks` | system, admin, zone_manager, approver | via parent case | yes |
| `email_log` | system, admin, zone_manager, approver | via parent case | yes |
| `users` | system, super_admin, admin, zone_manager | yes | **new** |
| `form_versions` | system, super_admin, admin, zone_manager | yes | **new** |
| `sla_policies` | system, super_admin, admin, zone_manager | yes | **new** |
| `templates` | system, super_admin, admin, zone_manager | yes | **new** |
| `assignment_config` | system, super_admin, admin, zone_manager | yes | **new** |
| `system_templates` | system, super_admin, admin | no (global) | **new** |
| `app_settings` | system, super_admin | no (global) | **new** |

`auditor` appears in no write list. That is the rule this whole exercise exists
to make true in the database rather than only in a decorator.

`audit_log` is deliberately absent: it is already append-only through
`REVOKE UPDATE, DELETE ON audit_log FROM dsr_app`, which is a grant rather than
a policy and therefore stronger. Adding a policy would weaken nothing but would
imply the grant is not the real protection.

Reference and intake tables — `zones`, `statuses`, `status_transitions`,
`teams`, `case_sequences`, `form_drafts`, `rate_counters`,
`verification_tokens`, `internal_sessions` — stay as they are. They are written
by the public intake path and by schedulers under `system()`, where a role
matrix has nothing to say.

### `super_admin` reaches the database

`zoneContextFor()` currently collapses `super_admin` into `'admin'` when building
the `ZoneContext`, so the database cannot tell them apart. `app_settings` is
`super_admin`-only at the route, and that rule is inexpressible in SQL until the
value survives the trip.

`ZoneContext['role']` gains `'super_admin'` and loses `'public'`, which is
declared in the union and never passed anywhere. Existing policies key on zone
alone, so widening the role value breaks nothing.

### The escape hatch

A wrong predicate on `users` or `cases` locks operators out of a production
system holding live case data, and the fix would otherwise be a migration
written under pressure. Because `app_role_may_write` is a standalone function,
one statement restores the previous behaviour without touching a policy:

```sql
CREATE OR REPLACE FUNCTION app_role_may_write(text[]) RETURNS boolean AS $$
  SELECT true
$$ LANGUAGE sql STABLE;
```

That statement, and what it costs (role enforcement falls back to the
application layer, where it is today), goes in the migration's header comment and
in the README's operations section. An escape hatch nobody can find during an
incident is not an escape hatch.

## The `db.system()` migration

Policies on the administrative tables are inert while every write to them
declares `role: 'system'`. Roughly twenty call sites move from `system()` to
`withContext(req.zoneCtx)`:

| File | Calls | Note |
|---|---|---|
| `admin/admin-users.controller.ts` | 9 | user CRUD, assignment config, exports |
| `forms/forms.service.ts` | 5 | form versions |
| `forms/sla.controller.ts` | 4 | SLA policies |
| `email/system-template.service.ts` | 4 | system templates |
| `settings/settings.service.ts` | 2 | writes only |

`SettingsService.refresh()` keeps `system()`: it runs at boot and on a timer,
where no user context exists. Every `system()` call that survives this
sub-project gains a one-line comment saying why it needs full visibility. An
unexplained `system()` is what made these policies inert in the first place, and
the comment is what stops the next one being added by reflex.

## Rollout order

The sequence is load-bearing:

1. **Permissions and `canAssignRole`.** Pure TypeScript, no migration, no
   behaviour change beyond how the same decision is expressed.
2. **The `system()` migration.** Call sites start passing real contexts while
   the database still permits everything.
3. **The RLS policies.** They land on code already sending correct roles.

Reversed, step 3 before step 2 means every administrative write is refused by a
policy that the code cannot yet satisfy — an outage introduced by a commit that
looks like hardening.

## Testing

Unit, following this codebase's pure-function convention with no Nest
`TestingModule`:

- `permissions.spec.ts` — table-driven over every role × every permission, so the
  grant matrix is asserted rather than assumed. Explicitly: `auditor` holds
  `audit.read` and nothing else; `super_admin` holds `instance.administer`;
  `approver` holds `cases.work` and nothing else.
- `admin-policy.spec.ts` — the escalation cases: a `zone_manager` creating an
  `admin`, a `zone_manager` editing a user in another zone, an `admin` minting a
  `super_admin`, and the permitted cases that must keep working.
- The existing `auth.guard.spec.ts` is rewritten against `@Requires`. Its current
  cases are ladder semantics that will no longer exist; the replacement asserts
  that a route requiring a permission admits exactly the roles holding it.

Integration: `server/scripts/rls-check.mjs` already exercises zone isolation
against a real database. Extend it to assert the write matrix — for each role, a
permitted write succeeds and a forbidden write is refused, on every one of the
fourteen tables. A policy is the one thing that cannot be verified by reading
TypeScript, and this script is the only place it can be proved.

## Verification

```bash
npm --prefix server test                      # permission and policy matrices
npm --prefix server run build
node server/scripts/rls-check.mjs             # zone isolation, unchanged
node server/scripts/rls-check.mjs --roles     # the new write matrix

# an auditor session cannot write, at the database, not just the route
psql -c "BEGIN; SELECT set_config('app.current_role','auditor',true),
                       set_config('app.current_zone','*',true);
         UPDATE cases SET status='closed' WHERE true; ROLLBACK;"
# expected: new row violates row-level security policy

# the escape hatch works
psql -c "CREATE OR REPLACE FUNCTION app_role_may_write(text[]) RETURNS boolean
         AS \$\$ SELECT true \$\$ LANGUAGE sql STABLE;"
# re-run the auditor write: now permitted. Restore the real function afterwards.
```

Manual, on a real box: sign in as each role and confirm the routes that role
should reach still work. The unit tests prove the matrix; only a session proves
the wiring.
