# RBAC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered role literals with seven named permissions, extract the duplicated user-administration rules into one tested function, and make `app.current_role` load-bearing by enforcing a role matrix in Postgres across fourteen tables.

**Architecture:** A single `ROLE_PERMISSIONS` table decides authorization at the route. A `canAssignRole` policy function decides who may create or promote whom. `zoneContextFor` stops collapsing `super_admin` into `admin`, the administrative writes move off `DbService.system()` onto `withContext`, and a new `app_role_may_write()` predicate joins the existing `app_zone_allows()` in every policy's `WITH CHECK`.

**Tech Stack:** NestJS 11, TypeScript (strict), Jest 30, node-postgres, Drizzle, Postgres row-level security. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-rbac-hardening-design.md`

## Global Constraints

- **No new dependencies.**
- Tests are colocated `*.spec.ts` under `server/src`, run with `npm --prefix server test`. Jest `rootDir` is `src`. Existing specs are pure-function tests with **no Nest `TestingModule`** — follow that; do not introduce a DI test harness.
- The suite is **66 tests across 8 suites** at the start of this plan and must stay green.
- Run `npm --prefix server test` and `npm --prefix server run build` before every commit. Both must be green.
- **CRLF line endings.** Every file in this repo is 100% CRLF. Do not reformat whole files; keep diffs to the lines you change.
- **Commit style:** an imperative sentence, no `feat:`/`fix:` prefix. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NtXEr3cBGDqXwFLmPnFVye
  ```
- Committing directly to `main` is deliberate and approved. Do not create a branch.
- **The five roles are** `super_admin`, `admin`, `zone_manager`, `approver`, `auditor`. The DB context role adds `system`.
- **Rollout order is load-bearing** and matches task order: permissions → context → `system()` migration → policies. Landing the policies before the `system()` migration refuses every administrative write.

## Spec correction applied in this plan

The spec's matrix lists the seven case-table write roles as `system, admin, zone_manager, approver`. That was written before the decision to pass `super_admin` through to the database. Once Task 4 lands, a super admin's context carries `role: 'super_admin'`, so **every write list in this plan includes `super_admin`**. Omitting it would refuse every super-admin write on the case tables — a self-inflicted outage on the first policy commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/auth/permissions.ts` | **new** — the `Permission` union, `ROLE_PERMISSIONS` grant table, `hasPermission()`. The single source of authorization truth. |
| `server/src/auth/permissions.spec.ts` | **new** — table-driven grant assertions. |
| `server/src/auth/admin-policy.ts` | **new** — `canAssignRole()`, the user-administration rule. |
| `server/src/auth/admin-policy.spec.ts` | **new** — privilege-escalation cases. |
| `server/src/auth/auth.guard.ts` | loses `RANK`, `satisfies()`, `Roles`; gains `Requires` and a permission check. |
| `server/src/auth/auth.service.ts` | `zoneContextFor` stops collapsing `super_admin`. |
| `server/src/db/db.module.ts` | `ZoneContext['role']` gains `super_admin`, loses the unused `public`. |
| 9 controllers | `@Roles(...)` → `@Requires(...)`. |
| `server/drizzle/0013_role-matrix.sql` | **new** — `app_role_may_write()` and fourteen tables of policy. |
| `server/scripts/rls-check.mjs` | gains a `--roles` mode proving the write matrix against a real database. |

---

### Task 1: The permission table

**Files:**
- Create: `server/src/auth/permissions.ts`
- Create: `server/src/auth/permissions.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type Role = 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor'`; `export type Permission` (union of the seven strings); `export const PERMISSIONS: readonly Permission[]`; `export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]>`; `export function hasPermission(role: string, permission: Permission): boolean`. Task 2's guard calls `hasPermission`; Task 3 imports `Role`.

- [ ] **Step 1: Write the failing test**

Create `server/src/auth/permissions.spec.ts`:

```ts
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type Role } from './permissions';

const ROLES: Role[] = ['super_admin', 'admin', 'zone_manager', 'approver', 'auditor'];

describe('ROLE_PERMISSIONS', () => {
  it('grants every role only permissions that exist', () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  it('keeps the auditor read-only', () => {
    expect(ROLE_PERMISSIONS.auditor).toEqual(['audit.read']);
  });

  it('gives the approver case work and nothing else', () => {
    expect(ROLE_PERMISSIONS.approver).toEqual(['cases.work']);
  });

  it('reserves instance administration for the super admin', () => {
    for (const role of ROLES) {
      expect(hasPermission(role, 'instance.administer')).toBe(role === 'super_admin');
    }
  });

  it('gives the super admin everything', () => {
    for (const p of PERMISSIONS) expect(hasPermission('super_admin', p)).toBe(true);
  });

  it('withholds system.operate from the zone manager', () => {
    expect(hasPermission('zone_manager', 'system.operate')).toBe(false);
    expect(hasPermission('admin', 'system.operate')).toBe(true);
  });

  it('lets the auditor read the audit log but not work cases', () => {
    expect(hasPermission('auditor', 'audit.read')).toBe(true);
    expect(hasPermission('auditor', 'cases.work')).toBe(false);
  });

  it('refuses an unknown role rather than throwing', () => {
    expect(hasPermission('root', 'cases.work')).toBe(false);
    expect(hasPermission('', 'audit.read')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- permissions`
