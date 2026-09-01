# Case delegation: sending a case to a group of people who have no login

Status: approved for planning
Date: 2026-09-01

## Context

Working a data subject request often needs somebody who does not use this
portal. Confirming a person's employment dates means asking HR; establishing
whether a record is under legal hold means asking Legal. Today that happens in
Outlook: the approver forwards the case PDF, three people in HR discuss it in a
thread nobody else can see, one of them sends a document back, and the approver
uploads it by hand — if they remember, and if the reply did not land while they
were on leave.

Nothing about that exchange reaches the case file. Who was asked, when, whether
anyone picked it up, and what came back all live in one person's mailbox. On a
system whose entire purpose is being able to evidence how a request was handled,
that is the largest remaining gap in the record.

This adds a way to send a case to a named group, have one of them accept it, and
have what they send back land in the case. It deliberately stops there.

### Constraints this design is shaped by

**The portal cannot receive email.** There is no IMAP poller and no inbound
webhook; `attachments.controller.ts` says so in as many words. Anything that
must come back into the case has to arrive over HTTP.

**Group members have no accounts and will not be given any.** They are
colleagues in other departments, not privacy operators. That rules out
authenticating them, and it means every link sent to them is a bearer
capability: whoever holds the email can use it, including whoever it gets
forwarded to.

**The statutory deadline never moves.** Whatever HR does or does not do, the
regulator holds the controller to the response deadline. Delegation must not be
able to take a case out of the queue it is being watched in.

## Scope

In:

- Named groups of external people, per zone, with a default message
- Sending a case to a group, which emails one link to every member
- Accept, which records which member took it and shows it on the case
- PDF upload by the accepting member, landing in the case's files
- The approver ending the delegation, after which the link does nothing
- Audit entries for every one of the above

Out, and deliberately:

- Inbound email of any kind
- Group members gaining any view of the requester's personal data (§5)
- Transfer of case ownership, assignment or the SLA clock (§4)
- A "confirm completion" or "ask a question" link. The cycle is Accept and
  Upload; anything else HR wants to say, they say by replying to the email as
  they do today
- Group members editing the case in any way

## 1. Groups

```
case_groups
  id, zone_id, name, default_message, active, created_by, created_at

case_group_members
  id, group_id, name, email, created_at
```

A group is a named list of people: a display name and an email address each. No
account, no password, no role.

Zone-scoped, under the same row-level security as every other zone-scoped table,
so an approver sees and sends to their own zone's groups.

**Open decision — the one place this departs from the original request.** The
ask was that managers, approvers and admins can all create groups. This spec
puts group management behind `config.manage`, which admins and zone managers
hold and approvers do not, because a group is configuration: it is a standing
list of outsiders who will receive case links, and it sits naturally with forms,
SLA policies and templates rather than with case work. Sending to a group is
`cases.work`, so approvers use them freely.

If approvers should create groups too, the change is to grant group management
under `cases.work` instead. Worth deciding before implementation, because it is
a permission boundary and moving one later means re-testing every route behind
it.

`default_message` is the per-group auto-suggestion: "HR: please confirm this
person's employment dates and attach the relevant record." It is pre-filled when
an approver sends to that group and editable before it goes. One message per
group rather than a template system, because the existing template machinery is
built around requester correspondence — zone, request type, merge variables —
and none of that applies to a note to a colleague.

## 2. The delegation and its token

```
case_delegations
  id, case_id, group_id, token_hash, stage, note,
  accepted_by_member_id, accepted_at,
  closed_at, closed_by, created_by, created_at
```

One row per send. One token, shared by everyone in the group.

The token is 256 bits of randomness, stored as a SHA-256 hash and never in
plaintext — the same treatment `verification_tokens` already gets, so a database
dump does not hand over working links. The plaintext exists only in the email.

**The token is never reissued. What it permits is a function of the stage.**

| stage      | the link permits      | reached by                          |
|------------|-----------------------|-------------------------------------|
| `sent`     | Accept                | the approver sending                |
| `accepted` | Upload                | a member accepting                  |
| `closed`   | nothing               | the approver ending the delegation  |

This is what "the link expires when the stage changes" means in practice: each
action is possible in exactly one stage, and once the stage moves on, that action
is gone. One URL rather than three keeps the emails simple and means there is no
window where two links are simultaneously live.

A `closed` delegation's link resolves to a page saying so, rather than a 404 —
a dead end that explains itself is worth more to the person holding it than an
error, and it does not disclose anything.

## 3. The cycle

```
approver   Send to a group  →  [ HR ▾ ]  message pre-filled  →  Send
                            →  one email, one link, to all three members

member     Accept  →  "Which of you are you?"  →  Priya
                   →  case now shows delegate "Priya Sharma (HR)"
                   →  same page offers Upload (PDF only)
                   →  confirmation email, so the link is findable later

approver   uploads appear under Files as they arrive
           "Done with HR"  →  stage closed, link inert
```

