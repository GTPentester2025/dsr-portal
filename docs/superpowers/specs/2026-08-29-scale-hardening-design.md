# Scale hardening: index the sort key, stop re-aggregating, bound the connection

Status: approved for planning
Date: 2026-08-29
Sub-project 3 of 5 (email → RBAC hardening → SSO seams → **scale hardening** → RHEL deployer)

## Context

The portal runs on one box and is expected to hold on the order of a hundred
thousand cases with a few dozen concurrent internal users. Nothing about that
needs new infrastructure. What it does need is for the queries that run on every
screen to stop doing avoidable work, and for one slow query to stop being able to
take the whole service down.

Four things are wrong, and they compound.

`cases.created_at` has no index, and it is the `ORDER BY` of every case-list page.
`audit_log.created_at` has one; `cases` never got the equivalent. At a hundred
thousand rows every page load sorts the table.

The case-list query re-aggregates the approver list once per row. Its
`LEFT JOIN LATERAL` over `users` depends only on `c.zone_id`, and there are three
zones — so a twenty-five row page runs that aggregate twenty-five times to
produce at most three distinct answers.

The connection pool is `max: 10` with no `idleTimeoutMillis`, no
`connectionTimeoutMillis` and no `statement_timeout`. A single runaway query holds
a connection indefinitely. Ten of them hold the portal.

Both CSV exports cap at ten thousand rows and build the entire file in memory
before sending. The memory spike is the smaller problem; the truncation is silent,
so an operator who exports a filtered view believes they have all of it.

## Scope

In scope: indexes, the case-list query shape, pool configuration and statement
timeouts, streaming exports, removal of an unused dependency, and moving three
case-write paths off `DbService.system()`.

Out of scope: keyset pagination for the list API, caching or estimating the row
count, any queue or cache infrastructure, and the remaining fifty `db.system()`
call sites. The last is a security audit rather than a performance change and
deserves its own sub-project; this one moves only the three writes a previous
review specifically identified.

## Architecture

### Indexes, and why not the obvious one

The obvious index would be `cases (zone_id, created_at DESC)` — zone to filter,
timestamp to sort. **It would not be used.** Row-level security filters with
`app_zone_allows(zone_id)`, a function call rather than an equality, so Postgres
cannot turn it into a range scan on `zone_id`. The existing `cases_zone_ix` is
almost certainly doing nothing for list queries already.

What works instead is indexing the sort key alone and letting the RLS predicate
act as a filter over the ordered stream:

| Index | Serves |
|---|---|
| `cases (created_at DESC)` | the `ORDER BY` on every list page and export |
| `case_fields (case_id, field_key)` | the country `LATERAL`, which today has only `(case_id)` |
| `cases (due_at) WHERE status <> 'closed'` | the three SLA filters, all of which pair `due_at` with that exact predicate |

The planner walks `created_at DESC`, evaluates `app_zone_allows` per row, and
stops when the page is full. A zone-pinned manager reads roughly three times a
page's worth of rows; an administrator reads exactly a page.

`cases_zone_ix` is left in place. It costs write throughput on a table this size
but removing an index on the strength of reasoning about a planner nobody has
run is a worse trade than keeping one that may be unused.

### Hoist the approver aggregate

The per-row `LATERAL` becomes a CTE grouped by zone and joined once:

```sql
WITH approvers AS (
  SELECT zone_id,
         string_agg(name, ', ' ORDER BY name) AS names,
         array_agg(email ORDER BY name) AS emails
    FROM users WHERE active AND role = 'approver' GROUP BY zone_id
)
```

One aggregate over `users` per query rather than one per row, producing the same
`approvers` and `approver_emails` columns. This is the change with the largest
constant factor: it scales with the number of zones, which is three, rather than
with page size.

The country `LATERAL` stays as it is — it genuinely depends on `c.id` and, with
the composite index above, is a single index lookup per row.

### Pool and statement timeout

`max`, `idleTimeoutMillis` and `connectionTimeoutMillis` become configurable with
defaults suited to one box. `statement_timeout` is the one that matters: it is set
per transaction in `withContext`, alongside the role and zone already set there,
so a runaway query is killed rather than holding a connection until someone
notices.

