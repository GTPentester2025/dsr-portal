# Sending a case to people who have no account

Working a request often needs somebody outside the privacy team: HR to
confirm someone's employment dates, Legal to check for a hold. Before this
feature, that happened in Outlook — the approver forwarded the case, a thread
ran in somebody else's mailbox, a document came back if it came back, and none
of it reached the case file. On a system whose whole purpose is being able to
evidence how a request was handled, that was the largest remaining gap in the
record.

**Delegation** sends a case to a named group of outsiders, has one of them
accept it on a page they need no login for, and lands what they send back in
the case's files. It deliberately does nothing more than that.

## Groups

A group is a standing list of people who will never have a portal account:
HR, Legal, a specific manager, whoever the privacy team routinely needs to
ask. Each member is just a name and an email address — there is no invitation
to accept, no password, no role.

Groups are zone-scoped like everything else, and **anyone holding
`cases.work` can create and edit one — approvers included, not only
administrators.** That was a real design question (see the design doc's §1),
and it is settled by where the permission actually sits in this build: group
management and sending to a group are both `cases.work`. The reasoning is
practical — an approver who can send a case to HR but cannot add the HR
colleague they actually need to add would have a feature that's half
available to them.

Each group carries a **default message**: the note that gets pre-filled when
a case is sent to it, for example *"HR: please confirm this person's
employment dates and attach the relevant record."* It is editable before
sending, every time. It's worth writing a real one rather than leaving it
blank, for a reason that isn't obvious from the group screen: the note is the
**only** free-text field the recipients see (§ below), so it is doing the job
a subject line and a covering email would normally do. A group with a blank
default message relies on every approver composing a clear enough request
from scratch, under deadline pressure, every time they send to it.

A group can be deactivated. A deactivated group's members stop receiving new
invitations; it still shows in delegation history for cases it was already
sent to.

## The token and its three stages

Sending a case to a group creates one `case_delegations` row and emails
**one link to every member**. The token behind that link is 256 bits of
randomness, stored only as its SHA-256 hash — the same treatment
`verification_tokens` gets — so a database dump does not hand over a working
link. The plaintext token exists nowhere but the email.

The token is never reissued and there is only ever one link. What it lets you
do depends entirely on the delegation's current **stage**:

| Stage | The link permits | Reached by |
|---|---|---|
| `sent` | Accept | the approver sending the case |
| `accepted` | Upload (any number of PDFs) | a member accepting |
| `closed` | nothing — a page confirming the request is closed | the approver ending the delegation |

This is the entire security model, and it is worth stating precisely because
it's easy to describe loosely: **each action is possible in exactly one
stage.** Accepting only works while `sent`; the moment somebody accepts, the
stage moves to `accepted` and a second member trying the same link gets "this
has already been accepted," not a second acceptance. Uploading only works
while `accepted`; try it before anyone has accepted, or after the approver
has closed the delegation, and it is refused. There is no window in which two
different actions are both live, and there is no version of the link that
still works after its stage has passed — closing a delegation doesn't merely
hide a button, it makes every write the link could attempt fail server-side.

A closed delegation's link doesn't 404. It resolves to a small page saying
the request has been closed. That's deliberate: a dead end that explains
itself is more useful to whoever is holding a months-old email than a raw
error, and confirming "this is closed" discloses nothing beyond what the
recipient already had.

Uploading doesn't advance the stage — a delegation can receive several
documents while it sits `accepted`, which is normal (HR sends one record,
realises a second one is relevant, sends that too).

## What the link discloses, and what it never does

The public page shows exactly: **the case reference, the request type, the
deadline, the group's name, and the approver's note** — plus, once accepted,
who accepted and the filenames already uploaded. It is built field by field
from the delegation and the case, never by selecting the case row and
trimming it, specifically so that a column added to `cases` later can't leak
onto this page by accident.

**It never shows the requester's name, email address, national identifier,
date of birth, phone number, or any answer they gave on the intake form.**

That's not caution for its own sake — it follows directly from what kind of
thing the link is. Nobody logs in to use it; whoever holds the email can use
it, and email gets forwarded, auto-forwarded to personal accounts, and left
sitting in the mailbox of someone who has since changed teams. A bearer link
is not a place to put a data subject's identifying details, on the one system
whose entire job is protecting them — doing so would turn a convenience
feature into the cause of a notifiable incident the day a link gets
forwarded to the wrong place.

The consequence that matters operationally: **if HR genuinely needs to know
who the person is to answer the question, the approver has to write it into
the note themselves.** That's not a gap in the feature, it's the point of the
design. Writing "this concerns Priya Sharma, employee #4021" into the note is
a deliberate, attributable act by someone accountable for the case, and it
shows up in the audit log against that specific delegation. The alternative —
every delegation automatically disclosing the full case record to whoever
opens the link — would mean the disclosure decision was never actually made
by anyone; it would just always happen. Put the identifying details in only
when the recipient actually needs them, and only as much as they need.

## Accepting and uploading

The public page asks "which of you are you?" and lists the group's members
by name — but only while the delegation is still `sent`; once somebody has
accepted, the member list is no longer part of the response, so a second
visitor sees who accepted rather than a roster to pick from. Accepting
records which member it was, moves the stage to `accepted`, and the case
screen shows the delegate by name and group, e.g. "Priya Sharma (HR)."

**Uploads are PDF only, and that is enforced on the bytes, not the
filename or the browser-supplied content type.** The upload is accepted only
if it actually starts with the five bytes `%PDF-`; a `.exe` renamed to
`report.pdf` is refused regardless of what the browser claims its type is.
Filename and `Content-Type` are both supplied by whoever is uploading, and an
upload endpoint that needs no login is the first thing anyone tries that
against — checking the real bytes is the only check that isn't trivially
defeated. Uploads are also capped at 10 MB and rate-limited (below).

Every accepted upload lands as a case attachment tagged `source = 'delegate'`
with a note recording who sent it and through which group, so the case file
always shows where a document came from, not only that it appeared.

## Ownership never moves

Sending a case to a group changes nothing about who owns it. The case's
`assignee_id`, its position in the queue, its status, and its SLA clock are
all untouched for the whole cycle. The approver who sent it is the approver
responsible for it before, during and after.

The delegate — "Priya Sharma (HR)" — is recorded and shown on the case as a
fact about **where the work currently is**, not a transfer of **who is
accountable for it**. The alternative, where accepting a delegation actually
handed the case to HR, was considered and rejected: the case would leave the
queue its owner watches, disappear off the dashboards approvers work from,
and keep running its statutory clock with nobody who can see it responsible
for it. A delegation is somebody helping with a case. It is never somebody
taking it.

Practically, this also means the deadline is never something a delegation
can quietly move. Whatever HR does or doesn't do with the link, the case is
still counting down to the same date it always was, still visible to the
approver, still theirs to escalate if the group goes quiet.

## One open delegation per case

A case can have at most one delegation that isn't `closed`. Sending a second
one while the first is still open is refused with a message naming which
group already has it — "This case is already with HR. Finish that first" —
and the refusal is enforced by a database constraint (a partial unique index
on the case while its stage isn't `closed`), not only by a check in the
service, so two approvers clicking Send at the same moment can't both
succeed.

The reason isn't a technical convenience — it's what "where the work
currently is" (previous section) actually means. If Legal and HR could both
be mid-conversation on the same case at once, the case screen's single
delegate field would be answering the question "who is this with?" wrongly
by construction, and "Done with HR" would become ambiguous about which
open thread it was closing. Finish or close one delegation before starting
another; if a case genuinely needs both HR and Legal, that's two delegations
run one after the other, each fully recorded before the next begins.

## What ends a delegation, and what that does to the link

Only the approver ends a delegation — there is no "we're done" action inside
the emailed link itself. That's deliberate: the approver is the one reading
the uploads and the one accountable for the case, so the judgement that
"we have what we need" belongs to them, not to whoever last touched the link.
It also means there is no stage of this cycle that someone with no account
can move the case through by themselves.

Ending a delegation ("Done with HR" on the case screen) sets its stage to
`closed` and records who closed it and when. The link stops doing anything
from that moment — Accept and Upload are both refused — but it keeps
resolving to the "this has been closed" page rather than breaking, and the
delegation's history (who accepted, what was uploaded, when it closed) stays
on the case exactly as it happened. Closing does not delete anything; it
revokes what the link can still do.

## Imported cases cannot be delegated

A case brought in from another tool (`cases.source = 'import'`) is a record
of work that system already did — it was received, worked and answered
elsewhere, and the person who raised it has already had their reply. This
portal keeps it findable and auditable; it doesn't work it. Delegation is
case work, so sending an imported case to a group is refused for the same
reason status changes, assignment, and new attachments are refused on one:
`CaseSourceGuard.assertLive()` is checked before a delegation is created,
and it rejects with a message naming the case and pointing at the only way
an imported case does change — a corrected re-import.

## Audit trail

Every step that changes something is written to the audit log:
`group.created`, `group.updated`, `delegation.sent` (who it went to and the
note that was sent), `delegation.accepted` (which member, from what IP),
`delegation.uploaded` (filename and size, from what IP), and
`delegation.closed`. Together with the delegation row itself, this is what
replaces the Outlook thread: who was asked, when, who picked it up, and what
came back, all against the case rather than in somebody's inbox.

## Interfaces, for reference

```
internal   GET    /internal/groups                            cases.work
           POST   /internal/groups                            cases.work
           PATCH  /internal/groups/:id                         cases.work
           POST   /internal/cases/:id/delegate                 cases.work
           POST   /internal/cases/:id/delegations/:did/close   cases.work

public     GET    /public/delegation/:token
           POST   /public/delegation/:token/accept
           POST   /public/delegation/:token/upload
```

The three public routes need no session — that's the point, the people using
them have none — but every one of them is rate-limited twice: per token (the
budget that actually bounds a leaked link, since it holds even if the
caller's IP changes) and per source IP (a looser backstop, sized generously
because a whole office can share one address). Either budget being spent
fails the request with a 429.

## Design document

The reasoning behind each of these decisions — including the group
permission question, what was deliberately left out of scope, and the
alternatives considered and rejected — is in
`docs/superpowers/specs/2026-09-01-case-delegation-design.md`. This document
describes the system as built for someone operating it day to day; that one
explains why it was built this way.
