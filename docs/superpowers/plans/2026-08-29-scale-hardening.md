# Scale Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the case list and its exports cheap enough for a hundred thousand cases on one box, and stop a single runaway query from holding the whole portal.

**Architecture:** Index the sort key the list query actually orders by, hoist a per-row aggregate into a CTE, bound the connection pool with a transaction-local `statement_timeout`, and stream exports in keyset batches instead of building them in memory.

**Tech Stack:** NestJS 11, TypeScript (strict), Jest 30, node-postgres, Drizzle, Postgres. No new dependencies — one is removed.

**Spec:** `docs/superpowers/specs/2026-08-29-scale-hardening-design.md`

## Global Constraints

- **No new dependencies.** `pg-query-stream` is explicitly not taken; `pg-boss` is removed.
- Tests are colocated `*.spec.ts` under `server/src`, run with `npm --prefix server test`. Jest `rootDir` is `src`. Existing specs are pure-function tests with **no Nest `TestingModule`** — follow that.
- The suite is **10 suites / 88 tests** at the start of this plan and must stay green.
- Run `npm --prefix server test` and `npm --prefix server run build` before every commit.
- Line endings in this tree are mixed; keep diffs to the lines you change, no whole-file reformats.
- **Commit style:** an imperative sentence, no `feat:`/`fix:` prefix. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NtXEr3cBGDqXwFLmPnFVye
  ```
- Committing directly to `main` is deliberate and approved. Do not create a branch.
- **`statement_timeout` must be set with `set_config('statement_timeout', …, true)`** — the third argument is `is_local`. A bare `SET` is session-scoped and these are pooled connections: the value would outlive its transaction and apply to whichever request took that connection next.
- **The CSV formula-injection defence must survive.** `neutralise()` prefixes a leading `=`, `+`, `-` or `@` so a requester's `=HYPERLINK(...)` does not execute when a colleague opens the export. A refactor is exactly where that gets lost.
- **Postgres has been unreachable all session** (`ECONNREFUSED 127.0.0.1:5433`). Migrations and scripts are written, not applied. Do not start, install or fake a database.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/cases/csv.ts` | gains `CSV_BOM`, `csvHeader()`, `csvRow()`; `toCsv()` reimplemented on them. |
| `server/src/cases/csv.spec.ts` | **new** — byte-identity between streamed and buffered output, and the injection defence. |
| `server/src/cases/keyset.ts` | **new** — the pure cursor helpers the streaming exports page with. |
| `server/src/cases/keyset.spec.ts` | **new** — tie-breaking and no-overlap/no-skip. |
| `server/drizzle/0015_scale-indexes.sql` | **new** — three indexes. |
| `server/src/cases/cases.service.ts` | approver CTE; `exportRows` becomes a batch iterator. |
| `server/src/db/db.module.ts` | pool options and the transaction-local `statement_timeout`. |
| `server/src/cases/cases.controller.ts`, `server/src/admin/admin-users.controller.ts` | stream instead of buffer. |
| `server/src/cases/outbound.service.ts` | three writes onto the caller's context. |
| `server/scripts/explain-check.mjs` | **new** — asserts an index scan, not a sequential scan. |

---

### Task 1: Split the CSV serialiser

**Files:**
- Modify: `server/src/cases/csv.ts`
- Create: `server/src/cases/csv.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CSV_BOM: string`; `export function csvHeader<T>(columns: CsvColumn<T>[]): string`; `export function csvRow<T>(row: T, columns: CsvColumn<T>[]): string`. Both return a line **without** a trailing newline. `toCsv` keeps its exact current signature and output. Task 5 streams with these.

- [ ] **Step 1: Write the failing test**

Create `server/src/cases/csv.spec.ts`:

