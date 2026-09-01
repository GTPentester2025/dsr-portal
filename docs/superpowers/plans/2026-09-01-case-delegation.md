# Case Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an approver send a case to a named group of people who have no portal login, have one of them accept it, and have the PDFs they send back land in the case file.

**Architecture:** Three new tables (`case_groups`, `case_group_members`, `case_delegations`). One bearer token per delegation, hashed at rest, whose permitted action is a function of the delegation's stage — `sent` allows Accept, `accepted` allows Upload, `closed` allows nothing. Ownership, assignment and the SLA clock are untouched throughout: a delegation records where the work is, not who is responsible. The public page discloses the case reference, request type, deadline and the approver's note, and none of the requester's personal data.

**Tech Stack:** NestJS 11, Drizzle ORM, PostgreSQL with row-level security, React 19 + Vite, Jest.

**Spec:** `docs/superpowers/specs/2026-09-01-case-delegation-design.md`

## Global Constraints

- **Group management is `cases.work`**, not `config.manage`. This resolves the open decision in §1 of the spec in favour of the original request: managers, approvers and admins can all create groups.
- **Every mutation route on a case calls `CaseSourceGuard.assertLive(ctx, id, action)` first.** Imported cases are records; they cannot be delegated.
- **Tokens are never stored in plaintext.** Generate with `randomBytes(32).toString('base64url')`, store `crypto.sha256Hex(token)`, and put the plaintext only in the email.
- **Uploads are PDF only, verified by magic bytes** (`%PDF-` = `0x25 0x50 0x44 0x46 0x2D`), never by filename or by the `Content-Type` header.
- **The public payload must never contain requester fields.** No `requesterEmail`, `requesterName`, `fields`, `requesterEmailEnc`.
- **New tables get RLS**, matching the convention in `drizzle/0013_role-matrix.sql`: a zone policy using `app_zone_allows(zone_id)` and a `RESTRICTIVE ... FOR DELETE` policy using `app_role_may_write(...)`.
- **Migrations** are numbered sequentially from `0023`, statements separated by `--> statement-breakpoint`, applied with `node scripts/migrate.mjs`.
- Repo root for all paths: `C:/Users/GT/Downloads/dsr-portal-upstream`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/drizzle/0023_case-delegation.sql` | Three tables, indexes, RLS |
| `server/src/delegation/delegation-rules.ts` | Pure: stage→action rules, PDF sniffing |
| `server/src/delegation/delegation-rules.spec.ts` | Unit tests for the above |
| `server/src/delegation/delegation.service.ts` | Create, accept, upload, close |
| `server/src/delegation/groups.service.ts` | Group and member CRUD |
| `server/src/delegation/delegation.controller.ts` | Internal routes |
| `server/src/delegation/public-delegation.controller.ts` | Public token routes |
| `server/src/delegation/delegation.module.ts` | Wiring |
| `apps/admin/src/pages/GroupsPage.tsx` | Group management screen |
| `apps/admin/src/components/DelegationCard.tsx` | Case-detail card + send dialog |
| `apps/public-form/src/DelegationPage.tsx` | The page the link opens |

**Modified**

| File | Change |
|---|---|
| `server/src/db/schema.ts` | Three table definitions |
| `server/src/app.module.ts` | Register `DelegationModule` |
| `server/src/email/templates.ts` | `delegation-invite` template |
| `server/src/cases/cases.service.ts` | Delegation summary on case detail |
| `apps/admin/src/App.tsx`, `components/AppShell.tsx` | Route + nav for Groups |
| `apps/admin/src/lib/api.ts` | Types |
| `apps/admin/src/pages/CaseDetailPage.tsx` | Mount `DelegationCard` |
| `apps/public-form/src/App.tsx` | Route `#/delegation/:token` |

---

### Task 1: Schema and migration

**Files:**
- Create: `server/drizzle/0023_case-delegation.sql`
- Modify: `server/src/db/schema.ts`

**Interfaces:**
- Consumes: nothing
- Produces: tables `case_groups`, `case_group_members`, `case_delegations`; Drizzle exports `caseGroups`, `caseGroupMembers`, `caseDelegations`

- [ ] **Step 1: Write the migration**

Create `server/drizzle/0023_case-delegation.sql`:

```sql
-- Sending a case to people who do not use this portal.
--
-- Working a request often needs somebody outside the privacy team: HR to
-- confirm employment dates, Legal to check for a hold. That exchange happens
-- in Outlook today, so who was asked and what came back live in one person's
-- mailbox rather than in the case file.
--
-- A group is a standing list of those people. A delegation is one send to one
-- group, addressed by a single bearer token whose permitted action depends on
-- how far the delegation has got.

CREATE TABLE IF NOT EXISTS case_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id         text NOT NULL REFERENCES zones(id),
  name            text NOT NULL,
  /* Pre-filled when sending to this group, editable before it goes. */
  default_message text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_groups_zone_name_ux
  ON case_groups (zone_id, lower(name));
--> statement-breakpoint

-- No account, no password, no role: a display name and somewhere to write to.
CREATE TABLE IF NOT EXISTS case_group_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES case_groups(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_group_members_group_email_ux
  ON case_group_members (group_id, lower(email));
--> statement-breakpoint

/*
 * One row per send.
 *
 * `token_hash` only: the plaintext exists in the email and nowhere else, so a
 * database dump does not hand over working links. Same treatment
 * verification_tokens already gets.
 *
 * `stage` is what the token permits. 'sent' allows accepting, 'accepted'
 * allows uploading, 'closed' allows nothing -- so an action becomes impossible
 * the moment the stage it belonged to is past.
 */
CREATE TABLE IF NOT EXISTS case_delegations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                uuid NOT NULL REFERENCES cases(id),
  group_id               uuid NOT NULL REFERENCES case_groups(id),
  zone_id                text NOT NULL REFERENCES zones(id),
  token_hash             text NOT NULL,
  stage                  text NOT NULL DEFAULT 'sent',
  note                   text NOT NULL DEFAULT '',
  accepted_by_member_id  uuid REFERENCES case_group_members(id),
  accepted_at            timestamptz,
  closed_at              timestamptz,
  closed_by              uuid REFERENCES users(id),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_delegations_token_ux
  ON case_delegations (token_hash);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS case_delegations_case_ix
  ON case_delegations (case_id, created_at DESC);
--> statement-breakpoint

-- Only one delegation may be live on a case at a time. Two open links to the
-- same case is two groups each believing the other is not involved.
CREATE UNIQUE INDEX IF NOT EXISTS case_delegations_one_open_ux
  ON case_delegations (case_id)
  WHERE stage <> 'closed';
--> statement-breakpoint

-- Zone isolation and write roles, exactly as 0013 does for every other
-- zone-scoped table.
ALTER TABLE case_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_groups_zone_role ON case_groups
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint
CREATE POLICY case_groups_delete_role ON case_groups AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

ALTER TABLE case_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_group_members_zone ON case_group_members
  USING (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id)));
--> statement-breakpoint

ALTER TABLE case_delegations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_delegations_zone ON case_delegations
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id));
--> statement-breakpoint

-- Uploads arriving this way are marked so the case file says where each
-- document came from.
COMMENT ON COLUMN case_delegations.stage IS
  'sent | accepted | closed. Decides what the delegation token permits.';
```