Accept is a portal action because it is what records the delegate and moves the
stage. Upload is a portal action because it is the only way a file can reach the
portal at all. Everything else — questions, discussion, "we need more detail" —
happens by replying to the email, which is what these people would do anyway.

Ending the delegation is the approver's, not a link in the email. They are
reading the uploads regardless, they are the one accountable for the case, and
the judgement of "we have what we need" is theirs. It also means there is no
stage the portal can be moved through by somebody with no account.

## 4. Ownership does not move

`cases.assignee_id`, the case's queue position and its SLA clock are untouched
by delegation. The approver who sent it remains the owner throughout.

The delegate is recorded on the delegation row and displayed on the case as
"Priya Sharma (HR)". It is a fact about where the work currently is, not a
transfer of responsibility.

The alternative — HR genuinely taking the case over — was considered and
rejected. The case would leave the queue its owner watches, disappear from the
dashboards approvers work from, and run its statutory clock down with nobody who
can see it accountable for it. A delegation is somebody helping with a case, not
somebody taking it.

## 5. What the link discloses

**The public page shows the case reference, the request type, the deadline, and
the approver's note. It does not show the requester's name, email, national
identifier, date of birth, phone number, or any answer they gave.**

The link is a bearer capability. Anyone holding the email can open it, and email
gets forwarded, auto-forwarded to personal accounts, and left in the mailboxes
of people who have changed jobs. Putting a data subject's CPF behind an
unauthenticated URL, on the portal whose purpose is protecting it, converts a
convenience feature into a notifiable incident.

Where HR genuinely needs to know who the person is, the approver writes it into
the note. That makes disclosure a deliberate act by an accountable person,
recorded in the audit log and scoped to what is actually needed — instead of
every delegation disclosing the whole record by default.

## 6. Security

- **Token**: 256-bit random, SHA-256 at rest, revoked by closing the delegation.
- **PDF only, checked by magic bytes** (`%PDF-`), never by filename. An
  executable named `.pdf` is the obvious attack on an upload box open to
  unauthenticated callers. Existing size caps and storage apply.
- **Rate limiting** per token, reusing the `rate_counters` table already there
  for verification sends, so a leaked link cannot be used to enumerate or flood.
- **Audit**: every page open, accept and upload recorded with the source IP, as
  `delegation.viewed`, `delegation.accepted`, `delegation.uploaded`.
- **Uploads** are stored as `case_attachments` with `source = 'delegate'` and
  the accepting member recorded, so the case file says where each document came
  from.
- **Imported cases cannot be delegated**: they are records of work another
  system did. The delegate route calls `CaseSourceGuard.assertLive()` like every
  other case mutation — the guard exists, this route has to be wired to it.

## 7. Interfaces

```
internal   GET    /internal/groups                            config.manage
           POST   /internal/groups                            config.manage
           PATCH  /internal/groups/:id                        config.manage
           POST   /internal/cases/:id/delegate                 cases.work
           POST   /internal/cases/:id/delegations/:did/close   cases.work

public     GET    /public/delegation/:token
           POST   /public/delegation/:token/accept
           POST   /public/delegation/:token/upload
```

The public routes live in the existing `public` module, which already holds the
unauthenticated, token-addressed pattern and its rate limiting.

## 8. User interface

- **Groups**: a tab beside Team. List, create, edit members, set the default
  message, deactivate.
- **Case detail**: a "Send to a group" action, and a delegation card showing the
  group, the stage, who accepted and when, the files that arrived, and the
  "Done with HR" button.
- **Public page**: one small screen. What is being asked, who is asking, the
  deadline; then either the accept step, the upload box, or a note that the
  request has been closed. No portal chrome, no navigation, nothing to click
  through to.

## 9. Testing

Unit, no database:

- Stage transition table: which action each stage permits, and that every other
  combination is refused
- PDF magic-byte detection, including an executable renamed `.pdf`
- Token hashing and comparison

Integration, against a real database:

- Accept twice: the second is refused, and the first accepter stands
- Upload while `sent`: refused. Upload after `closed`: refused
- A closed delegation's link resolves to the closed page, not a 404 or an error
- The case's `assignee_id`, queue position, SLA clock and status are unchanged by
  the whole cycle
- Uploads appear as case attachments attributed to the accepting member
- The public payload contains none of the requester's personal fields — asserted
  field by field, since this is the guarantee most likely to be eroded by a
  later convenience
- An imported case cannot be delegated
- Nothing is ever sent to the requester at any point in the cycle

## 10. Shape of the work

Two migrations: the three tables with their RLS policies, and the
`case_attachments` source value.

Server: a `delegation` module — service, internal controller, public controller
— plus the group CRUD and a small addition to the case detail payload.

Admin: a Groups screen, the send action and the delegation card on the case.

Public: one page, in the existing public form application.