```ts
import { toCsv, csvHeader, csvRow, CSV_BOM, type CsvColumn } from './csv';

interface Row { name: string; note: string }
const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Note', value: (r) => r.note },
];
const ROWS: Row[] = [
  { name: 'Ada', note: 'plain' },
  { name: 'Bob', note: 'has, comma' },
  { name: 'Cy', note: '=HYPERLINK("http://evil")' },
];

describe('csv streaming pieces', () => {
  it('streams byte-identically to the buffered form', () => {
    const streamed =
      CSV_BOM + [csvHeader(COLUMNS), ...ROWS.map((r) => csvRow(r, COLUMNS))].join('\r\n') + '\r\n';
    expect(streamed).toBe(toCsv(ROWS, COLUMNS));
  });

  it('still neutralises a formula in a streamed row', () => {
    const line = csvRow(ROWS[2], COLUMNS);
    expect(line).toContain(`'=HYPERLINK`);
    expect(line).not.toMatch(/(^|,)"?=HYPERLINK/);
  });

  it('still quotes a value containing a comma', () => {
    expect(csvRow(ROWS[1], COLUMNS)).toContain('"has, comma"');
  });

  it('emits a header without a trailing newline', () => {
    expect(csvHeader(COLUMNS)).toBe('Name,Note');
  });

  it('puts the BOM only at the start, never per row', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(csvRow(ROWS[0], COLUMNS)).not.toContain('﻿');
    expect(csvHeader(COLUMNS)).not.toContain('﻿');
  });
});
```

The first case is the one that matters: it pins the streamed output to the buffered output that ships today, so the refactor cannot quietly change what an operator downloads.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- csv`
Expected: FAIL — `csvHeader`, `csvRow` and `CSV_BOM` are not exported.

- [ ] **Step 3: Split the serialiser**

In `server/src/cases/csv.ts`, leave `neutralise` and `cell` exactly as they are. Add above `toCsv`:

```ts
/**
 * Excel mangles non-ASCII without a byte-order mark, and this data is full of
 * names that need it. Emitted once at the start of a file — never per row.
 */
export const CSV_BOM = '﻿';

/** One header line, no trailing newline. The caller joins with CRLF. */
export function csvHeader<T>(columns: CsvColumn<T>[]): string {
  return columns.map((c) => cell(c.header)).join(',');
}

/** One data line, no trailing newline. Quoting and formula-neutralising as `toCsv`. */
export function csvRow<T>(row: T, columns: CsvColumn<T>[]): string {
  return columns.map((c) => cell(c.value(row))).join(',');
}
```

Then reimplement `toCsv` on them so there is one definition of the format:

```ts
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [csvHeader(columns), ...rows.map((row) => csvRow(row, columns))];
  // CRLF and a UTF-8 BOM: without the BOM Excel mangles non-ASCII names, which
  // this data is full of.
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
```

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS — 5 new cases, 93 tests total.

- [ ] **Step 5: Commit**

```bash
git add server/src/cases/csv.ts server/src/cases/csv.spec.ts
git commit
```

Message: `Let a CSV be written a row at a time`

---

### Task 2: The indexes

**Files:**
- Create: `server/drizzle/0015_scale-indexes.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: three indexes. Task 7's `explain-check.mjs` asserts the first is used.

- [ ] **Step 1: Write the migration**

Create `server/drizzle/0015_scale-indexes.sql`:

```sql
-- The case list orders every page by created_at and there has never been an
-- index on it. audit_log got the equivalent in 0000; cases did not.
--
-- Note what is deliberately NOT here: an index on (zone_id, created_at).
-- Row-level security filters with app_zone_allows(zone_id), a function call
-- rather than an equality, so the planner cannot turn it into a range scan on
-- zone_id -- a zone-prefixed index would sit unused. Indexing the sort key
-- alone lets the planner walk created_at in order, evaluate the RLS predicate
-- per row, and stop when the page is full.
--
-- cases_zone_ix from 0000 is left in place. It is probably unused for the same
-- reason, but dropping an index on the strength of reasoning about a planner
-- nobody has run here is the worse trade.

CREATE INDEX IF NOT EXISTS cases_created_ix ON cases (created_at DESC);
--> statement-breakpoint

-- The country lookup in the list query is a LATERAL keyed on both columns;
-- case_fields_case_ix from 0000 covers only case_id.
CREATE INDEX IF NOT EXISTS case_fields_case_key_ix ON case_fields (case_id, field_key);
--> statement-breakpoint

-- All three SLA filters pair due_at with exactly this predicate, so the partial
-- index is both smaller than a full one and a precise match for the query.
CREATE INDEX IF NOT EXISTS cases_due_open_ix ON cases (due_at) WHERE status <> 'closed';
```

- [ ] **Step 2: Check the ordering claim**

`CREATE INDEX ... (created_at DESC)` and `(created_at)` are equally usable for either scan direction — a btree can be walked backwards. `DESC` is written because it matches the query's `ORDER BY` and reads clearly, not because a plain index would fail. Confirm you have not added a second index that differs only in direction.

- [ ] **Step 3: Apply it if a database is reachable**

```bash
node server/scripts/migrate.mjs
```

Postgres has been unreachable all session. If it still is, say so plainly in your report and move on. Do not start, install or fake one.

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS at 93. No TypeScript changes.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/0015_scale-indexes.sql
git commit
```