- [ ] **Step 2: Apply it and verify**

```bash
cd server
node scripts/dev-db.mjs &
sleep 22
DATABASE_URL=postgres://dsr:dsr@127.0.0.1:5433/dsr node scripts/migrate.mjs
```

Expected: `applied 0023_case-delegation.sql (N statements)`.

- [ ] **Step 3: Add the Drizzle definitions**

In `server/src/db/schema.ts`, after `caseImports`:

```ts
/** A standing list of people outside the portal who can be sent a case. */
export const caseGroups = pgTable(
  'case_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    zoneId: text('zone_id').notNull().references(() => zones.id),
    name: text('name').notNull(),
    /** Pre-filled when sending to this group, editable before it goes. */
    defaultMessage: text('default_message').notNull().default(''),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('case_groups_zone_name_ux').on(t.zoneId, t.name)],
);

/** No account, no password, no role: a name and somewhere to write to. */
export const caseGroupMembers = pgTable(
  'case_group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id').notNull().references(() => caseGroups.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('case_group_members_group_email_ux').on(t.groupId, t.email)],
);

/**
 * One send to one group.
 *
 * `stage` is what the token permits, not merely where the work has got to:
 * 'sent' allows accepting, 'accepted' allows uploading, 'closed' allows
 * nothing. An action becomes impossible the moment its stage is past.
 */
export const caseDelegations = pgTable(
  'case_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    groupId: uuid('group_id').notNull().references(() => caseGroups.id),
    zoneId: text('zone_id').notNull().references(() => zones.id),
    /** SHA-256 of the token; the plaintext exists only in the email. */
    tokenHash: text('token_hash').notNull(),
    stage: text('stage').notNull().default('sent'),
    note: text('note').notNull().default(''),
    acceptedByMemberId: uuid('accepted_by_member_id').references(() => caseGroupMembers.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('case_delegations_token_ux').on(t.tokenHash),
    index('case_delegations_case_ix').on(t.caseId),
  ],
);
```

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/0023_case-delegation.sql server/src/db/schema.ts
git commit -m "Add the tables a case delegation needs"
```

---

### Task 2: Stage rules and PDF sniffing

**Files:**
- Create: `server/src/delegation/delegation-rules.ts`
- Test: `server/src/delegation/delegation-rules.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type DelegationStage = 'sent' | 'accepted' | 'closed'`; `permits(stage, action): boolean`; `nextStage(action): DelegationStage`; `isPdf(buffer): boolean`; `PDF_MAGIC`

- [ ] **Step 1: Write the failing test**

Create `server/src/delegation/delegation-rules.spec.ts`:

```ts
import { isPdf, nextStage, permits } from './delegation-rules';

/**
 * The stage table is the whole security model of the link: what a token can do
 * is decided here and nowhere else, so every combination is pinned down rather
 * than only the interesting ones.
 */
describe('permits', () => {
  it('allows accepting only while the delegation is unanswered', () => {
    expect(permits('sent', 'accept')).toBe(true);
    expect(permits('accepted', 'accept')).toBe(false);
    expect(permits('closed', 'accept')).toBe(false);
  });

  it('allows uploading only after somebody has accepted', () => {
    expect(permits('sent', 'upload')).toBe(false);
    expect(permits('accepted', 'upload')).toBe(true);
    expect(permits('closed', 'upload')).toBe(false);
  });

  it('allows the page to be read at every stage, including closed', () => {
    // A dead end that explains itself is worth more than a 404, and it
    // discloses nothing the holder of the link did not already have.
    expect(permits('sent', 'view')).toBe(true);
    expect(permits('accepted', 'view')).toBe(true);
    expect(permits('closed', 'view')).toBe(true);
  });

  it('permits nothing for a stage it does not recognise', () => {
    expect(permits('nonsense' as never, 'accept')).toBe(false);
    expect(permits('nonsense' as never, 'upload')).toBe(false);
    expect(permits('nonsense' as never, 'view')).toBe(false);
  });
});

describe('nextStage', () => {
  it('moves the delegation on', () => {
    expect(nextStage('accept')).toBe('accepted');
    expect(nextStage('close')).toBe('closed');
  });

  it('leaves the stage alone for an upload', () => {
    // Uploading is not progress: HR may send three documents.
    expect(nextStage('upload')).toBeNull();
  });
});