**It must be set with `set_config('statement_timeout', …, true)` — the third
argument being `is_local` — exactly as `app.current_role` and `app.current_zone`
already are.** A bare `SET statement_timeout` is session-scoped, and these are
pooled connections: the value would outlive the transaction and apply to whichever
request picked that connection up next. An export's generous override would then
silently become the timeout for unrelated interactive queries, which is the kind
of bug that only appears under load and looks like anything but its cause.

**A timeout that kills your own exports is worse than no timeout.** A streamed
export legitimately runs longer than any interactive query should, so
`withContext` takes an optional timeout override and only the export paths pass
one. Everything else gets the interactive default.

### Streaming exports

`pg-query-stream` would be a new dependency, which this project does not take. The
exports instead loop in keyset batches — a thousand rows at a time ordered by
`(created_at, id)` — writing each batch to the response before fetching the next.
Memory is bounded by the batch rather than the result set, and the ten-thousand
row cap disappears.

So keyset pagination does arrive, inside the exports, where there is no user
interface to change. The list API keeps its page numbers, which is what the admin
console is built around.

`csv.ts` splits its serialisation so a header and a row can be emitted
separately, keeping the existing quoting and formula-injection defences — the
`neutralise` function that prefixes a leading `=`, `+`, `-` or `@` must apply to
streamed rows exactly as it does today. The handlers stop using
`@Res({ passthrough: true })`, since they now own the response.

### Two smaller changes

`pg-boss` is a declared dependency that nothing imports. It is removed.

`outbound.service.ts` writes `cases` and `email_log` under `system()` at three
call sites. A previous review noted that those writes bypass the role matrix that
sub-project 2a built. They move onto the caller's context.

## Testing

The pure parts are unit-testable in the convention this codebase uses — no Nest
`TestingModule`:

- `csv.spec.ts` — that a streamed header plus streamed rows produce byte-identical
  output to today's `toCsv`, and that `neutralise` still fires on a leading `=`.
  The formula-injection defence protects whoever opens the export in Excel, and a
  refactor is exactly where it would be lost.
- The keyset batching helper — that consecutive batches do not overlap or skip a
  row when two cases share a `created_at`, which is why the cursor is
  `(created_at, id)` and not `created_at` alone.

Index behaviour cannot be unit-tested. A new `server/scripts/explain-check.mjs`
prints the planner's chosen plan for the list query and asserts an index scan
rather than a sequential scan, so the reasoning in this document can be confirmed
or falsified against real data rather than believed.

## Verification

```bash
npm --prefix server test
npm --prefix server run build
node server/scripts/migrate.mjs                  # applies 0015
node server/scripts/explain-check.mjs            # asserts index scan, not seq scan

# the export no longer truncates
curl -s -o /tmp/e.csv -w '%{size_download}\n' \
  --cookie "dsr_int=$SESSION" "$BASE/internal/cases/export.csv"
wc -l /tmp/e.csv        # expected: every matching case, not 10000

# a runaway query is killed rather than holding a connection
psql -c "BEGIN; SELECT set_config('app.current_role','admin',true); SELECT pg_sleep(60);"
# under the app's context this must terminate at statement_timeout
```

Manual, on a real box: load the case list at a few page depths and compare
response times against the current build. The unit tests prove the CSV refactor;
only real data proves the indexes.

## What this deliberately leaves undone

**Keyset pagination for the list API.** Offset paging shifts page boundaries when
a case is created mid-browse, and it is O(offset) at depth. Both are real, and
neither matters at a hundred thousand rows with a page-numbered UI. Changing it
means changing the admin console's paging controls for a benefit no operator would
notice.

**An exact-versus-estimated row count.** The filtered `count(*)` stays exact. With
the sort key indexed it is fast enough, and a regulatory tool that reports "about
four hundred cases" is worse than one that waits.

**The other fifty `db.system()` calls.** Each one self-declares full privilege,
and auditing them is worth doing — as a security sub-project, not smuggled into a
performance one.