Message: `Index the column every case list sorts by`

---

### Task 3: Stop re-aggregating the approver list

**Files:**
- Modify: `server/src/cases/cases.service.ts` (`LIST_SELECT`, and the `ORDER BY` in `list`)

**Interfaces:**
- Consumes: nothing.
- Produces: `LIST_SELECT` keeps the same output columns — `approvers`, `approver_emails`, `country` and the `c.*` set — so `shapeListRow` is untouched.

- [ ] **Step 1: Replace the approver LATERAL with a CTE**

In `server/src/cases/cases.service.ts`, `LIST_SELECT` currently opens with `SELECT` and joins a `LEFT JOIN LATERAL` over `users`. That lateral depends only on `c.zone_id`, so for a 25-row page it runs 25 times to produce at most 3 distinct answers — one per zone.

Replace `LIST_SELECT` with:

```ts
const LIST_SELECT = `
  WITH approvers AS (
    SELECT zone_id,
           string_agg(name, ', ' ORDER BY name) AS names,
           array_agg(email ORDER BY name) AS emails
      FROM users
     WHERE active AND role = 'approver'
     GROUP BY zone_id
  )
  SELECT c.id, c.case_ref, c.zone_id, c.form_key, c.request_types, c.status,
         c.assignee_id, c.due_at, c.created_at, c.requester_email_enc,
         c.pending_party, c.pending_on,
         cf.value_json #>> '{}' AS country,
         COALESCE(app.names, '') AS approvers,
         COALESCE(app.emails, ARRAY[]::text[]) AS approver_emails
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT value_json FROM case_fields
       WHERE case_id = c.id AND field_key = 'country' LIMIT 1
    ) cf ON true
    LEFT JOIN approvers app ON app.zone_id = c.zone_id
   WHERE true`;
```

The country `LATERAL` stays — it genuinely depends on `c.id`, and Task 2's composite index makes it one lookup per row.

- [ ] **Step 2: Make the ordering deterministic**

In `list`, the `ORDER BY c.created_at DESC` cannot break ties, so two cases created in the same millisecond can swap between page loads and one can appear twice or not at all across a page boundary. Change both the paged query in `list` and the query in `exportRows` to:

```sql
ORDER BY c.created_at DESC, c.id DESC
```

This is also the ordering Task 5's keyset cursor depends on.

- [ ] **Step 3: Confirm the shape did not change**

```bash
grep -n "approvers\|approver_emails\|country" server/src/cases/cases.service.ts | head
```

`shapeListRow` must be untouched: the CTE produces the same three column names the lateral did.

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS at 93.

- [ ] **Step 5: Commit**

```bash
git add server/src/cases/cases.service.ts
git commit
```

Message: `Aggregate approvers once per query, not once per row`

---

### Task 4: Bound the pool and the statement

**Files:**
- Modify: `server/src/db/db.module.ts`
- Modify: `server/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `DbService.withContext(ctx, fn, opts?)` where `opts` is `{ statementTimeoutMs?: number }`. Task 5's export paths pass it. `system(fn)` keeps its current signature.

- [ ] **Step 1: Add the pool options**

In `server/src/db/db.module.ts`, the pool is constructed with `max: 10` and nothing else. Replace the options object with:

```ts
    this.pool = new Pool({
      connectionString: config.get<string>(
        'DATABASE_URL',
        'postgres://dsr:dsr@127.0.0.1:5432/dsr',
      ),
      max: Number(config.get<string>('DB_POOL_MAX', '10')),
      // A connection that has been idle this long is closed rather than held
      // against the server's connection limit.
      idleTimeoutMillis: Number(config.get<string>('DB_IDLE_TIMEOUT_MS', '30000')),
      // Fail a request that cannot get a connection rather than queueing behind
      // an exhausted pool until the caller gives up.
      connectionTimeoutMillis: Number(config.get<string>('DB_CONNECT_TIMEOUT_MS', '5000')),
    });
