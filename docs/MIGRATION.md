# Migrating case history from another DSR tool

The **Migration** page (`#/migration`, administrators and zone managers) reads a
case export out of another privacy tool and creates the cases here.

It is two steps on purpose. `Analyse` reads the file and proposes what each
column means; `Import` writes the cases. Between the two you correct the column
mapping and the date order, which are the only two things that corrupt an
import silently.

## Before you start

- **Save the file as CSV.** `.xlsx` is a zip archive, not text, and the
  importer does not open it. Excel's *Save As → CSV UTF-8* is fine; so is a
  plain `Save As → CSV`, which usually writes the Windows code page. Both are
  read correctly.
- **Know which zone the cases belong to.** That is the only thing you are
  asked. Which of the zone's forms the export came from is worked out from the
  file — see below.
- Limits are **25 MB** and **20,000 rows** per file. Split anything larger; the
  imports are independent and can be run back to back.

## Step 1 — analyse

Choose the zone, pick the file, and press **Read the file**. Nothing is
written to the case tables at this point.

### Which form the cases are recorded against

You are not asked, because the question has no answer. Within a zone the
country forms are field-identical — SAZ's six agree down to the wording of
every request type, and all of them carry `cpf_brazil` — so nothing in a CSV
distinguishes a Brazilian case from an Argentine one.

Rather than pick one and have every imported case claim a country it may not
be from, each zone has **one form of its own for imports**: `saz-import`,
`eur-import`, `maz-import`. It is the union of every field the zone's country
forms collect, generated on first use and regenerated whenever those forms
change. Because the fields are the same either way, a case renders exactly as
it would have against the country form the requester actually filled in.

Where the zone's forms label the same field differently — MAZ words
`requestDetails` three ways — the field key is used as the label instead of
picking one country's wording for another country's case.

These schemas are not intake forms: they never appear in the public form list
or the forms editor, and nobody fills one in.

### Date order

`03-04-2026` is 3 April in most of the world and 4 March in the United States,
and reading it the wrong way shifts a deadline by months without producing an
error anywhere.

The importer looks for evidence — any first component above 12 can only be a
day — and tells you whether it found any. When the banner says it did not,
open the source file and check one row before continuing.

Times are read as UTC. Source exports carry a wall-clock time with no zone,
and reading them in the server's local zone would move every historical
timestamp if the server were ever relocated.

### The column mapping

Every column has a destination, and nothing is dropped by omission:

- **Case properties** — the lifecycle facts: source id, subject name, request
  type, status, created/deadline/completed dates, residency, owner, appeal
  fields. Recognised from the heading.
- **Form fields** — the answers, matched to the chosen form by label. These
  are stored exactly as an answer submitted through the form would be, which
  means they render on the case screen and come out in the CSV export.
- **A new field** — a column the form has no field for. Proposed with a
  generated key and flagged, because storing an answer under a key nothing
  renders is a decision, not something that should happen by default.
- **Ignore** — read and discarded. Columns that describe the tenant rather
  than the case (`Organisation Name` and similar) are proposed as ignored.

Change any of them; the preview and the issue list refresh against the new
mapping, so what you see is what will be written.

### Status

The source tool's progress column usually means two things at once — where the
case got to, *and* whether the answer reached the requester. Those are kept
apart here:

| Source progress | Status | Also records |
|---|---|---|
| `Report Accessed By Data Subject` | `closed` | report published **and** read |
| `Report Published` | `closed` | report published |
| `Completed`, `Closed`, `Fulfilled` | `closed` | — |
| `Pending`, `Awaiting…` | `pending` | — |
| `Pending approval` | `pending_approver` | — |
| `Overdue`, `Breached` | `open` | — |
| anything unrecognised | `open` | a warning against that row |

`Overdue` is imported as `open` deliberately. Overdue is set by the SLA engine
from the deadline, never asserted by a file — and the engine will reach the
same conclusion within a minute if the deadline really has passed.

## Step 2 — import

Rows with **errors** are skipped and reported by row number; rows with
**warnings** are imported. One bad date in a file of eleven thousand cases does
not block the other 10,999.

Each case is written in its own transaction, so a failure is a reported row
rather than a lost import.

### What the importer does

- Issues a case reference from the zone's sequence **for the year the case was
  created in**, not the current year.
- Sets the deadline from the file, or computes it from the zone's SLA policy
  and the original arrival date. It never dates a historical case from today.
- Starts the SLA clock in `stopped` for closed cases, and with its past
  reminder thresholds already marked fired for open ones — so the reminder cron
  does not send a burst of *"your deadline is approaching"* mail about
  deadlines that passed months ago.
- Encrypts direct identifiers (name, phone, national id, address) at rest, by
  the same rule intake uses.
- Marks every case `source = 'import'`.

### Importing never sends email

Pressing **Import** sends nothing, and nothing is sent afterwards on account of
what was imported. That holds for three separate senders, all of which had to
be dealt with:

| Sender | Would have sent | Why it stays quiet |
|---|---|---|
| Intake acknowledgement | "we have received your request" to the requester | The importer never calls it. These requests were received somewhere else, possibly years ago. |
| SLA reminders (every 60s) | "deadline approaching" to the zone's approvers | Each clock is written with its reminder thresholds already marked fired. |
| SLA escalations (every 60s) | `case-escalated` and `case-unassigned` to the zone's managers | Each case is written with `unassigned_escalated_at` and `escalated_at` already stamped. |

The last one matters most and is the least obvious: escalation fires on any
open case past its deadline, and an imported backlog is *entirely* made of
those. Without the markers, importing a few hundred open historical cases would
put a few hundred escalation emails into the zone's inbox within a minute.
They go to managers rather than to requesters, but nobody asked for them, and
importing history is not an event that needs alerting.

An imported backlog is still **visible** — the cases are marked breached by the
sweep and show as overdue on the dashboard, which is where a backlog belongs.
Escalation is suppressed for imported history only; a case raised through the
portal escalates exactly as before.
- Records the source id, so re-uploading the same file imports nothing and
  reports the rows as skipped.

### Rows with no email address

The requester's address is required by the schema and by every lookup that
resolves one. Where the source file has none — which is common, since the
requester was identified by a national id instead — the case is imported
against a placeholder on the reserved `import.invalid` domain, which can never
route anywhere. The count is reported after the import.

Those cases are complete and searchable. Nothing can be sent to them until a
real address is recorded.

## After the import

Every upload is listed on the page with what it brought in, and both the
analyse and the commit are in the audit log with the operator's name, the row
counts and the filename.

## What is *not* imported

- **Attachments.** The export is a spreadsheet; the files live in the other
  tool. Upload them against the case from the case screen.
- **Correspondence history.** Emails sent by the other tool are not in the
  export. Record any that matter as an attachment on the case.
