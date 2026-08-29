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
timeouts, streaming exports, removal of an unused dependency, and moving two
case-write paths off `DbService.system()`.

Out of scope: keyset pagination for the list API, caching or estimating the row
count, any queue or cache infrastructure, and the remaining fifty `db.system()`
call sites. The last is a security audit rather than a performance change and
deserves its own sub-project; this one moves only the two writes a previous
review specifically identified. (An earlier draft of this document said three.
See "Two smaller changes" below for what the third site actually is and why it
stays.)

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
| `cases (created_at DESC, id DESC)` | the `ORDER BY` on every list page and export |
| `audit_log (created_at DESC, id DESC)` | the audit export's cursor; `0000` indexed `created_at` alone |
| `case_fields (case_id, field_key)` | the country `LATERAL`, which today has only `(case_id)` |
| `cases (due_at) WHERE status <> 'closed'` | the three SLA filters, all of which pair `due_at` with that exact predicate |

The sort key is the *pair*. An earlier draft of this table listed three indexes
headed by `cases (created_at DESC)`; `0015` creates four, and the leading one
carries `id` as well. The `id` is not decoration, for two reasons.

It breaks ties. Two cases created in the same millisecond are not rare in a
system fed by a public form, and without a second ordering column their relative
order is whatever the plan happened to produce — different between the page an
operator read and the export they then downloaded.

And the export pages through this ordering with a row-value cursor,
`(created_at, id) < (x, y)`. The planner can only satisfy that by starting the
scan *at* the cursor if both columns are in the index, in this order and this
direction. With the leading column alone the comparison degrades into a filter:
every batch after the first re-walks the rows already exported, and the export
becomes quadratic in its own length. `audit_log` pages the same way and gets the
same composite index; `audit_log_created_ix` stays for the audit screen, which
filters on `created_at` without the id.

The planner walks `(created_at DESC, id DESC)`, evaluates `app_zone_allows` per
row, and stops when the page is full. A zone-pinned manager reads roughly three
times a page's worth of rows; an administrator reads exactly a page.

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

The loop itself is neither in `csv.ts` nor in the handlers, which is where this
document first put it. It is a new file, `server/src/cases/csv-stream.ts`, and
that is where the interesting behaviour lives — three things that have to be
right once rather than twice, in two handlers that would drift:

- **Backpressure.** `write()` returning `false` means the socket is full.
  Ignoring it buffers the whole export in memory anyway, which is the thing
  streaming was for, so `writeChunk` waits for `'drain'` before the next batch.
- **The abort path.** Once the first byte is written the status line is gone, so
  a failure after that point cannot be a 500. The file gets a final
  `INCOMPLETE_EXPORT_MARKER` line instead — pre-quoted, so a spreadsheet reads
  it as one field rather than splitting it at the dashes. A client that hangs up
  mid-download has to reject rather than hang: a real `http.ServerResponse`
  emits `'close'` once, *before* the write, and then emits no `'drain'`,
  `'error'` or `'close'` ever again, so a promise waiting only on those three
  would never settle and the handler would never return. `writeChunk` checks
  `destroyed`/`writableEnded` first for exactly that.
- **`onComplete`.** The caller records the export in this hook, and
  `CsvStreamOutcome.recorded` reports whether it ran. If the hook succeeded and
  the response failed afterwards, the record already exists — writing a second,
  contradicting one would be worse than writing none.

### Two smaller changes

`pg-boss` is a declared dependency that nothing imports. It is removed.

`outbound.service.ts` uses `system()` at three call sites, and this document
originally said all three were writes that would move. **That count was wrong.**
Two are writes — to `cases` and to `email_log` — and those do move onto the
caller's context, because a previous review noted they bypass the role matrix
sub-project 2a built.