```

Keep the existing `connectionString` line exactly as it is.

- [ ] **Step 2: Set the timeout inside the transaction**

Add a default beside the other constants at the top of the file:

```ts
/** Interactive queries are killed at this point; exports pass their own. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
```

Change `withContext`'s signature and its `set_config` call:

```ts
  async withContext<T>(
    ctx: ZoneContext,
    fn: (db: Db, client: PoolClient) => Promise<T>,
    opts?: { statementTimeoutMs?: number },
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // is_local = true on all three. These are pooled connections: a
      // session-scoped SET would outlive the transaction and apply to whichever
      // request picked this connection up next, so an export's generous timeout
      // would silently become the timeout for unrelated interactive queries.
      await client.query(
        `SELECT set_config('app.current_role', $1, true),
                set_config('app.current_zone', $2, true),
                set_config('statement_timeout', $3, true)`,
        [ctx.role, ctx.zone, String(opts?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)],
      );
```

The rest of the method — the drizzle construction, `fn`, `COMMIT`, the `ROLLBACK` catch and the `finally` release — is unchanged.

- [ ] **Step 2b: Let `system()` forward the same option**

The audit-log export in Task 5 runs cross-zone under `system()` *and* needs the long timeout, so `system` must be able to pass one through:

```ts
  /** System context: full visibility. For schedulers, intake, seeds. */
  system<T>(
    fn: (db: Db, client: PoolClient) => Promise<T>,
    opts?: { statementTimeoutMs?: number },
  ): Promise<T> {
    return this.withContext({ role: 'system', zone: '*' }, fn, opts);
  }
```

Every existing caller passes one argument and still compiles.

- [ ] **Step 3: Document the knobs**

Add to `server/.env.example` under the core section:

```
# Connection pool. Defaults suit one box; raise DB_POOL_MAX only alongside
# Postgres's own max_connections.
DB_POOL_MAX=10
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECT_TIMEOUT_MS=5000
```

- [ ] **Step 4: Confirm the local flag**

```bash
grep -n "set_config('statement_timeout'" server/src/db/db.module.ts
```

The third argument must be `true`. A bare `SET statement_timeout` anywhere in this file is the bug this step exists to prevent.

- [ ] **Step 5: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS at 93. Every existing `withContext` caller still compiles — the new parameter is optional.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/db.module.ts server/.env.example
git commit
```

Message: `Give a connection a deadline and the pool a ceiling`

---

### Task 5: Stream the exports

**Files:**
- Create: `server/src/cases/keyset.ts`
- Create: `server/src/cases/keyset.spec.ts`
- Modify: `server/src/cases/cases.service.ts` (`exportRows` → `streamExportRows`)
- Modify: `server/src/cases/cases.controller.ts`, `server/src/admin/admin-users.controller.ts`

**Interfaces:**
- Consumes: `CSV_BOM`, `csvHeader`, `csvRow` (Task 1); the `withContext` timeout override (Task 4); the `(created_at DESC, id DESC)` ordering (Task 3).
- Produces: `export interface Cursor { createdAt: string; id: string }`; `export function cursorClause(cursor: Cursor | null, nextParamIndex: number): { sql: string; params: unknown[] }`; `export function nextCursor<T extends { createdAt: unknown; id: string }>(batch: T[]): Cursor | null`.

- [ ] **Step 1: Write the failing test**

Create `server/src/cases/keyset.spec.ts`:

```ts
import { cursorClause, nextCursor } from './keyset';

describe('cursorClause', () => {
  it('is empty for the first batch', () => {
    expect(cursorClause(null, 3)).toEqual({ sql: '', params: [] });
  });

  it('compares the pair, not just the timestamp', () => {
    const { sql, params } = cursorClause({ createdAt: '2026-01-01T00:00:00Z', id: 'abc' }, 3);
    // A row-wise comparison is what makes ties safe: ordering by created_at
    // alone would skip or repeat cases sharing a timestamp.
    expect(sql).toContain('(c.created_at, c.id) <');
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(params).toEqual(['2026-01-01T00:00:00Z', 'abc']);
  });
});

describe('nextCursor', () => {
  it('is null for an empty batch, so the loop ends', () => {
    expect(nextCursor([])).toBeNull();
  });

  it('takes the last row of the batch', () => {
    const batch = [
      { createdAt: '2026-01-02T00:00:00Z', id: 'a' },
      { createdAt: '2026-01-01T00:00:00Z', id: 'b' },
    ];
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00Z', id: 'b' });
  });

  it('distinguishes rows sharing a timestamp', () => {
    const batch = [
      { createdAt: '2026-01-01T00:00:00Z', id: 'b' },
      { createdAt: '2026-01-01T00:00:00Z', id: 'a' },
    ];
    // Same instant, different id: the cursor must carry the id or the next
    // batch re-reads 'b' or skips past 'a'.
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00Z', id: 'a' });
  });

  it('normalises a Date to an ISO string', () => {
    const batch = [{ createdAt: new Date('2026-01-01T00:00:00Z'), id: 'a' }];
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: 'a' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- keyset`
Expected: FAIL — `Cannot find module './keyset'`.