Expected: FAIL — `Cannot find module './permissions'`.

- [ ] **Step 3: Create `server/src/auth/permissions.ts`**

```ts
/**
 * Who may do what, as a table rather than an algorithm.
 *
 * This replaces a privilege ladder that ranked the operational roles and then
 * needed an explicit carve-out to stop `auditor` — a deliberately read-only
 * lane — inheriting write access by rank. Explicit grants make that carve-out
 * unnecessary: a role holds exactly what is listed here.
 *
 * Permissions are grouped by the decision an operator actually makes, not by
 * route. `config.manage` covers forms, SLA policies and response templates
 * together because the same two roles hold all three; splitting them would be
 * three names for one grant.
 */

export type Role = 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor';

export const PERMISSIONS = [
  /** Work a case: status, assignment, SLA clock, correspondence, attachments. */
  'cases.work',
  /** Administer people: users, assignment configuration, team exports. */
  'team.manage',
  /** Configure the portal: forms, SLA policies, response templates. */
  'config.manage',
  /** Run and read management reports. */
  'reports.run',
  /** Read the audit log and export it. */
  'audit.read',
  /** Instance-wide operations: SLA recompute, report send, system templates. */
  'system.operate',
  /** Change instance configuration and reset another user's password. */
  'instance.administer',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: [
    'cases.work',
    'team.manage',
    'config.manage',
    'reports.run',
    'audit.read',
    'system.operate',
    'instance.administer',
  ],
  admin: ['cases.work', 'team.manage', 'config.manage', 'reports.run', 'audit.read', 'system.operate'],
  zone_manager: ['cases.work', 'team.manage', 'config.manage', 'reports.run'],
  approver: ['cases.work'],
  auditor: ['audit.read'],
};

/** False for an unrecognised role: an unknown role grants nothing. */
export function hasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role as Role];
  return granted ? granted.includes(permission) : false;
}
```

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS — 8 new assertions, 74 tests total.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/permissions.ts server/src/auth/permissions.spec.ts
git commit
```

Message: `State who may do what as a table`

---

### Task 2: Guard on permissions, not roles

**Files:**
- Modify: `server/src/auth/auth.guard.ts`
- Rewrite: `server/src/auth/auth.guard.spec.ts`
- Modify (decorator swap only): `server/src/admin/admin-users.controller.ts`, `server/src/cases/attachments.controller.ts`, `server/src/cases/cases-actions.controller.ts`, `server/src/cases/report.controller.ts`, `server/src/email/system-template.controller.ts`, `server/src/forms/forms.controller.ts`, `server/src/forms/sla.controller.ts`, `server/src/settings/settings.controller.ts`

**Interfaces:**
- Consumes: `hasPermission`, `Permission` from Task 1.
- Produces: `export const Requires = (permission: Permission) => ...`. `Roles`, `satisfies` and `RANK` cease to exist — nothing may import them after this task.

- [ ] **Step 1: Replace the guard's spec**

Replace the whole contents of `server/src/auth/auth.guard.spec.ts`:

```ts
import { hasPermission } from './permissions';