The third, `outbound.service.ts:203`, is a **read**, and it stays on `system()`
deliberately. It resolves recipient addresses to display names, and its result is
stored in `cases.pending_on` rather than rendered per viewer. Running it under
the caller's context would therefore let row-level security on `users` decide
what gets *persisted*: an admin's action would store `"Jane Smith, Bob Lee"`
while a zone_manager taking the identical action would store
`"jane@x.com, bob@y.com"`, because RLS hid the other zone's users and the code
fell back to raw addresses. Stored data that depends on who happened to act is
worse than the privilege that one read self-declares, in a system whose whole
point is a defensible audit trail. It is logged for the `system()` audit
sub-project rather than fixed here.

This correction is recorded rather than quietly amended because a reader
reconciling this document against the tree would otherwise count two moved
writes against three promised and conclude one had been missed.

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
- `csv-stream.spec.ts` — the backpressure and abort paths of `csv-stream.ts`
  against a fake `Writable`: that a `write()` returning `false` is waited out,
  that a client hanging up mid-download settles rather than hangs, and that a
  failure after the first byte leaves `INCOMPLETE_EXPORT_MARKER` in the file.

Index behaviour cannot be unit-tested. A new `server/scripts/explain-check.mjs`
takes the planner's chosen plan and asserts an index scan on `cases_created_ix`
rather than a sequential scan or a re-sort, so the reasoning in this document can
be confirmed or falsified against real data rather than believed.

Two things decide whether it is evidence at all. It connects over
`DATABASE_URL_APP`, not `DATABASE_URL`: the latter is the owner role `dsr`
throughout this repo, no migration issues `FORCE ROW LEVEL SECURITY`, and a table
owner bypasses every policy — so plans taken that way carry no
`app_zone_allows(zone_id)` qualifier, which is the entire subject of the argument
above. And it plans the `LIST_SELECT` text from `cases.service.ts` verbatim, CTE
and `LATERAL` included, in three shapes: unfiltered; filtered and continued from
a keyset cursor, which is the export path and where `cases_status_ix` and
`cases_zone_ix` compete for the query; and zone-pinned to `EUR`, the only case
where the RLS qualifier actually discards rows and therefore the case the index
argument turns on.

## Verification

```bash
npm --prefix server test
npm --prefix server run build
node server/scripts/migrate.mjs                  # applies 0015
# connects as dsr_app: as the owner, RLS is bypassed and the plans prove nothing
DATABASE_URL_APP=postgres://dsr_app:dsr_app@127.0.0.1:5433/dsr \
  node server/scripts/explain-check.mjs          # asserts index scan, not a sort

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

### Two things this document implies are settled, and are not

Both were found while implementing it. Both were decided against changing. They
are written down so the next person meets them as decisions rather than as bugs.

**The export is streamed by the server and buffered by the browser.** The admin
console downloads with `fetch()` and `res.blob()`
(`apps/admin/src/components/ExportButton.tsx:28-45`), so the whole response is
materialised in the tab before the file is written to disk. "Memory is bounded by
the batch rather than the result set", above, is true of the server and **false
of the operator's machine.** One consequence follows from the other:
`INCOMPLETE_EXPORT_MARKER` is never seen by anyone using the portal, because
`res.blob()` rejects on a truncated chunked response and discards the bytes it
had collected. The marker still earns its place for anything reading the endpoint
directly — `curl`, a scheduled pull — and the console operator is not left in the
dark either: the rejection surfaces as a `Could not export` toast, so a failed
export is loud, it just never arrives as a half-file that could be mistaken for a
whole one. Making the console stream to disk means a service worker or
`showSaveFilePicker`, which is a real piece of work for a file an operator opens
in Excel. Parked deliberately; the client is not changed.

**`SlaService.recomputeAll` holds a connection across outbound HTTPS calls.**
`server/src/cases/sla.service.ts` runs the whole sweep inside a single
`db.system()` transaction, and sends Microsoft Graph mail from inside it — N
network round trips with the transaction open and one pooled connection held for
their combined duration. `statement_timeout` bounds statements, not transactions,
so the timeout this sub-project added does not reach it: this is the one place
left where a connection can be held for an unbounded time. It is pre-existing and
out of scope here, and it is self-limiting — the sweep takes
`pg_try_advisory_xact_lock` and a second one returns immediately rather than
piling up, so the exposure is one connection rather than the pool. Recorded as
known.