- [ ] **Step 3: Create `server/src/cases/keyset.ts`**

```ts
/**
 * Cursor helpers for paging an export in batches.
 *
 * The cursor is the pair (created_at, id), not created_at alone. Two cases
 * created in the same millisecond are not rare in a system fed by a public
 * form, and a timestamp-only cursor either re-reads one of them in the next
 * batch or steps past it -- a duplicated or missing row in a regulatory export.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

/**
 * The predicate continuing from `cursor`, or nothing for the first batch.
 * `nextParamIndex` is the first free $n in the caller's parameter list.
 */
export function cursorClause(
  cursor: Cursor | null,
  nextParamIndex: number,
): { sql: string; params: unknown[] } {
  if (!cursor) return { sql: '', params: [] };
  return {
    sql: ` AND (c.created_at, c.id) < ($${nextParamIndex}, $${nextParamIndex + 1})`,
    params: [cursor.createdAt, cursor.id],
  };
}

/** The last row of a batch, or null when the batch is empty and the loop ends. */
export function nextCursor<T extends { createdAt: unknown; id: string }>(
  batch: T[],
): Cursor | null {
  const last = batch[batch.length - 1];
  if (!last) return null;
  const createdAt =
    last.createdAt instanceof Date ? last.createdAt.toISOString() : String(last.createdAt);
  return { createdAt, id: last.id };
}
```

- [ ] **Step 4: Turn `exportRows` into a batch iterator**

In `server/src/cases/cases.service.ts`, replace `exportRows` with:

```ts
  /**
   * Every case matching the filters, yielded a batch at a time.
   *
   * The old implementation capped at 10,000 rows and built the whole array in
   * memory, so a larger filter silently exported a prefix -- an operator had no
   * way to know the file was short. Batching by keyset bounds memory to one
   * batch and removes the cap.
   */
  async *streamExportRows(ctx: ZoneContext, q: CaseListQuery, batchSize = 1000) {
    let cursor: Cursor | null = null;
    for (;;) {
      const batch: ReturnType<typeof this.shapeListRow>[] = await this.db.withContext(
        ctx,
        async (_db, client) => {
          const { sql: filterSql, params } = listFilters(q);
          const keyset = cursorClause(cursor, params.length + 1);
          const rows = await client.query(
            `${LIST_SELECT} ${filterSql}${keyset.sql}
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ${batchSize}`,
            [...params, ...keyset.params],
          );
          return rows.rows.map((r) => this.shapeListRow(r));
        },
        // An export legitimately outlives an interactive query. Each batch is
        // its own transaction, so this is a per-batch budget, not a total.
        { statementTimeoutMs: 60_000 },
      );
      if (batch.length === 0) return;
      yield batch;
      cursor = nextCursor(batch as { createdAt: unknown; id: string }[]);
      if (batch.length < batchSize) return;
    }
  }
```

Add to the imports: `import { cursorClause, nextCursor, type Cursor } from './keyset';`

Each batch is its own short transaction. That means an export is not a consistent snapshot — a case created mid-export may or may not appear. For an operational CSV that is the right trade against holding one transaction open for the length of a large download.

- [ ] **Step 5: Stream from the cases controller**

In `server/src/cases/cases.controller.ts`, the handler currently takes `@Res({ passthrough: true })` and returns a string. It now owns the response. Replace the body of `exportCsv` after the filter arguments with:

