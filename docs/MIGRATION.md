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
- **Know which form the cases came from.** Column headings are matched against
  that form's field labels, and request-type wording against its options, so
  `CPF` finds `cpf_brazil` and *"Ter acesso aos meus dados pessoais"* becomes
  `access`. The form also fixes the zone.
- Limits are **25 MB** and **20,000 rows** per file. Split anything larger; the
  imports are independent and can be run back to back.

## Step 1 — analyse

Choose the zone and form, pick the file, and press **Read the file**. Nothing
is written to the case tables at this point.

The result shows:

| What | Why it matters |
|---|---|
| Encoding and delimiter | Confirms the file was read as you expect. Comma, semicolon, tab and pipe are all detected. |
| Date order | See below. This is the one to check. |
| Column mapping | Every column and where it will land. |
| Preview | The first ten rows exactly as they would be written. |
| Already imported | Rows whose source id is already in the database. |

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
- Marks every case `source = 'import'`. **No mail is ever sent about an
  imported case** — the portal did not receive these requests and must not
  write to people about correspondence that happened somewhere else.
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