// The guard's authorization decision is exactly hasPermission() applied to the
// session user's role. The ladder these tests used to cover no longer exists.
describe('route authorization', () => {
  it('admits every role that holds the permission', () => {
    expect(hasPermission('approver', 'cases.work')).toBe(true);
    expect(hasPermission('zone_manager', 'cases.work')).toBe(true);
    expect(hasPermission('admin', 'cases.work')).toBe(true);
    expect(hasPermission('super_admin', 'cases.work')).toBe(true);
  });

  it('refuses a role that does not hold it, however senior', () => {
    expect(hasPermission('auditor', 'cases.work')).toBe(false);
    expect(hasPermission('admin', 'instance.administer')).toBe(false);
    expect(hasPermission('zone_manager', 'system.operate')).toBe(false);
  });

  it('no longer lets seniority imply a permission', () => {
    // Under the old ladder super_admin satisfied any requirement below it and
    // auditor needed an explicit exception. Both are now just table lookups.
    expect(hasPermission('approver', 'team.manage')).toBe(false);
    expect(hasPermission('auditor', 'team.manage')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- auth.guard`
Expected: FAIL — the old spec imported `satisfies`, which this file no longer imports; the new file passes only once `permissions.ts` is wired, and the build still references `Roles`. Confirm the suite is red before continuing.

- [ ] **Step 3: Rewrite the guard**

In `server/src/auth/auth.guard.ts`, delete the `RANK` constant, the `satisfies` function and its doc comment, and the `Roles` export. Replace the metadata key and decorator, and change the check inside `canActivate`.

Replace the `ROLES_KEY` line with:

```ts
const PERMISSION_KEY = 'dsr:permission';
```

Replace the `Roles` export with:

```ts
/** Restrict a handler to holders of a permission, e.g. @Requires('team.manage'). */
export const Requires = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
```

Add to the imports:

```ts
import { hasPermission, type Permission } from './permissions';
```

Inside `canActivate`, replace the roles block with:

```ts
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required && !hasPermission(user.role, required)) {
      throw new ForbiddenException();
    }
```

- [ ] **Step 4: Swap every decorator**

Replace the import of `Roles` with `Requires` in each controller, then apply this mapping exactly. Every one of the 33 decorators is listed; there are no others.

`server/src/admin/admin-users.controller.ts`

| Route | New decorator |
|---|---|
| `@Get('users')` | `@Requires('team.manage')` |
| `@Post('users')` | `@Requires('team.manage')` |
| `@Patch('users/:id')` | `@Requires('team.manage')` |
| `@Get('assignment-config')` | `@Requires('team.manage')` |
| `@Post('users/:id/reset-password')` | `@Requires('instance.administer')` |
| `@Patch('assignment-config/:zone')` | `@Requires('team.manage')` |
| `@Get('users/export.csv')` | `@Requires('team.manage')` |
| `@Get('audit-log/export.csv')` | `@Requires('audit.read')` |
| `@Get('audit-log')` | `@Requires('audit.read')` |

`server/src/cases/cases-actions.controller.ts`

| Route | New decorator |
|---|---|
| `@Post('cases/:id/status')` | `@Requires('cases.work')` |
| `@Post('cases/:id/assign')` | `@Requires('cases.work')` |
| `@Post('cases/:id/sla/extend')` | `@Requires('cases.work')` |
| `@Post('cases/:id/sla/pause')` | `@Requires('cases.work')` |
| `@Post('cases/:id/sla/resume')` | `@Requires('cases.work')` |
| `@Post('sla/recompute')` | `@Requires('system.operate')` |
| `@Post('templates')` | `@Requires('config.manage')` |
| `@Get('cases/:id/draft-email')` | `@Requires('cases.work')` |
| `@Post('cases/:id/send-email')` | `@Requires('cases.work')` |
| `@Post('cases/:id/pending')` | `@Requires('cases.work')` |

Remaining files:

- `server/src/cases/attachments.controller.ts` — the single `@Post()` becomes `@Requires('cases.work')`.
- `server/src/cases/report.controller.ts` — the class-level decorator becomes `@Requires('reports.run')`; `@Post('send')` becomes `@Requires('system.operate')`.
- `server/src/email/system-template.controller.ts` — the class-level decorator becomes `@Requires('system.operate')`.
- `server/src/forms/forms.controller.ts` — all six become `@Requires('config.manage')`.
- `server/src/forms/sla.controller.ts` — all three become `@Requires('config.manage')`.
- `server/src/settings/settings.controller.ts` — the class-level decorator becomes `@Requires('instance.administer')`.

- [ ] **Step 5: Confirm nothing still references the old API**

```bash
grep -rn "@Roles(\|satisfies(\|RANK" server/src --include=*.ts
```

Expected: no matches. If `satisfies` appears, it is a different function — check before deleting.

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS. The build is what proves all 33 decorators were converted — a missed `@Roles` fails to compile once the export is gone.

- [ ] **Step 7: Commit**

```bash
git add server/src
git commit
```

Message: `Guard routes on a permission instead of a list of roles`

---

### Task 3: One rule for who may create and promote whom

**Files:**
- Create: `server/src/auth/admin-policy.ts`
- Create: `server/src/auth/admin-policy.spec.ts`
- Modify: `server/src/admin/admin-users.controller.ts` (the create path around line 52 and the update path around line 98)

**Interfaces:**
- Consumes: `Role` from Task 1.
- Produces: `export interface RoleActor { role: Role; zoneId: string | null }`; `export function canAssignRole(actor: RoleActor, targetRole: Role, targetZone: string | null): string | null` — returns `null` when permitted, otherwise the operator-facing reason.

**Behaviour change to be aware of:** the create path currently says "Only a super admin can create another super admin" and the update path "Only a super admin can grant the super admin role". They become one message, the update path's wording, because one rule should not have two voices.

**Bug this fixes:** the update path checks only `before.zone_id` against the actor's zone. A `zone_manager` can therefore move one of their own users into another zone, because the new `body.zoneId` is never checked. The controller will now call `canAssignRole` with the *resulting* zone as well as keeping the existing check on the row being edited.

- [ ] **Step 1: Write the failing test**

Create `server/src/auth/admin-policy.spec.ts`:

```ts
import { canAssignRole } from './admin-policy';

const superAdmin = { role: 'super_admin' as const, zoneId: null };
const admin = { role: 'admin' as const, zoneId: null };
const eurManager = { role: 'zone_manager' as const, zoneId: 'EUR' };

describe('canAssignRole', () => {
  it('lets a super admin grant the super admin role', () => {
    expect(canAssignRole(superAdmin, 'super_admin', null)).toBeNull();
  });

  it('stops an admin granting the super admin role', () => {
    expect(canAssignRole(admin, 'super_admin', null)).toBe(
      'Only a super admin can grant the super admin role',
    );
  });

  it('stops a zone manager granting the super admin role', () => {
    expect(canAssignRole(eurManager, 'super_admin', 'EUR')).toBe(
      'Only a super admin can grant the super admin role',
    );
  });

  it('stops a zone manager creating an admin', () => {
    expect(canAssignRole(eurManager, 'admin', 'EUR')).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('stops a zone manager acting outside their zone', () => {
    expect(canAssignRole(eurManager, 'approver', 'SAZ')).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('stops a zone manager moving a user to a zone they do not manage', () => {
    // The resulting zone is what matters, not only the zone the user came from.
    expect(canAssignRole(eurManager, 'approver', null)).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('lets a zone manager manage an approver in their own zone', () => {
    expect(canAssignRole(eurManager, 'approver', 'EUR')).toBeNull();
  });

  it('lets an admin manage any operational role in any zone', () => {
    expect(canAssignRole(admin, 'zone_manager', 'SAZ')).toBeNull();
    expect(canAssignRole(admin, 'auditor', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- admin-policy`
Expected: FAIL — `Cannot find module './admin-policy'`.

- [ ] **Step 3: Create `server/src/auth/admin-policy.ts`**

```ts
import type { Role } from './permissions';

export interface RoleActor {
  role: Role;
  zoneId: string | null;
}

/**
 * Who may create a user with a given role in a given zone, or change an
 * existing user into one.
 *
 * This is not a permission. `team.manage` answers "may this person administer
 * users at all"; this answers "may they produce *this* user", which depends on
 * the target's role and zone as well as the actor's. Both the create and update
 * paths call it, because two copies of an escalation rule is one copy too many.
 *
 * Returns null when permitted, or the operator-facing reason when not.
 */
export function canAssignRole(
  actor: RoleActor,
  targetRole: Role,
  targetZone: string | null,
): string | null {
  if (targetRole === 'super_admin' && actor.role !== 'super_admin') {
    return 'Only a super admin can grant the super admin role';
  }
  if (actor.role === 'zone_manager') {
    if (targetRole === 'admin' || targetRole === 'super_admin') {
      return 'Zone managers can only manage their own zone';
    }
    if (targetZone !== actor.zoneId) {
      return 'Zone managers can only manage their own zone';
    }
  }
  return null;
}
```

- [ ] **Step 4: Use it in the create path**

In `server/src/admin/admin-users.controller.ts`, replace both guard blocks in `createUser` — the `body.role === 'super_admin'` check and the `req.user.role === 'zone_manager'` block — with:

```ts
    const refusal = canAssignRole(
      { role: req.user.role, zoneId: req.user.zoneId },
      body.role as Role,
      body.zoneId ?? null,
    );
    if (refusal) throw new BadRequestException(refusal);
```

Add to the imports:

```ts
import { canAssignRole } from '../auth/admin-policy';
import type { Role } from '../auth/permissions';
```

- [ ] **Step 5: Use it in the update path**

In `updateUser`, delete the `body?.role === 'super_admin'` check. Keep the existing `before` lookup and the existing check that a zone manager may only touch a user already in their zone. Immediately after that check, add:

```ts
    // The resulting role and zone, not just the current ones: a zone manager
    // must not be able to move a user they administer into another zone.
    const refusal = canAssignRole(
      { role: req.user.role, zoneId: req.user.zoneId },
      (body.role ?? before.role) as Role,
      body.zoneId !== undefined ? body.zoneId : before.zone_id,
    );
    if (refusal) throw new BadRequestException(refusal);
```

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS — 8 new assertions.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/admin-policy.ts server/src/auth/admin-policy.spec.ts server/src/admin/admin-users.controller.ts
git commit
```

Message: `Decide role assignment in one place, including the target zone`

---

### Task 4: Let the database see a super admin

**Files:**
- Modify: `server/src/db/db.module.ts` (the `ZoneContext` type)
- Modify: `server/src/auth/auth.service.ts` (`zoneContextFor`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ZoneContext['role']` is `'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor' | 'system'`. Task 7's policies depend on `'super_admin'` arriving intact.

- [ ] **Step 1: Widen the context type**

In `server/src/db/db.module.ts`, replace the `ZoneContext` type with:

```ts
export type ZoneContext = {
  role: 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor' | 'system';
  zone: string; // 'EUR' | 'SAZ' | 'MAZ' | '*'
};
```

`'public'` is removed: it was declared in the union and never passed anywhere.

- [ ] **Step 2: Stop collapsing the role**

In `server/src/auth/auth.service.ts`, replace `zoneContextFor` with:

```ts
export function zoneContextFor(user: SessionUser): ZoneContext {
  // Super admins, admins and auditors see every zone; the rest are pinned.
  // The role itself is passed through unchanged: collapsing super_admin into
  // admin here would make an instance-administration policy inexpressible in
  // the database, because the two would be indistinguishable by the time a
  // query ran.
  if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'auditor') {
    return { role: user.role, zone: '*' };
  }
  return { role: user.role, zone: user.zoneId ?? '__none__' };
}
```

- [ ] **Step 3: Confirm nothing depended on the collapse**

```bash
grep -rn "zoneCtx\|zoneContextFor" server/src --include=*.ts | grep -v spec
```

Read each hit. No caller may compare `ctx.role` to `'admin'` expecting a super admin to match. Report anything that does rather than changing it.

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS, 82 tests. No behaviour changes yet — no policy reads the role.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/db.module.ts server/src/auth/auth.service.ts
git commit
```

Message: `Pass the super admin role through to the database context`

---

### Task 5: Move the user administration writes onto a real context

**Files:**
- Modify: `server/src/admin/admin-users.controller.ts` (9 `db.system(` call sites)

**Interfaces:**
- Consumes: `ZoneContext` from Task 4; `req.zoneCtx`, already set by `AuthGuard`.
- Produces: nothing new. Task 7's `users` and `assignment_config` policies become reachable.

Every handler in this controller has `req: AuthedRequest`, which carries `req.zoneCtx`. The transformation is mechanical: `this.db.system(` becomes `this.db.withContext(req.zoneCtx, `.

- [ ] **Step 1: Convert the nine call sites**

In `server/src/admin/admin-users.controller.ts`, replace each `this.db.system(async (…) => {` with `this.db.withContext(req.zoneCtx, async (…) => {`, preserving each callback's existing parameter list. The handlers are `listUsers`, `createUser`, `updateUser` (two calls — the `before` lookup and the `UPDATE`), `listAssignmentConfig`, `resetPassword`, `updateAssignmentConfig`, `exportUsers`, `auditLogCsv` and `auditLog`.

Two need a decision rather than a mechanical swap, and both keep `system()` with a comment:

```ts
    // Audit log reads are cross-zone by definition: an auditor's whole job is
    // to see every zone, and the rows carry no zone column to filter on.
```

Apply that comment to the `auditLog` and `auditLogCsv` reads and leave them on `system()`.

- [ ] **Step 2: Check the zone-manager list still narrows**

`listUsers` computes `effectiveZone` from `req.user.role` and passes it to the query. That logic is unchanged and still correct — `withContext` adds database enforcement underneath it rather than replacing it. Confirm by reading that the `WHERE` clause is untouched.

- [ ] **Step 3: Confirm the conversion**

```bash
grep -n "db.system(" server/src/admin/admin-users.controller.ts
```

Expected: exactly two matches, both the audit-log reads, each preceded by the comment.

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS. No policy exists yet, so behaviour is unchanged; this task only changes which role the database is told about.

- [ ] **Step 5: Commit**

```bash
git add server/src/admin/admin-users.controller.ts
git commit
```

Message: `Administer users under the caller's own database context`

---

### Task 6: Move the remaining configuration writes

**Files:**
- Modify: `server/src/forms/forms.service.ts` (one method moves; three stay with comments)
- Modify: `server/src/forms/forms.controller.ts` (pass `req.zoneCtx` to `publish`)
- Modify: `server/src/forms/sla.controller.ts` (4)
- Modify: `server/src/email/system-template.service.ts` (4)
- Modify: `server/src/email/system-template.controller.ts` (pass `req.zoneCtx`)
- Modify: `server/src/cases/outbound.service.ts` (`upsertTemplate` only)
- Modify: `server/src/cases/cases-actions.controller.ts` (pass `req.zoneCtx` to `upsertTemplate`)
- Modify: `server/src/settings/settings.service.ts` (write path only)
- Modify: `server/src/settings/settings.controller.ts` (pass `req.zoneCtx` to `updateMany`)

**Interfaces:**
- Consumes: `ZoneContext` from Task 4.
- Produces: `FormsService.publish` and `OutboundService.upsertTemplate` gain a leading `ctx: ZoneContext` parameter; `SettingsService.updateMany` gains one; `SystemTemplateService`'s two write methods gain one. Task 7's `form_versions`, `sla_policies`, `templates`, `system_templates` and `app_settings` policies become reachable.

Where a service method has no request in scope, thread the context in as a parameter from its controller rather than reaching for a global. `sla.controller.ts` has `req` directly.

Import the type where needed:

```ts
import { DbService, type ZoneContext } from '../db/db.module';
```

- [ ] **Step 1: Convert `forms.service.ts` — one method, not five**

Only `publish()` writes. Its `db.system(` at the `INSERT INTO form_versions` becomes `db.withContext(ctx, `, with `ctx: ZoneContext` added as its first parameter and `req.zoneCtx` passed from `forms.controller.ts`.

`list()`, `get()`, `history()` and the read inside `restore()` stay on `system()`. Each gains:

```ts
    // The forms screen lists every zone's schema for an administrator; these
    // rows are configuration, not case data.
```

`restore()` reads the old schema under `system()` and then calls `publish()`, so its write is already covered by the change above — do not convert its read.

- [ ] **Step 1b: Convert `outbound.service.ts`'s `upsertTemplate`**

`upsertTemplate` writes the `templates` table under `db.system()`. Without this change, Task 7's `templates` policy is satisfied by `'system'` on every call and never enforces anything.

Add `ctx: ZoneContext` as its first parameter, change its `db.system(async (db) => {` to `db.withContext(ctx, async (db) => {`, and pass `req.zoneCtx` from the `@Post('templates')` handler in `cases-actions.controller.ts`.

Leave `outbound.service.ts`'s other `system()` calls alone — they are on the correspondence path and are out of this task's scope.

- [ ] **Step 2: Convert `sla.controller.ts`**

All four call sites have `req` in scope. Convert the two writes (`INSERT INTO sla_policies`, `DELETE FROM sla_policies`) and the `before` lookup to `withContext(req.zoneCtx, …)`. The list read may stay on `system()` with the configuration comment above.

- [ ] **Step 3: Convert `system-template.service.ts`**

The two writes (`INSERT INTO system_templates`, `DELETE FROM system_templates`) take a `ctx: ZoneContext` parameter passed from `system-template.controller.ts`. The two reads stay on `system()` — templates are global and are read while rendering mail with no user present:

```ts
    // Read while rendering outbound mail, where there is no user context.
```

- [ ] **Step 4: Convert the settings write path**

In `server/src/settings/settings.service.ts`, `updateMany` takes a `ctx: ZoneContext` parameter, passed from `settings.controller.ts` as `req.zoneCtx`, and its `db.system(` becomes `db.withContext(ctx, `.

**`refresh()` keeps `system()`** and gains:

```ts
    // Boot and timer path: the cache is loaded before any user exists.
```

- [ ] **Step 5: Confirm every surviving `system()` is explained**

```bash
grep -rn -B 2 "db.system(" server/src/forms server/src/email/system-template.service.ts \
  server/src/settings/settings.service.ts server/src/admin
```

Every remaining call in those paths must have a comment above it saying why full visibility is needed. An unexplained one is the defect this task exists to remove.

Then confirm the five tables Task 7 will police are no longer written under `system()`:

```bash
grep -rn "INSERT INTO form_versions\|INSERT INTO sla_policies\|DELETE FROM sla_policies" server/src
grep -rn "INSERT INTO system_templates\|DELETE FROM system_templates" server/src
grep -rn "insert(templates)\|update(templates)" server/src
grep -rn "INSERT INTO app_settings\|DELETE FROM app_settings" server/src
```

Read the enclosing call for each hit. Every one must now be inside `withContext`, not `system()`. A write left on `system()` makes its policy decorative — the exact failure this sub-project exists to fix.

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src
git commit
```

Message: `Write configuration under the caller's own database context`

---

### Task 7: The role matrix, in the database

**Files:**
- Create: `server/drizzle/0013_role-matrix.sql`
- Modify: `README.md` (operations section)

**Interfaces:**
- Consumes: `super_admin` arriving in `app.current_role` (Task 4) and administrative writes running under `withContext` (Tasks 5-6).
- Produces: `app_role_may_write(text[])`, and RLS on seven additional tables.

**This is the task that can take production down.** It lands last for that reason, and ships with an escape hatch.

- [ ] **Step 1: Write the migration**

Create `server/drizzle/0013_role-matrix.sql`:

```sql
-- Role authorization, in the database rather than only in a decorator.
--
-- app.current_role has been set on every transaction since 0001 and no policy
-- has ever read it. This migration makes it load-bearing: writes are now
-- checked against the role that opened the transaction, so an application bug
-- cannot let an auditor write a case.
--
-- ESCAPE HATCH. If a predicate here is wrong and operators are locked out,
-- one statement restores the previous behaviour without a rollback:
--
--   CREATE OR REPLACE FUNCTION app_role_may_write(text[]) RETURNS boolean
--     AS $$ SELECT true $$ LANGUAGE sql STABLE;
--
-- Role enforcement then falls back to the application layer, which is where it
-- lived before this migration. Restore the real function afterwards.

CREATE OR REPLACE FUNCTION app_role_may_write(allowed text[]) RETURNS boolean AS $$
  SELECT current_setting('app.current_role', true) = ANY(allowed);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ---------------------------------------------------------------- case data --
-- Everyone who works cases may write them; the auditor may not.

DROP POLICY IF EXISTS cases_zone_isolation ON cases;
--> statement-breakpoint
CREATE POLICY cases_zone_isolation ON cases
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_fields_zone ON case_fields;
--> statement-breakpoint
CREATE POLICY case_fields_zone ON case_fields
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_status_history_zone ON case_status_history;
--> statement-breakpoint
CREATE POLICY case_status_history_zone ON case_status_history
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_comments_zone ON case_comments;
--> statement-breakpoint
CREATE POLICY case_comments_zone ON case_comments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_attachments_zone ON case_attachments;
--> statement-breakpoint
CREATE POLICY case_attachments_zone ON case_attachments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS sla_clocks_zone ON sla_clocks;
--> statement-breakpoint
CREATE POLICY sla_clocks_zone ON sla_clocks
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS email_log_zone ON email_log;
--> statement-breakpoint
CREATE POLICY email_log_zone ON email_log
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

-- ------------------------------------------------------ administrative data --
-- Zone-scoped configuration. An approver may read it and may not write it.
--
-- Note on users with no zone: app_zone_allows(NULL) is NULL, which fails the
-- check, so admins, auditors and super admins are writable only from a
-- zone = '*' context. That is the intended rule -- a zone manager pinned to
-- EUR must not be able to edit a global account -- and it is enforced here
-- rather than only in the controller.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_zone_role ON users
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE form_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY form_versions_zone_role ON form_versions
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE sla_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sla_policies_zone_role ON sla_policies
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY templates_zone_role ON templates
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE assignment_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assignment_config_zone_role ON assignment_config
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

-- ------------------------------------------------------------ global config --
-- No zone column, so reads are unrestricted and only the write is role-gated.
-- app_settings reads must stay open: SettingsService.refresh() loads the cache
-- at boot, before any user context exists.

ALTER TABLE system_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_templates_role ON system_templates
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin']));
--> statement-breakpoint

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_settings_role ON app_settings
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin']));
```

- [ ] **Step 2: Apply it against a local database**

Run: `npm --prefix server run start:dev` is not the way. Apply migrations directly:

```bash
node server/scripts/migrate.mjs
```

Expected: the migration applies and is recorded in `schema_migrations`.

- [ ] **Step 3: Prove an auditor cannot write**

```bash
psql "${DATABASE_URL_APP:-postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr}" -c \
"BEGIN; SELECT set_config('app.current_role','auditor',true), set_config('app.current_zone','*',true);
 UPDATE cases SET status='closed'; ROLLBACK;"
```

Expected: `ERROR: new row violates row-level security policy for table "cases"`.

- [ ] **Step 4: Prove an approver still can**

```bash
psql "${DATABASE_URL_APP:-postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr}" -c \
"BEGIN; SELECT set_config('app.current_role','approver',true), set_config('app.current_zone','EUR',true);
 UPDATE cases SET status='in_progress' WHERE zone_id='EUR'; ROLLBACK;"
```

Expected: `UPDATE <n>`, no error. If this fails, the matrix is wrong — stop and report rather than widening the array until it passes.

- [ ] **Step 5: Document the escape hatch in the README**

Add to the README's operations material, near the deployment section:

```markdown
### If a role policy locks operators out

Migration `0013_role-matrix.sql` enforces role authorization in the database.
If a predicate is wrong, one statement restores the previous behaviour without
a rollback — role enforcement falls back to the application layer, where it
lived before that migration:

```sql
CREATE OR REPLACE FUNCTION app_role_may_write(text[]) RETURNS boolean
  AS $$ SELECT true $$ LANGUAGE sql STABLE;
```

Restore the real function from the migration once the predicate is fixed.
```

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/drizzle/0013_role-matrix.sql README.md
git commit
```

Message: `Enforce the role matrix in the database, not only the decorator`

---

### Task 8: Prove the matrix against a real database

**Files:**
- Modify: `server/scripts/rls-check.mjs`

**Interfaces:**
- Consumes: the policies from Task 7 and the existing `inZone(zone, role, fn)` helper.
- Produces: `node server/scripts/rls-check.mjs --roles`, exiting non-zero on any matrix violation.

A policy is the one thing that cannot be verified by reading TypeScript. This script is where it is proved.

- [ ] **Step 1: Add the role matrix mode**

Append to `server/scripts/rls-check.mjs`, before its final exit:

```js
// --roles: prove the write matrix from 0013_role-matrix.sql. Zone isolation is
// covered above; this asserts who may write, per role, per table.
if (process.argv.includes('--roles')) {
  const tryWrite = async (role, zone, sql) => {
    try {
      await app.query('BEGIN');
      await app.query(
        `SELECT set_config('app.current_role', $1, true), set_config('app.current_zone', $2, true)`,
        [role, zone],
      );
      await app.query(sql);
      await app.query('ROLLBACK');
      return true;
    } catch {
      await app.query('ROLLBACK');
      return false;
    }
  };

  const CASE_WRITE = `UPDATE cases SET status = 'in_progress' WHERE zone_id = 'EUR'`;
  const USER_WRITE = `UPDATE users SET capacity_weight = capacity_weight WHERE zone_id = 'EUR'`;
  const SETTING_WRITE = `INSERT INTO app_settings (key, value) VALUES ('rls_probe','x')
                         ON CONFLICT (key) DO UPDATE SET value = 'x'`;

  for (const role of ['super_admin', 'admin', 'zone_manager', 'approver']) {
    check(`${role} may write a case`, await tryWrite(role, 'EUR', CASE_WRITE));
  }
  check('auditor may not write a case', !(await tryWrite('auditor', '*', CASE_WRITE)));

  for (const role of ['super_admin', 'admin', 'zone_manager']) {
    check(`${role} may write a user`, await tryWrite(role, role === 'zone_manager' ? 'EUR' : '*', USER_WRITE));
  }
  check('approver may not write a user', !(await tryWrite('approver', 'EUR', USER_WRITE)));
  check('auditor may not write a user', !(await tryWrite('auditor', '*', USER_WRITE)));

  check('super_admin may write a setting', await tryWrite('super_admin', '*', SETTING_WRITE));
  check('admin may not write a setting', !(await tryWrite('admin', '*', SETTING_WRITE)));
  check('zone_manager may not write a setting', !(await tryWrite('zone_manager', 'EUR', SETTING_WRITE)));
}
```

- [ ] **Step 2: Seed a user the probe can target**

The script seeds two cases as the owner role. Add an EUR user alongside them, in the same owner-role block near the top:

```js
await admin.query(`
  INSERT INTO users (email, name, role, zone_id)
  VALUES ('rls-probe@example.com','RLS Probe','approver','EUR')
  ON CONFLICT (email) DO NOTHING
`);
```

- [ ] **Step 3: Run both modes**

```bash
node server/scripts/rls-check.mjs
node server/scripts/rls-check.mjs --roles
```

Expected: every line `ok`, exit 0. A `FAIL` here means the policy and the plan disagree — report which, do not adjust the assertion to match the policy.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/rls-check.mjs
git commit
```

Message: `Prove the write matrix against a real database`

---

## Definition of done

- [ ] `grep -rn "@Roles(\|satisfies(\|RANK" server/src --include=*.ts` returns nothing.
- [ ] Every role's grants are asserted in `permissions.spec.ts`, and `auditor` holds only `audit.read`.
- [ ] `canAssignRole` is the only place a role assignment is refused, called from both the create and update paths, and a zone manager cannot move a user into another zone.
- [ ] `zoneContextFor` passes `super_admin` through; `ZoneContext` no longer declares `public`.
- [ ] Every surviving `db.system()` in `admin/`, `forms/`, `email/system-template.service.ts` and `settings/` carries a comment saying why.
- [ ] `node server/scripts/rls-check.mjs` and `--roles` both pass.
- [ ] An auditor context is refused a case write by Postgres, not by Nest.
- [ ] The escape hatch is in both the migration header and the README.
- [ ] `npm --prefix server test` and `npm --prefix server run build` are green.