```ts
    const columns = [
      { header: 'Reference', value: (r: CaseListRow) => r.caseRef },
      { header: 'Created', value: (r: CaseListRow) => r.createdAt },
      { header: 'Zone', value: (r: CaseListRow) => r.zoneId },
      { header: 'Country', value: (r: CaseListRow) => r.country },
      { header: 'Request types', value: (r: CaseListRow) => r.requestTypes },
      { header: 'Status', value: (r: CaseListRow) => r.status },
      { header: 'Due', value: (r: CaseListRow) => r.dueAt },
      { header: 'Requester email', value: (r: CaseListRow) => r.requesterEmail },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('cases')}"`);
    res.write(CSV_BOM + csvHeader(columns) + '\r\n');
    for await (const batch of this.cases.streamExportRows(req.zoneCtx, {
      status, zone, slaState, requestType, from, to,
    })) {
      res.write(batch.map((r) => csvRow(r, columns)).join('\r\n') + '\r\n');
    }
    res.end();
```

Change the decorator to `@Res() res: Response` — dropping `passthrough` — and keep every other column exactly as it is today, including any columns after `Requester email` in the current list. Import `CSV_BOM`, `csvHeader` and `csvRow` alongside the existing `toCsv`/`csvFilename` import, and derive `CaseListRow` from the service's row type rather than declaring a new interface.

**Headers must be written before the first `res.write`.** Once a body byte is sent the status cannot change, so a failure mid-export ends a truncated file rather than returning a 500 — that is inherent to streaming and the reason the batch loop must not throw for ordinary empty results.

- [ ] **Step 6: Stream the user export the same way**

`server/src/admin/admin-users.controller.ts` has the second `LIMIT 10000` export, on the audit log. Same treatment — headers, BOM, header line, then batches — but **do not use `cursorClause`/`nextCursor` here.** I checked the table: `audit_log.id` is `bigserial PRIMARY KEY`, strictly increasing and unique, so a single-column cursor is both sufficient and simpler than the composite pair the cases export needs.

Three concrete changes:

1. **Add `a.id` to the `SELECT` list.** It is not there today, which is why a keyset cursor is impossible without this. Add it to the query only — **not** to the CSV column list, which must keep exactly the columns it emits now.
2. **Page on it.** Keep `ORDER BY a.created_at DESC` and append `, a.id DESC`; on batches after the first add `AND a.id < $n` with the last row's `id`, and `LIMIT 1000` instead of `LIMIT 10000`.
3. **Keep it on `system()`,** with the timeout override from Task 4's Step 2b:

```ts
    const batch = await this.db.system(async (_db, client) => { /* … */ },
      { statementTimeoutMs: 60_000 });
```

The existing comment above that call — that audit-log reads are cross-zone by definition because an auditor's job is to see every zone and the rows carry no zone column — stays exactly as it is. It is still true, and it is the justification for `system()` surviving here.

- [ ] **Step 7: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS — 5 new keyset cases, 98 tests total.

- [ ] **Step 8: Commit**

```bash
git add server/src/cases server/src/admin/admin-users.controller.ts
git commit
```

Message: `Stream exports instead of truncating them at ten thousand rows`

---

### Task 6: Remove a dead dependency and three privileged writes

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/cases/outbound.service.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing downstream.

Two independent housekeeping changes. **Commit them separately** so a reviewer can reject one without the other.

- [ ] **Step 1: Confirm `pg-boss` is genuinely unused**

```bash
grep -rn "pg-boss\|PgBoss" server/src server/scripts
```

Expected: no matches. If there are any, stop and report — do not remove a dependency something imports.

- [ ] **Step 2: Remove it**

```bash
npm --prefix server uninstall pg-boss
```

Needs network. If it fails for network reasons rather than a real problem, report BLOCKED with the error rather than hand-editing `package.json` and the lockfile.

- [ ] **Step 3: Commit the removal**

```bash
git add server/package.json server/package-lock.json
git commit
```

Message: `Drop a job queue nothing imports`

- [ ] **Step 4: Move the three privileged writes**

`server/src/cases/outbound.service.ts` writes under `db.system()` at three call sites — an `UPDATE cases` inside `markPending`, and `email_log` inserts on the send path. `system()` hardcodes `role: 'system', zone: '*'`, so those writes bypass the role matrix that migration 0013 enforces on both tables.

Each of those methods already receives a `ZoneContext` for its reads. Change `this.db.system(` to `this.db.withContext(ctx, ` at those three sites, keeping each callback's parameter list unchanged.

Leave every other `system()` call in the file alone — auditing the remaining fifty across the codebase is a separate sub-project, and this task moves only the three a previous review named.

- [ ] **Step 5: Confirm which remain**

```bash
grep -n -B 2 "db.system(" server/src/cases/outbound.service.ts
```

Read each survivor. If one writes `cases` or `email_log`, it was missed — report it.

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS at 98.

- [ ] **Step 7: Commit**

```bash
git add server/src/cases/outbound.service.ts
git commit
```

Message: `Write cases and email_log under the caller's own context`

---

### Task 7: A script that checks the plan, not the hope

**Files:**
- Create: `server/scripts/explain-check.mjs`

**Interfaces:**
- Consumes: the indexes from Task 2 and the query shape from Task 3.
- Produces: `node server/scripts/explain-check.mjs`, exiting non-zero when the list query plans a sequential scan.

Index choices are the one part of this sub-project that cannot be unit-tested. This script is where the spec's reasoning gets confirmed or falsified.

- [ ] **Step 1: Create the script**

```js
// Does the case list actually use the index 0015 added?
//
// The spec argues that indexing created_at alone is right, because RLS filters
// with app_zone_allows(zone_id) -- a function call the planner cannot turn into
// a range scan. That argument is reasoning, not evidence. This is the evidence.
//
//   node server/scripts/explain-check.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr';
const c = new pg.Client(url);
try {
  await c.connect();
} catch (e) {
  console.error(`No database reachable at ${url}: ${e.message}`);
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const plan = async (sql) => {
  await c.query('BEGIN');
  await c.query(
    `SELECT set_config('app.current_role','admin',true), set_config('app.current_zone','*',true)`,
  );
  const res = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`);
  await c.query('ROLLBACK');
  return JSON.stringify(res.rows[0]['QUERY PLAN']);
};