describe('isPdf', () => {
  it('accepts a real PDF', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\nstuff'))).toBe(true);
  });

  it('rejects an executable renamed to .pdf', () => {
    // The obvious attack on an upload box open to unauthenticated callers.
    expect(isPdf(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe(false);
  });

  it('rejects HTML, which a browser would happily run', () => {
    expect(isPdf(Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
  });

  it('rejects a file too short to have a header', () => {
    expect(isPdf(Buffer.from('%PD'))).toBe(false);
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });

  it('rejects a PDF header that is not at the start', () => {
    expect(isPdf(Buffer.from('   %PDF-1.7'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx jest src/delegation`
Expected: FAIL — `Cannot find module './delegation-rules'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/delegation/delegation-rules.ts`:

```ts
/**
 * What a delegation link may do, and what may be uploaded through it.
 *
 * Pure and dependency-free, because this is the security model of a URL handed
 * to people with no account: it should be readable in one sitting and testable
 * without a database.
 */

export type DelegationStage = 'sent' | 'accepted' | 'closed';
export type DelegationAction = 'view' | 'accept' | 'upload';

/**
 * Each action is possible in exactly one stage, which is what "the link
 * expires when the stage changes" amounts to. Viewing is the exception: a
 * closed delegation still renders a page saying so, because a dead end that
 * explains itself is more use to the person holding the link than an error,
 * and it discloses nothing they did not already have.
 */
const ALLOWED: Record<DelegationStage, DelegationAction[]> = {
  sent: ['view', 'accept'],
  accepted: ['view', 'upload'],
  closed: ['view'],
};

export function permits(stage: DelegationStage, action: DelegationAction): boolean {
  return (ALLOWED[stage] ?? []).includes(action);
}

/** The stage an action moves the delegation to, or null if it does not. */
export function nextStage(action: 'accept' | 'upload' | 'close'): DelegationStage | null {
  if (action === 'accept') return 'accepted';
  if (action === 'close') return 'closed';
  // Uploading is not progress: one delegation may receive several documents.
  return null;
}

/** `%PDF-`, which every PDF starts with. */
export const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * Whether these bytes are a PDF, judged by the bytes.
 *
 * Never by the filename or the declared Content-Type: both are supplied by the
 * uploader, and an executable named `report.pdf` is the first thing anybody
 * tries against an upload box that does not need a login.
 */
export function isPdf(buffer: Buffer): boolean {
  if (buffer.length < PDF_MAGIC.length) return false;
  return buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx jest src/delegation`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/delegation/delegation-rules.ts server/src/delegation/delegation-rules.spec.ts
git commit -m "Decide what a delegation link may do, and what may come through it"
```

---

### Task 3: Groups service and internal group routes

**Files:**
- Create: `server/src/delegation/groups.service.ts`
- Create: `server/src/delegation/delegation.module.ts`
- Modify: `server/src/app.module.ts`

**Interfaces:**
- Consumes: `DbService`, `AuditService` from Task 1's tables
- Produces: `GroupsService.list(ctx)`, `.create(ctx, {zoneId, name, defaultMessage, members, actorId})`, `.update(ctx, id, patch, actorId)`, `.membersOf(ctx, groupId)`

- [ ] **Step 1: Write the service**

Create `server/src/delegation/groups.service.ts`:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

export interface GroupMemberInput {
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Standing lists of people outside the portal who can be sent a case.
 *
 * Zone-scoped like everything else, so an approver sees their own zone's
 * groups. Membership is a name and an address: these people never get an
 * account, and nothing here should imply they might.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: ZoneContext) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT g.id, g.zone_id, g.name, g.default_message, g.active, g.created_at,
                COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'email', m.email)
                         ORDER BY m.name) FILTER (WHERE m.id IS NOT NULL), '[]') AS members
           FROM case_groups g
      LEFT JOIN case_group_members m ON m.group_id = g.id
          GROUP BY g.id
          ORDER BY g.zone_id, g.name`,
      );
      return r.rows;
    });
  }

  /** Members with a usable address, which is who an invitation can reach. */
  async membersOf(ctx: ZoneContext, groupId: string) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT m.id, m.name, m.email
           FROM case_group_members m
           JOIN case_groups g ON g.id = m.group_id
          WHERE m.group_id = $1 AND g.active
          ORDER BY m.name`,
        [groupId],
      );
      return r.rows as { id: string; name: string; email: string }[];
    });
  }

  async create(
    ctx: ZoneContext,
    args: {
      zoneId: string;
      name: string;
      defaultMessage?: string;
      members: GroupMemberInput[];
      actorId: string;
    },
  ) {
    const name = args.name?.trim();
    if (!name) throw new BadRequestException('The group needs a name');
    const members = this.cleanMembers(args.members);
    if (members.length === 0) {
      throw new BadRequestException('A group with nobody in it cannot be sent anything');
    }

    const group = await this.db.withContext(ctx, async (_db, client) => {
      const g = await client.query(
        `INSERT INTO case_groups (zone_id, name, default_message, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [args.zoneId, name, args.defaultMessage ?? '', args.actorId],
      );
      const id = g.rows[0].id as string;
      for (const m of members) {
        await client.query(
          'INSERT INTO case_group_members (group_id, name, email) VALUES ($1,$2,$3)',
          [id, m.name, m.email],
        );
      }
      return id;
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'group.created',
      entityType: 'case_group',
      entityId: group,
      zoneId: args.zoneId,
      after: { name, members: members.map((m) => m.email) },
    });
    return { id: group };
  }

  async update(
    ctx: ZoneContext,
    id: string,
    patch: { name?: string; defaultMessage?: string; active?: boolean; members?: GroupMemberInput[] },
    actorId: string,
  ) {
    const before = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query('SELECT * FROM case_groups WHERE id = $1', [id]);
      return r.rows[0];
    });
    if (!before) throw new NotFoundException();

    const members = patch.members ? this.cleanMembers(patch.members) : null;
    if (members && members.length === 0) {
      throw new BadRequestException('A group with nobody in it cannot be sent anything');
    }

    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        `UPDATE case_groups SET
           name = COALESCE($2, name),
           default_message = COALESCE($3, default_message),
           active = COALESCE($4, active)
         WHERE id = $1`,
        [id, patch.name?.trim() ?? null, patch.defaultMessage ?? null, patch.active ?? null],
      );
      if (members) {
        // Replaced wholesale: the screen edits the list as a list, and a
        // member removed there has to actually go, or they keep receiving
        // invitations nobody meant to send them.
        await client.query('DELETE FROM case_group_members WHERE group_id = $1', [id]);
        for (const m of members) {
          await client.query(
            'INSERT INTO case_group_members (group_id, name, email) VALUES ($1,$2,$3)',
            [id, m.name, m.email],
          );
        }
      }
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'group.updated',
      entityType: 'case_group',
      entityId: id,
      zoneId: before.zone_id,
      before: { name: before.name, active: before.active },
      after: { ...patch, members: members?.map((m) => m.email) },
    });
    return { ok: true };
  }

  private cleanMembers(members: GroupMemberInput[]): GroupMemberInput[] {
    const seen = new Set<string>();
    const out: GroupMemberInput[] = [];
    for (const m of members ?? []) {
      const email = (m.email ?? '').trim().toLowerCase();
      const name = (m.name ?? '').trim();
      if (!email) continue;
      if (!EMAIL_RE.test(email)) {
        throw new BadRequestException(`${email} is not an email address`);
      }
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ name: name || email, email });
    }
    return out;
  }
}
```

- [ ] **Step 2: Create the module**

Create `server/src/delegation/delegation.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasesModule } from '../cases/cases.module';
import { EmailModule } from '../email/email.module';
import { GroupsService } from './groups.service';
import { StorageService } from '../cases/storage.service';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../public/rate-limit.service';

@Module({
  imports: [AuthModule, CasesModule, EmailModule],
  controllers: [],
  providers: [GroupsService, StorageService, CryptoService, RateLimitService],
})
export class DelegationModule {}
```

- [ ] **Step 3: Register it**

In `server/src/app.module.ts`, add the import and put `DelegationModule` in `imports` after `MigrationModule`:

```ts
import { DelegationModule } from './delegation/delegation.module';
```

- [ ] **Step 4: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/delegation server/src/app.module.ts
git commit -m "Keep standing lists of people a case can be sent to"
```

---

### Task 4: Delegation service

**Files:**
- Create: `server/src/delegation/delegation.service.ts`
- Modify: `server/src/delegation/delegation.module.ts`
- Modify: `server/src/email/templates.ts`

**Interfaces:**
- Consumes: `GroupsService.membersOf`, `permits`, `nextStage`, `isPdf`, `CryptoService.sha256Hex`, `StorageService.save`, `CaseSourceGuard.assertLive`
- Produces: `DelegationService.send(ctx, {caseId, groupId, note, actorId, ip})`, `.close(ctx, caseId, delegationId, actorId)`, `.resolve(token)`, `.accept(token, memberId, ip)`, `.upload(token, file, ip)`

- [ ] **Step 1: Add the email template**

In `server/src/email/templates.ts`, add to `TEMPLATE_VARIABLES`:

```ts
  'delegation-invite': ['case_ref', 'zone', 'request_type', 'due_date', 'note', 'link', 'from_name'],
```

and to `DEFAULTS`:

```ts
  'delegation-invite': {
    subject: 'Help needed on privacy request {{case_ref}}',
    html: `<p>{{from_name}} has asked for your help with privacy request
<strong>{{case_ref}}</strong>, which is due by {{due_date}}.</p>
<blockquote>{{note}}</blockquote>
<p><a href="{{link}}">Open the request</a> to accept it and send documents back.</p>
<p>This link does not show the requester's personal details. If you need them,
reply to this email and ask.</p>`,
  },
```

- [ ] **Step 2: Write the service**

Create `server/src/delegation/delegation.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../cases/storage.service';
import { SettingsService } from '../settings/settings.service';
import { CaseSourceGuard } from '../cases/case-source.guard';
import { GroupsService } from './groups.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';
import { isPdf, nextStage, permits, type DelegationStage } from './delegation-rules';

/** What the public page is allowed to know. Deliberately not the case row. */
export interface PublicDelegationView {
  caseRef: string;
  requestType: string;
  dueDate: string | null;
  note: string;
  groupName: string;
  stage: DelegationStage;
  acceptedBy: string | null;
  /** Only while the delegation is unanswered; empty afterwards. */
  members: { id: string; name: string }[];
  files: { filename: string; uploadedAt: string }[];
}

@Injectable()
export class DelegationService {
  private readonly log = new Logger(DelegationService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly groups: GroupsService,
    private readonly source: CaseSourceGuard,
    private readonly settings: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  // ---- from inside the portal ---------------------------------------------

  /**
   * Send a case to a group.
   *
   * One token for the whole group, so the email is the same for everyone and
   * there is no window where several links are live at once. Who accepted is
   * established on the page instead, from the group's own membership.
   */
  async send(
    ctx: ZoneContext,
    args: { caseId: string; groupId: string; note: string; actorId: string; ip?: string },
  ) {
    const row = await this.source.assertLive(ctx, args.caseId, 'sent to a group');
    const members = await this.groups.membersOf(ctx, args.groupId);
    if (members.length === 0) {
      throw new BadRequestException('That group has nobody in it to write to');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.crypto.sha256Hex(token);

    const delegation = await this.db.withContext(ctx, async (_db, client) => {
      // The partial unique index refuses a second open delegation; turn that
      // into something an operator can act on.
      const open = await client.query(
        `SELECT d.id, g.name FROM case_delegations d
           JOIN case_groups g ON g.id = d.group_id
          WHERE d.case_id = $1 AND d.stage <> 'closed'`,
        [args.caseId],
      );
      if (open.rows[0]) {
        throw new BadRequestException(
          `This case is already with ${open.rows[0].name}. Finish that first.`,
        );
      }
      const r = await client.query(
        `INSERT INTO case_delegations (case_id, group_id, zone_id, token_hash, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [args.caseId, args.groupId, row.zoneId, tokenHash, args.note ?? '', args.actorId],
      );
      return r.rows[0].id as string;
    });

    const context = await this.caseContext(args.caseId);
    const link = `${this.settings.get<string>('PUBLIC_BASE_URL', 'http://127.0.0.1:5180')}/#/delegation/${token}`;

    for (const m of members) {
      try {
        await this.email.sendTransactional(m.email, 'delegation-invite', {
          case_ref: context.caseRef,
          zone: context.zoneId,
          request_type: context.requestType,
          due_date: context.dueDate ?? 'not set',
          note: args.note ?? '',
          link,
          from_name: context.fromName,
        }, { caseId: args.caseId, zoneId: row.zoneId });
      } catch (err) {
        // One unreachable address must not stop the other two being asked.
        // The send guard has already recorded what did not go out.
        this.log.warn(`delegation invite to ${m.email} failed: ${(err as Error).message}`);
      }
    }

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'delegation.sent',
      entityType: 'case',
      entityId: args.caseId,
      zoneId: row.zoneId,
      after: { delegationId: delegation, to: members.map((m) => m.email), note: args.note },
      sourceIp: args.ip,
    });
    return { ok: true, id: delegation, sentTo: members.length };
  }

  /** End it. The link stops working; the record of it does not. */
  async close(ctx: ZoneContext, caseId: string, delegationId: string, actorId: string) {
    const zoneId = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `UPDATE case_delegations
            SET stage = 'closed', closed_at = now(), closed_by = $3
          WHERE id = $1 AND case_id = $2 AND stage <> 'closed'
          RETURNING zone_id`,
        [delegationId, caseId, actorId],
      );
      if (!r.rows[0]) throw new NotFoundException('No open delegation to close');
      return r.rows[0].zone_id as string;
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'delegation.closed',
      entityType: 'case',
      entityId: caseId,
      zoneId,
      after: { delegationId },
    });
    return { ok: true };
  }

  /** Every delegation on a case, for the case screen. */
  async forCase(ctx: ZoneContext, caseId: string) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT d.id, d.stage, d.note, d.created_at, d.accepted_at, d.closed_at,
                g.name AS group_name, m.name AS accepted_by, u.name AS sent_by
           FROM case_delegations d
           JOIN case_groups g ON g.id = d.group_id
      LEFT JOIN case_group_members m ON m.id = d.accepted_by_member_id
      LEFT JOIN users u ON u.id = d.created_by
          WHERE d.case_id = $1
          ORDER BY d.created_at DESC`,
        [caseId],
      );
      return r.rows;
    });
  }

  // ---- from the link ------------------------------------------------------

  /**
   * What the page shows.
   *
   * Built field by field rather than by spreading a case row, because the
   * whole guarantee of this feature is that a bearer token does not disclose
   * the requester. A `SELECT *` here would quietly undo it the next time a
   * column is added.
   */
  async resolve(token: string): Promise<PublicDelegationView> {
    const d = await this.load(token);
    const files = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT filename, created_at FROM case_attachments
          WHERE case_id = $1 AND source = 'delegate'
          ORDER BY created_at`,
        [d.case_id],
      );
      return r.rows as { filename: string; created_at: string }[];
    });
    const members =
      d.stage === 'sent' ? await this.db.system(async (_db, client) => {
        const r = await client.query(
          'SELECT id, name FROM case_group_members WHERE group_id = $1 ORDER BY name',
          [d.group_id],
        );
        return r.rows as { id: string; name: string }[];
      }) : [];

    return {
      caseRef: d.case_ref,
      requestType: (d.request_types ?? []).join(', ') || 'not stated',
      dueDate: d.due_at ? new Date(d.due_at).toISOString().slice(0, 10) : null,
      note: d.note,
      groupName: d.group_name,
      stage: d.stage as DelegationStage,
      acceptedBy: d.accepted_by ?? null,
      members,
      files: files.map((f) => ({
        filename: f.filename,
        uploadedAt: new Date(f.created_at).toISOString().slice(0, 10),
      })),
    };
  }

  async accept(token: string, memberId: string, ip?: string) {
    const d = await this.load(token);
    this.assertPermits(d.stage, 'accept');

    await this.db.system(async (_db, client) => {
      const member = await client.query(
        'SELECT id, name FROM case_group_members WHERE id = $1 AND group_id = $2',
        [memberId, d.group_id],
      );
      if (!member.rows[0]) throw new BadRequestException('That is not one of this group');
      // Conditional on the stage, so two people clicking at once cannot both
      // win: the second update matches nothing.
      const r = await client.query(
        `UPDATE case_delegations
            SET stage = $3, accepted_by_member_id = $2, accepted_at = now()
          WHERE id = $1 AND stage = 'sent'`,
        [d.id, memberId, nextStage('accept')],
      );
      if (r.rowCount === 0) throw new ForbiddenException('Somebody has already accepted this');

      await client.query(
        `INSERT INTO case_status_history (case_id, from_status, to_status, note)
         SELECT $1, status, status, $2 FROM cases WHERE id = $1`,
        [d.case_id, `Accepted by ${member.rows[0].name} (${d.group_name})`],
      );
    });

    await this.audit.record({
      actorType: 'public',
      action: 'delegation.accepted',
      entityType: 'case',
      entityId: d.case_id,
      zoneId: d.zone_id,
      after: { delegationId: d.id, memberId },
      sourceIp: ip,
    });
    return this.resolve(token);
  }

  async upload(
    token: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    ip?: string,
  ) {
    const d = await this.load(token);
    this.assertPermits(d.stage, 'upload');

    if (!file?.buffer?.length) throw new BadRequestException('Choose a file');
    if (!isPdf(file.buffer)) {
      throw new BadRequestException('Only PDF files can be sent through this link');
    }

    const stored = await this.storage.save({
      zoneId: d.zone_id,
      caseRef: d.case_ref,
      originalname: file.originalname,
      mimetype: 'application/pdf',
      size: file.size,
      buffer: file.buffer,
    });

    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO case_attachments
           (case_id, zone_id, case_ref, filename, mime_type, size_bytes, storage_key,
            sha256, scan_status, source, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'clean','delegate',$9)`,
        [
          d.case_id, d.zone_id, d.case_ref, stored.filename, stored.mimeType,
          stored.sizeBytes, stored.storageKey, stored.sha256,
          `Sent by ${d.accepted_by ?? 'a member'} (${d.group_name})`,
        ],
      );
      await client.query(
        `INSERT INTO case_status_history (case_id, from_status, to_status, note)
         SELECT $1, status, status, $2 FROM cases WHERE id = $1`,
        [d.case_id, `${d.group_name} sent ${stored.filename}`],
      );
    });

    await this.audit.record({
      actorType: 'public',
      action: 'delegation.uploaded',
      entityType: 'case',
      entityId: d.case_id,
      zoneId: d.zone_id,
      after: { delegationId: d.id, filename: stored.filename, bytes: stored.sizeBytes },
      sourceIp: ip,
    });
    return this.resolve(token);
  }

  // ---- internals ----------------------------------------------------------

  private assertPermits(stage: string, action: 'accept' | 'upload') {
    if (permits(stage as DelegationStage, action)) return;
    throw new ForbiddenException(
      stage === 'closed'
        ? 'This request has been closed and the link no longer works'
        : action === 'upload'
          ? 'Accept the request before sending documents'
          : 'This request has already been accepted',
    );
  }

  /** Resolve a token to its delegation, or 404. Never leaks why it failed. */
  private async load(token: string) {
    if (!token || token.length < 20) throw new NotFoundException();
    const hash = this.crypto.sha256Hex(token);
    const row = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT d.id, d.case_id, d.group_id, d.zone_id, d.stage, d.note,
                c.case_ref, c.request_types, c.due_at,
                g.name AS group_name, m.name AS accepted_by
           FROM case_delegations d
           JOIN cases c ON c.id = d.case_id
           JOIN case_groups g ON g.id = d.group_id
      LEFT JOIN case_group_members m ON m.id = d.accepted_by_member_id
          WHERE d.token_hash = $1`,
        [hash],
      );
      return r.rows[0];
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async caseContext(caseId: string) {
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT c.case_ref, c.zone_id, c.request_types, c.due_at, u.name AS from_name
           FROM cases c LEFT JOIN users u ON u.id = c.assignee_id
          WHERE c.id = $1`,
        [caseId],
      );
      const row = r.rows[0];
      return {
        caseRef: row.case_ref as string,
        zoneId: row.zone_id as string,
        requestType: ((row.request_types ?? []) as string[]).join(', ') || 'not stated',
        dueDate: row.due_at ? new Date(row.due_at).toISOString().slice(0, 10) : null,
        fromName: (row.from_name as string) ?? 'The privacy team',
      };
    });
  }
}
```

- [ ] **Step 3: Register the service**

In `delegation.module.ts`, add `DelegationService` to `providers` and import it.

- [ ] **Step 4: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/delegation server/src/email/templates.ts
git commit -m "Send a case to a group, and take back what they send"
```

---

### Task 5: Internal and public controllers

**Files:**
- Create: `server/src/delegation/delegation.controller.ts`
- Create: `server/src/delegation/public-delegation.controller.ts`
- Modify: `server/src/delegation/delegation.module.ts`

**Interfaces:**
- Consumes: `GroupsService`, `DelegationService`, `RateLimitService.consume(key, limit)`
- Produces: the eight routes in §7 of the spec

- [ ] **Step 1: Write the internal controller**

Create `server/src/delegation/delegation.controller.ts`:

```ts
import {
  Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { GroupsService, type GroupMemberInput } from './groups.service';
import { DelegationService } from './delegation.service';

/**
 * Groups and delegations from inside the portal.
 *
 * All of it is `cases.work`: sending a case to HR is case work, and so is
 * keeping the list of who in HR to send it to. Putting group management behind
 * `config.manage` would mean an approver could send to a group but not add the
 * colleague they actually need, which is the wrong seam.
 */
@Controller('internal')
@UseGuards(AuthGuard)
export class DelegationController {
  constructor(
    private readonly groups: GroupsService,
    private readonly delegation: DelegationService,
  ) {}

  @Get('groups')
  @Requires('cases.work')
  listGroups(@Req() req: AuthedRequest) {
    return this.groups.list(req.zoneCtx);
  }

  @Post('groups')
  @Requires('cases.work')
  createGroup(
    @Req() req: AuthedRequest,
    @Body() body: { zoneId?: string; name?: string; defaultMessage?: string; members?: GroupMemberInput[] },
  ) {
    // A zone manager or approver gets their own zone whatever they ask for.
    const zoneId =
      req.user.role === 'admin' || req.user.role === 'super_admin'
        ? (body?.zoneId ?? req.user.zoneId ?? '')
        : (req.user.zoneId ?? '');
    return this.groups.create(req.zoneCtx, {
      zoneId,
      name: body?.name ?? '',
      defaultMessage: body?.defaultMessage,
      members: body?.members ?? [],
      actorId: req.user.id,
    });
  }

  @Patch('groups/:id')
  @Requires('cases.work')
  updateGroup(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; defaultMessage?: string; active?: boolean; members?: GroupMemberInput[] },
  ) {
    return this.groups.update(req.zoneCtx, id, body ?? {}, req.user.id);
  }

  @Post('cases/:id/delegate')
  @Requires('cases.work')
  delegate(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { groupId?: string; note?: string },
    @Ip() ip: string,
  ) {
    return this.delegation.send(req.zoneCtx, {
      caseId: id,
      groupId: body?.groupId ?? '',
      note: body?.note ?? '',
      actorId: req.user.id,
      ip,
    });
  }

  @Post('cases/:id/delegations/:did/close')
  @Requires('cases.work')
  closeDelegation(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('did', ParseUUIDPipe) did: string,
  ) {
    return this.delegation.close(req.zoneCtx, id, did, req.user.id);
  }
}
```

- [ ] **Step 2: Write the public controller**

Create `server/src/delegation/public-delegation.controller.ts`:

```ts
import {
  BadRequestException, Body, Controller, Get, Ip, Param, Post,
  TooManyRequestsException, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DelegationService } from './delegation.service';
import { RateLimitService } from '../public/rate-limit.service';

/** PDFs are not large; this is well above a scanned document and well below
 *  anything that would hurt to hold in memory. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * The three routes the emailed link addresses.
 *
 * Unauthenticated by design: these people have no account. Everything they can
 * do is bounded by the delegation's stage, rate-limited per token, and audited
 * with the source IP.
 */
@Controller('public/delegation')
export class PublicDelegationController {
  constructor(
    private readonly delegation: DelegationService,
    private readonly rate: RateLimitService,
  ) {}

  @Get(':token')
  async view(@Param('token') token: string, @Ip() ip: string) {
    await this.guard(`delegation:view:${ip}`, 120);
    return this.delegation.resolve(token);
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: { memberId?: string },
    @Ip() ip: string,
  ) {
    await this.guard(`delegation:accept:${ip}`, 20);
    if (!body?.memberId) throw new BadRequestException('Choose who you are');
    return this.delegation.accept(token, body.memberId, ip);
  }

  @Post(':token/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES } }))
  async upload(
    @Param('token') token: string,
    @UploadedFile() file: Express.Multer.File,
    @Ip() ip: string,
  ) {
    await this.guard(`delegation:upload:${ip}`, 40);
    return this.delegation.upload(token, file, ip);
  }

  /** Per IP rather than per token: a leaked link should not become a way to
   *  hammer the service, and the token is the thing being protected. */
  private async guard(key: string, limit: number) {
    const ok = await this.rate.consume(key, limit);
    if (!ok) throw new TooManyRequestsException('Too many attempts. Try again shortly.');
  }
}
```

- [ ] **Step 3: Register both controllers**

In `delegation.module.ts`, set `controllers: [DelegationController, PublicDelegationController]`.

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit -p tsconfig.json`

If `TooManyRequestsException` is not exported by this NestJS version, replace it with:

```ts
import { HttpException, HttpStatus } from '@nestjs/common';
// ...
throw new HttpException('Too many attempts. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
```

- [ ] **Step 5: Commit**

```bash
git add server/src/delegation
git commit -m "Expose delegation to the portal and to the link"
```

---

### Task 6: Surface delegations on the case

**Files:**
- Modify: `server/src/cases/cases.service.ts`

**Interfaces:**
- Consumes: `case_delegations`
- Produces: `detail()` returns `delegations: {id, stage, group_name, accepted_by, note, created_at, accepted_at, closed_at, sent_by}[]`

- [ ] **Step 1: Add the query to `detail()`**

In `detail()`, beside the `emails` query:

```ts
      // What the case has been sent out to, and where that got to.
      const delegations = await client.query(
        `SELECT d.id, d.stage, d.note, d.created_at, d.accepted_at, d.closed_at,
                g.name AS group_name, m.name AS accepted_by, u.name AS sent_by
           FROM case_delegations d
           JOIN case_groups g ON g.id = d.group_id
      LEFT JOIN case_group_members m ON m.id = d.accepted_by_member_id
      LEFT JOIN users u ON u.id = d.created_by
          WHERE d.case_id = $1
          ORDER BY d.created_at DESC`,
        [id],
      );
```

and add to the returned object:

```ts
        delegations: delegations.rows,
```

- [ ] **Step 2: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/cases/cases.service.ts
git commit -m "Show a case what it has been sent out to"
```

---

### Task 7: Integration test

**Files:**
- Create: `server/scripts/e2e-delegation.mjs`

**Interfaces:**
- Consumes: every route from Tasks 3–6
- Produces: a runnable check, in the style of `scripts/e2e-intake.mjs`

- [ ] **Step 1: Write the test**

Create `server/scripts/e2e-delegation.mjs`. Model it on `scripts/e2e-workflow.mjs` for the login and `check()` helpers. It must assert:

```
1  create a group with three members
2  send a case to it            -> 3 emails in email_log, one delegation row
3  GET the public view          -> contains caseRef, requestType, dueDate, note
                                 -> contains NO requesterEmail, requesterName,
                                    fields, cpf, dob, phone   (field by field)
4  upload before accepting      -> 403
5  accept as member 2           -> stage 'accepted', case timeline names them
6  accept again                 -> 403, first accepter stands
7  upload a real PDF            -> appears in case_attachments source='delegate'
8  upload an EXE named .pdf     -> 400, nothing stored
9  case assignee/status/SLA     -> unchanged since step 2
10 close the delegation         -> stage 'closed'
11 upload after close           -> 403
12 GET the view after close     -> 200, says closed, still no requester data
13 delegate an imported case    -> 403 from CaseSourceGuard
14 nothing sent to the requester at any point
```

- [ ] **Step 2: Run it against a live server**

```bash
cd server
node scripts/dev-db.mjs &
sleep 22
DATABASE_URL=postgres://dsr:dsr@127.0.0.1:5433/dsr node scripts/migrate.mjs
node scripts/import-forms.mjs
node scripts/create-user.mjs admin@example.com "Test Admin" super_admin "" 'Str0ng-Passw0rd!x'
npx nest build && node dist/main &
sleep 16
node scripts/e2e-delegation.mjs
```

Expected: `all checks passed`.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/e2e-delegation.mjs
git commit -m "Prove the delegation cycle end to end"
```

---

### Task 8: Groups screen

**Files:**
- Create: `apps/admin/src/pages/GroupsPage.tsx`
- Modify: `apps/admin/src/App.tsx`, `apps/admin/src/components/AppShell.tsx`, `apps/admin/src/lib/api.ts`

**Interfaces:**
- Consumes: `GET/POST/PATCH /internal/groups`
- Produces: route `#/groups`; types `CaseGroup`, `GroupMember`

- [ ] **Step 1: Add the types**

In `apps/admin/src/lib/api.ts`:

```ts
export interface GroupMember {
  id?: string
  name: string
  email: string
}

/** A standing list of people outside the portal a case can be sent to. */
export interface CaseGroup {
  id: string
  zone_id: string
  name: string
  default_message: string
  active: boolean
  members: GroupMember[]
}

export interface CaseDelegation {
  id: string
  stage: 'sent' | 'accepted' | 'closed'
  note: string
  group_name: string
  accepted_by: string | null
  sent_by: string | null
  created_at: string
  accepted_at: string | null
  closed_at: string | null
}
```

and add `delegations?: CaseDelegation[]` to `CaseDetail`.

- [ ] **Step 2: Build the page**

Create `apps/admin/src/pages/GroupsPage.tsx` following the structure of `TeamPage.tsx`: a `PageHeader`, a `Card` per group listing members, an "Add group" `Modal` with name, default message and a repeatable name/email row, and an active `Switch`. Use `api.get<CaseGroup[]>('/internal/groups')`, `api.post`, `api.patch`.

Copy for the empty state: *"No groups yet. A group is a set of people outside the portal — HR, Legal, Security — you can send a case to for help."*

- [ ] **Step 3: Route and nav**

`App.tsx`: import `GroupsPage`, add `'#/groups': ['super_admin', 'admin', 'zone_manager', 'approver']` to `GUARD`, and a branch rendering it with title `Groups`.

`AppShell.tsx`: add to `NAV` after Team:

```ts
  { path: '#/groups', label: 'Groups', icon: 'users' },
```

- [ ] **Step 4: Typecheck, build, commit**

```bash
cd apps/admin && npx tsc -b --force --noEmit && npx vite build
git add apps/admin/src
git commit -m "Manage the groups a case can be sent to"
```

---

### Task 9: Delegation card on the case

**Files:**
- Create: `apps/admin/src/components/DelegationCard.tsx`
- Modify: `apps/admin/src/pages/CaseDetailPage.tsx`

**Interfaces:**
- Consumes: `CaseDetail.delegations`, `POST /internal/cases/:id/delegate`, `.../delegations/:did/close`
- Produces: `<DelegationCard c={c} canAct={canAct} reload={reload} />`

- [ ] **Step 1: Build the card**

Create `apps/admin/src/components/DelegationCard.tsx`. It shows:

- when there is no open delegation and `canAct`: a "Send to a group" button opening a `Modal` with a group `Select` (loaded from `/internal/groups`, filtered to active) and a `Textarea` pre-filled from that group's `default_message`, refilled when the group changes
- when there is an open one: the group name, the stage as a `Chip` (`Sent` / `Accepted by X`), the note, and a "Done with HR" button labelled with the actual group name
- closed ones, collapsed, as history

The stage chip tones: `sent` → `brand`, `accepted` → `positive`, `closed` → `neutral`.

- [ ] **Step 2: Mount it**

In `CaseDetailPage.tsx`, beside `<DeliveryCard .../>`:

```tsx
        <DelegationCard c={c} canAct={canAct} reload={reload} />
```

`canAct` is already false for imported and closed cases, which is correct — neither should be sent anywhere.

- [ ] **Step 3: Typecheck, build, commit**

```bash
cd apps/admin && npx tsc -b --force --noEmit && npx vite build
git add apps/admin/src
git commit -m "Send a case to a group from the case screen"
```

---

### Task 10: The page the link opens

**Files:**
- Create: `apps/public-form/src/DelegationPage.tsx`
- Modify: `apps/public-form/src/App.tsx`

**Interfaces:**
- Consumes: `GET/POST /public/delegation/:token`
- Produces: route `#/delegation/:token`

- [ ] **Step 1: Build the page**

Create `apps/public-form/src/DelegationPage.tsx`. One screen, three states driven by `stage`:

- `sent` — what is being asked, the note, the deadline; then "Which of you are you?" as a radio list of `members`, and an Accept button
- `accepted` — "Thank you, {acceptedBy}"; a file input accepting `application/pdf` only, an upload button, and the list of files already sent
- `closed` — "This request has been closed. Thank you for your help." Nothing actionable.

Upload with `FormData` and `fetch`, since this app has no `api.upload`. On a 400, show the server's message — "Only PDF files can be sent through this link" is exactly what the person needs to read.

Show the case reference and deadline throughout. Show nothing else about the requester; there is nothing else in the payload.

- [ ] **Step 2: Route it**

In `apps/public-form/src/App.tsx`, alongside the existing hash routing:

```tsx
const delegation = /^#\/delegation\/([A-Za-z0-9_-]{20,})$/.exec(hash)
if (delegation) return <DelegationPage token={delegation[1]} />
```

- [ ] **Step 3: Typecheck, build, commit**

```bash
cd apps/public-form && npx tsc -b --force --noEmit && npx vite build
git add apps/public-form/src
git commit -m "Give the emailed link somewhere to land"
```

---

### Task 11: Documentation

**Files:**
- Create: `docs/DELEGATION.md`
- Modify: `README.md`

- [ ] **Step 1: Write it**

Cover: what a group is and who can manage one; the three stages and what each permits; what the public page does and does not show, and why; that PDFs are checked by magic bytes; that ownership and the SLA clock never move; and that a case can have only one open delegation at a time.

- [ ] **Step 2: Link it from the README** beside the Migration entry, and commit.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 Groups | 1, 3, 8 |
| §2 Delegation and token | 1, 2, 4 |
| §3 The cycle | 4, 5, 9, 10 |
| §4 Ownership does not move | asserted in 7, step 9 |
| §5 What the link discloses | 4 (`resolve`), asserted field by field in 7 |
| §6 Security | 2 (PDF), 4 (hashing), 5 (rate limit), 4 (audit) |
| §7 Interfaces | 5 |
| §8 User interface | 8, 9, 10 |
| §9 Testing | 2 (unit), 7 (integration) |

The spec's open decision on group permissions is resolved in Global Constraints in favour of the original request: `cases.work`, so approvers can create groups. Task 1's RLS policy and Task 5's decorators both reflect that.

**Placeholders:** none. Tasks 8, 9 and 10 describe screens in prose rather than giving full JSX, which is deliberate — they follow named existing components (`TeamPage`, `DeliveryCard`) that the implementer will read, and prescribing every line of markup would be worse than pointing at the pattern. Every server-side step contains the actual code.

**Type consistency:** `permits(stage, action)` and `nextStage(action)` are used in Task 4 exactly as defined in Task 2. `DelegationStage` is the same union throughout. `storage.save` is called with the argument object its real signature declares. `RateLimitService.consume(key, limit)` returns a boolean and is used as one. `CaseSourceGuard.assertLive(ctx, id, action)` matches the existing signature.

**One risk worth naming:** Task 5 uses `TooManyRequestsException`, which may not exist in this NestJS version. Step 4 of that task carries the fallback rather than leaving the implementer to find it.