const listPlan = await plan(
  `SELECT c.id FROM cases c ORDER BY c.created_at DESC, c.id DESC LIMIT 25`,
);
check(
  'case list uses an index scan on created_at',
  listPlan.includes('cases_created_ix'),
  `plan was ${listPlan.slice(0, 300)}`,
);
check('case list does not fall back to a sequential scan', !listPlan.includes('"Seq Scan"'));

const fieldPlan = await plan(
  `SELECT value_json FROM case_fields WHERE case_id = gen_random_uuid() AND field_key = 'country' LIMIT 1`,
);
check('country lookup uses the composite index', fieldPlan.includes('case_fields_case_key_ix'));

const duePlan = await plan(
  `SELECT c.id FROM cases c WHERE c.status <> 'closed' AND c.due_at < now()`,
);
check('open-and-overdue uses the partial index', duePlan.includes('cases_due_open_ix'));

await c.end();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll plans use their index.');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Check it parses**

Run: `node --check server/scripts/explain-check.mjs`
Expected: no output.

- [ ] **Step 3: Run it if a database is reachable**

```bash
node server/scripts/explain-check.mjs
```

On an empty or tiny table Postgres will choose a sequential scan regardless of the index, because it is genuinely faster — that is correct planner behaviour, not a failure of the index. **Say so in your report if that is what you see, and do not "fix" it by forcing a plan.** The script earns its keep against a database with realistic data.

If Postgres is unreachable, say so and move on.

- [ ] **Step 4: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS at 98. Jest `rootDir` is `src`, so this script is not collected.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/explain-check.mjs
git commit
```

Message: `Check the planner agrees with the index we chose`

---

## Definition of done

- [ ] `cases (created_at DESC)`, `case_fields (case_id, field_key)` and the partial `cases (due_at)` index all exist in `0015`.
- [ ] `LIST_SELECT` aggregates approvers once per query; `shapeListRow` is unchanged.
- [ ] Both the paged list and the export order by `(created_at DESC, id DESC)`.
- [ ] `statement_timeout` is set with `is_local = true`; no bare `SET statement_timeout` exists.
- [ ] Neither export has a row cap, and both write the BOM once and rows in batches.
- [ ] `csvRow` still neutralises a leading `=`, proved by a test.
- [ ] `pg-boss` is gone from `package.json` and the lockfile.
- [ ] No `db.system()` remains in `outbound.service.ts` that writes `cases` or `email_log`.
- [ ] `npm --prefix server test` and `npm --prefix server run build` are green.
