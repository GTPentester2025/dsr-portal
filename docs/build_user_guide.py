"""Build the end-user guide (Word)."""
from datetime import date

from docgen import (ROOT, add_toc, bullets, callout, code, figure, h1, h2, h3,
                    new_document, numbered, page_break, para, rich_para, table)

doc = new_document(
    "DSR Portal",
    "User Guide",
    "For privacy teams, zone managers and administrators",
    f"Version 1.0  ·  {date.today():%d %B %Y}",
)
add_toc(doc)

# ============================================================== 1. overview
h1(doc, "1. About the portal")
para(doc,
     "The DSR Portal receives privacy requests from the public and manages them "
     "through to a documented outcome. It replaces the previous hosted forms with "
     "an identical public experience and adds a full case-management console "
     "behind it.")

h2(doc, "1.1 What it does")
bullets(doc, [
    "Publishes **12 public request forms** across three zones: Europe (EUR), South America (SAZ) and Middle Americas (MAZ).",
    "Verifies the requester owns the email address **before** a case is created, so no unverified data is ever stored.",
    "Creates a case with a reference like `DSR-EUR-2026-00147`, starts the statutory clock and assigns it automatically.",
    "Tracks the case through a controlled status workflow with reminders, extensions and a mandatory outcome at closure.",
    "Sends templated replies from the privacy mailbox and records every message on the case.",
    "Keeps an append-only audit trail of every view, change and send, for regulatory inspection.",
])

h2(doc, "1.2 Where to find it")
table(doc, ["Surface", "Address", "Who uses it"], [
    ["Public request forms", "https://203-0-113-10.sslip.io/", "Data subjects (the public)"],
    ["Internal console", "https://203-0-113-10.sslip.io/admin/", "Privacy team and administrators"],
], widths=[1.9, 3.0, 1.9])

callout(doc, "ok",
        "Both addresses are served over **HTTPS** with a certificate from Let's Encrypt that renews "
        "itself. Anyone who types the bare IP address, `http://203.0.113.10/`, is redirected to the "
        "secure address automatically, so bookmarks and printed links keep working.")

h2(doc, "1.3 Roles and what each can do")
para(doc,
     "Every person has exactly one role. Roles are cumulative going down the table, "
     "except the auditor, which is deliberately read-only and never inherits the "
     "ability to change anything.")
table(doc, ["Role", "Can do"], [
    ["**Super administrator**", "Everything, plus the Settings screen: email provider and credentials, portal URLs, security limits and branding. Only a super administrator can create another one."],
    ["**Administrator**", "All zones. Cases, forms and SLAs, templates, team, audit log. Cannot open Settings."],
    ["**Zone manager**", "Their own zone only. Cases, that zone's forms and SLAs, templates, and their zone's team roster."],
    ["**Zone agent**", "Their own zone's cases: work them, change status, reply, close. No configuration."],
    ["**Auditor**", "Read-only across all zones, plus the audit log. Cannot change anything."],
], widths=[1.5, 4.9])

page_break(doc)

# ============================================================ 2. the public
h1(doc, "2. The public request experience")
para(doc,
     "This is what a member of the public sees. Understanding it helps when you "
     "are answering questions about a request.")

h2(doc, "2.1 Choosing a form")
figure(doc, "public-picker", "Figure 1 — the public landing page, grouped by zone")
para(doc, "Requesters pick the form for their region. Each form carries its own fields, "
          "legal wording and languages.")

h2(doc, "2.2 Filling in the form")
figure(doc, "public-form", "Figure 2 — the Europe request form")
bullets(doc, [
    "The form is an exact replica of the original hosted version: same fields, wording, order and languages.",
    "Fields marked with a red asterisk are required.",
    "Some fields appear only when relevant, for example the rectification table appears once **Data Rectification** is ticked.",
    "The language selector switches all labels and legal copy.",
])

h2(doc, "2.3 Email verification")
figure(doc, "public-verify", "Figure 3 — the Verify email step")
numbered(doc, [
    "The requester types their email address and presses **Verify email**.",
    "The portal emails a single-use link that expires after 15 minutes.",
    "Clicking the link marks that browser session verified; the page notices within a couple of seconds.",
    "**Submit** only unlocks after verification, and the server checks it again on submission.",
])
callout(doc, "note",
        "Changing the email address after verifying resets the check. This is deliberate: "
        "it stops someone verifying one address and submitting under another.")

h2(doc, "2.4 What happens on submission")
numbered(doc, [
    "The server re-validates every field. Client-side validation is treated as bypassed.",
    "A case is created with a reference number, and identifying fields are encrypted.",
    "The statutory clock starts from the moment of verified submission.",
    "The requester receives an acknowledgement email quoting the reference and the response date.",
    "The case is auto-assigned to a team member, who is emailed a direct link.",
])

page_break(doc)

# ============================================================= 3. signing in
h1(doc, "3. Signing in")
figure(doc, "login", "Figure 4 — the console sign-in screen", width=4.6)
numbered(doc, [
    "Open the internal console address.",
    "Enter your work email and password. Use the eye icon to check what you typed.",
    "You arrive on the dashboard for your zone.",
])
bullets(doc, [
    "Sessions end after **30 minutes** of inactivity, and after **8 hours** regardless. Both are configurable in Settings.",
    "After ten failed attempts from one address in an hour, further attempts are refused for the rest of that hour.",
    "Signing out is in the menu under your name, top right.",
])

h2(doc, "3.1 Getting around")
figure(doc, "command-palette", "Figure 5 — the command palette", width=5.2)
bullets(doc, [
    "The left sidebar holds the main sections. Use **Collapse** at the bottom to widen the working area.",
    "Press **Ctrl+K** (or **Cmd+K**) anywhere to jump to a page, switch theme, or open a recent case.",
    "The three icons at the top right switch between light, system and dark appearance. Your choice is remembered.",
])

page_break(doc)

# ============================================================ 4. dashboard
h1(doc, "4. Dashboard")
figure(doc, "dashboard", "Figure 6 — the dashboard")
para(doc, "The dashboard answers one question: is anything about to breach?")
table(doc, ["Panel", "What it tells you"], [
    ["On track", "Open cases comfortably inside their deadline."],
    ["At risk", "Open cases due within three days. Work these first."],
    ["Overdue", "Past the statutory deadline. Escalate these immediately."],
    ["Closed", "Cases resolved to date."],
    ["Weekly intake", "Submission volume over twelve weeks. Hover any point for the exact count."],
    ["Cases by status", "Where the workload is sitting in the workflow."],
    ["Requests by type", "Which rights are being exercised most."],
    ["Open cases per assignee", "Whether work is spread evenly across the team."],
    ["Due in the next 7 days", "Your working list for the week. Click any row to open the case."],
], widths=[1.8, 4.6])
para(doc, "Administrators and auditors can switch zones with the selector at the top right. "
          "Zone managers and agents always see their own zone.")

page_break(doc)

# ================================================================ 5. cases
h1(doc, "5. Working a case")

h2(doc, "5.1 Finding cases")
figure(doc, "cases", "Figure 7 — the case list")
bullets(doc, [
    "Filter by status and, if you have access to more than one, by zone.",
    "The search box narrows the rows already loaded, by reference, requester or request type.",
    "Overdue due-dates are shown in red with a warning icon.",
    "Click any row to open the case.",
])

h2(doc, "5.2 The case screen")
figure(doc, "case-detail", "Figure 8 — a case in detail")
para(doc, "The left panel is the submission exactly as the requester filled it in, rendered "
          "against the form version in force at the time. A key icon marks fields that are "
          "encrypted at rest.")
para(doc, "The right column carries the SLA clock, the timeline of every status change, and "
          "the correspondence sent so far.")

h3(doc, "Changing status")
para(doc, "Use **Status** in the action bar. The portal only offers moves that are legal from "
          "the current status, and enforces the rules that matter:")
table(doc, ["Status", "Meaning and rules"], [
    ["New", "Just submitted, not yet picked up."],
    ["Open", "Being worked on."],
    ["Pending", "Waiting on the requester, for example for identity evidence."],
    ["Pending Approver", "Waiting on an internal approval."],
    ["Extended", "Requires a written justification and a new due date. The portal reminds you to tell the requester, which GDPR Article 12(3) requires within the original month."],
    ["Overdue", "Set by the system only when the clock passes the deadline. You cannot set it by hand."],
    ["Closed", "Requires an outcome code and a closing note. Stops the SLA clock."],
], widths=[1.5, 4.9])

h3(doc, "Outcome codes")
bullets(doc, [
    "**Fulfilled** — everything asked for was done.",
    "**Partially fulfilled** — part was actioned; the rest was exempt or concerned other people.",
    "**Refused** — manifestly unfounded or excessive, or an exemption applied.",
    "**Withdrawn** — the requester asked to stop.",
    "**Identity not verified** — closed because identity could not be established.",
    "**Out of scope** — the data is not ours to act on.",
])

h3(doc, "Reassigning")
para(doc, "**Assign** moves the case to another member of the same zone. When a case already "
          "has an owner, a reason is required and is written to the audit log.")

h3(doc, "Pausing the clock")
para(doc, "Where the zone's policy permits it, **Pause** stops the SLA clock while you wait on "
          "the requester. Resuming pushes the due date out by exactly the paused time. Where "
          "the regime does not allow stopping the clock, the button is not offered.")

h3(doc, "Replying")
para(doc, "**Send response** opens the composer. Pick a template, and the subject and body are "
          "filled in with the case details already substituted. Edit anything you like before "
          "sending. Every message is logged on the case and in the audit trail.")

page_break(doc)

# ============================================================ 6. templates
h1(doc, "6. Response templates")
figure(doc, "templates", "Figure 9 — the template library")
para(doc, "The portal ships with eighteen professionally written templates covering every "
          "common outcome, including acknowledgement, identity verification, clarification, "
          "extension, each fulfilment type, refusal, withdrawal and out-of-scope, plus "
          "LGPD and ARCO variants for the South and Middle Americas zones.")

h2(doc, "6.1 Editing a template")
numbered(doc, [
    "Open **Templates** and press **Edit** on the row you want.",
    "Change the name, zone, request type, subject or body.",
    "Press **Save new version**. The previous wording is kept as an earlier version.",
])
callout(doc, "note",
        "Leaving **Zone** blank makes a template available in every zone. Leaving **Request type** "
        "blank makes it available for every type.")

h2(doc, "6.2 Variables")
para(doc, "Anything in double braces is replaced when the draft is built. Click a variable "
          "chip under the body box to insert it.")
table(doc, ["Variable", "Becomes"], [
    ["`{{case_ref}}`", "The case reference, for example DSR-EUR-2026-00147"],
    ["`{{requester_name}}`", "The requester's name as submitted"],
    ["`{{requester_email}}`", "The verified email address"],
    ["`{{zone}}`", "EUR, SAZ or MAZ"],
    ["`{{request_type}}`", "The rights being exercised"],
    ["`{{submission_date}}`", "The date the request was verified and submitted"],
    ["`{{due_date}}`", "The current statutory deadline"],
    ["`{{assignee_name}}`", "The team member handling the case"],
], widths=[1.9, 4.5])

callout(doc, "warn",
        "The supplied wording is a professional starting point, not legal advice. Have Legal "
        "review the templates for each jurisdiction before you use them with real requesters.")

page_break(doc)

# ======================================================== 7. forms and SLAs
h1(doc, "7. Editing forms and SLAs")
para(doc, "Administrators and zone managers can change the public forms and the deadlines "
          "they run on, without a developer and without a deployment.")

h2(doc, "7.1 The forms list")
figure(doc, "forms-list", "Figure 10 — forms available to edit")
para(doc, "Each row shows the zone, how many fields the form has, how many languages it "
          "supports and which version is live. Zone managers only see their own zone.")

h2(doc, "7.2 Editing fields")
figure(doc, "form-editor-fields", "Figure 11 — the form structure")
para(doc, "The left column is the form exactly as requesters meet it, top to bottom. Badges "
          "mark required fields and fields that only appear conditionally.")
numbered(doc, [
    "Click a component to load its settings on the right.",
    "Use the arrows on a row to move it up or down.",
    "Use the cross to remove it. You are asked to confirm.",
    "Use **Add field** to insert a new one above the submit button.",
])

figure(doc, "form-editor-field-selected", "Figure 12 — editing a selected field")
table(doc, ["Setting", "What it controls"], [
    ["Label", "The question the requester reads."],
    ["Field name", "The identifier stored with the case. Changing it on a live form breaks continuity with existing reports."],
    ["Placeholder", "Grey hint text inside the box."],
    ["Help text", "A line of guidance under the field."],
    ["Required", "Whether the form can be submitted without it. Enforced again on the server."],
    ["Options", "For dropdowns, checkboxes and radio buttons: the label the requester sees and the value stored."],
    ["Visibility", "Show this component only when another field holds a given value."],
], widths=[1.5, 4.9])

h3(doc, "Adding a field")
figure(doc, "form-editor-add-field", "Figure 13 — the field palette", width=5.4)
para(doc, "Eleven field types are available, from short text and dropdowns through to date "
          "pickers, file uploads and explanatory text blocks.")

h2(doc, "7.3 Editing the wording")
figure(doc, "form-editor-content", "Figure 14 — page content")
para(doc, "Change the heading, the introduction, the section titles and the duplicate-request "
          "notice. HTML is supported, so links and emphasis work as expected.")
callout(doc, "danger",
        "Introduction copy usually contains legally reviewed statements about identity, "
        "consent and retention. Do not paraphrase it without Legal's approval.")

h2(doc, "7.4 Workflow and deadlines for a form")
figure(doc, "form-editor-workflow", "Figure 15 — workflow and SLA settings")
table(doc, ["Setting", "Effect"], [
    ["Response duration", "Days allowed to respond to requests from this form."],
    ["Reminder lead time", "How many days before the deadline the assignee is nudged."],
    ["Count business days only", "Skips weekends and the zone's public holidays."],
    ["Allow extensions", "Whether agents may extend, and by how many days."],
    ["Verification link lifetime", "How long the emailed magic link stays valid."],
    ["Maximum open requests", "How many open cases one requester may have."],
    ["Cooling-off period", "Days a requester must wait before filing the same type again."],
    ["Allow parallel requests", "Whether one requester may have several cases open at once."],
    ["Offer file upload", "Adds an upload control, optionally mandatory, with your own instructions."],
], widths=[1.9, 4.5])

h2(doc, "7.5 Publishing and rolling back")
figure(doc, "form-editor-versions", "Figure 16 — version history")
numbered(doc, [
    "Make your changes. An **Unpublished changes** badge appears.",
    "Press **Preview** to open the live public form in a new tab and sanity-check it.",
    "Press **Publish changes**. The portal validates the form and refuses anything broken, listing each problem.",
    "The new version goes live immediately.",
])
callout(doc, "ok",
        "Publishing never rewrites history. Cases already submitted keep rendering against the "
        "version they were filed under, so an old case always shows exactly what its requester saw.")
para(doc, "To undo, open **Versions** and press **Restore** on an earlier one. That republishes "
          "it as the newest version, so the trail stays complete.")

h2(doc, "7.6 SLA policies")
figure(doc, "sla-policies", "Figure 17 — the SLA matrix")
para(doc, "SLA policies are set per zone and per request type. The engine always picks the most "
          "specific match: the request type first, then the zone fallback.")
table(doc, ["Setting", "Effect"], [
    ["Response deadline", "Statutory days to respond."],
    ["Extension allowance", "Extra days an agent may add. Zero forbids extensions entirely."],
    ["Timezone", "Used when counting business days."],
    ["Count business days only", "Skips weekends and the listed holidays."],
    ["Allow pausing the clock", "Only enable where the regime permits stopping the clock."],
    ["Reminder points", "Percentages of the deadline at which the assignee is reminded, for example 75, 90, 100."],
    ["Public holidays", "ISO dates skipped when counting business days."],
], widths=[1.9, 4.5])
callout(doc, "warn",
        "The shipped values are placeholders: EUR 30 days, SAZ 15 days, MAZ 20 days. Confirm the "
        "real figure for every zone and request type with Legal before go-live.")

page_break(doc)

# ================================================================= 8. team
h1(doc, "8. Team and assignment")
figure(doc, "team", "Figure 18 — team and routing")

h2(doc, "8.1 How cases are routed")
table(doc, ["Strategy", "Behaviour"], [
    ["Round robin", "Rotates evenly through available members. The default."],
    ["Least open cases", "Gives the case to whoever has the smallest open workload."],
    ["Weighted", "Balances by capacity weight, for part-time or partly allocated staff."],
    ["Manual queue", "Nothing is auto-assigned; cases wait to be picked up."],
], widths=[1.6, 4.8])
para(doc, "Anyone inactive, or inside an out-of-office window, is skipped automatically. If a "
          "zone has nobody available the case stays unassigned and a warning is logged, so it "
          "is never silently lost.")

h2(doc, "8.2 Managing people")
numbered(doc, [
    "Fill in email, name, role and zone, then press **Add member**.",
    "Adjust **Capacity** to weight how much work someone receives.",
    "Set **Out of office until** to take someone out of rotation; clear the date to bring them back.",
    "Switch **Active** off when someone leaves. Their history stays intact.",
])
callout(doc, "note",
        "New members sign in through your identity provider once it is connected. Break-glass "
        "passwords are set only from the server command line, never through this screen.")

page_break(doc)

# ================================================================ 9. audit
h1(doc, "9. Audit log")
figure(doc, "audit", "Figure 19 — the audit trail")
para(doc, "Every view, edit, status change, email, form publication and configuration change is "
          "recorded with who did it, when, from which address, and what changed.")
bullets(doc, [
    "The log is **append-only**: the database itself refuses updates and deletions, even from its owner.",
    "Secret values such as passwords and API keys are recorded as redacted, never in the clear.",
    "Filter by entity type, or search the text of any entry.",
    "Only administrators, super administrators and auditors can read it.",
])

page_break(doc)

# ============================================================= 10. settings
h1(doc, "10. Settings")
callout(doc, "note", "Settings is restricted to **super administrators**.")
figure(doc, "settings", "Figure 20 — the Settings screen")
para(doc, "Most of what used to be an environment variable is edited here and takes effect "
          "immediately, with no restart. Email delivery is the exception — see 10.2.")

h2(doc, "10.1 How values resolve")
numbered(doc, [
    "A value **saved here** always wins.",
    "Otherwise the server's environment value applies.",
    "Otherwise a built-in default applies.",
])
para(doc, "Each field shows which of the three it is currently using. Clearing a field and "
          "saving removes the stored value so the environment applies again.")
callout(doc, "ok",
        "Secrets are encrypted before storage and are never sent back to the browser. The screen "
        "only shows whether one is set.")

h2(doc, "10.2 Email delivery")
para(doc, "Microsoft Graph is the portal's only production email adapter. The five fields in this "
          "group are shown **read-only**, each marked \"Set in /opt/dsr/server/.env\": saving "
          "the screen never changes them, and the API refuses a write even if one is attempted "
          "directly. They live in a file on the server rather than the database on purpose — an "
          "email configuration that decides who a verification link appears to come from should "
          "not be a setting a browser session can change.")
table(doc, ["Field", "What it is"], [
    ["Active provider", "`graph` in production. `console` is a development-only setting that writes messages to a log instead of sending."],
    ["Privacy mailbox", "The shared mailbox that case responses and verification links are sent from. The sender name recipients see is that mailbox's own display name, set in Exchange rather than here."],
    ["Azure tenant ID, application ID, client secret", "The Microsoft Graph app registration authorised to send as the privacy mailbox."],
], widths=[1.9, 4.5])
callout(doc, "note",
        "To change any of these, ask whoever administers the server to edit "
        "/opt/dsr/server/.env and restart the dsr-api service. If a required Graph credential "
        "is left empty, the service refuses to start at all, rather than starting up healthy "
        "and silently dropping the first email.")

h2(doc, "10.3 Checking email works")
figure(doc, "settings-diagnostics", "Figure 21 — connection diagnostics")
para(doc, "Three tools sit in the right-hand column, all working against whichever provider "
          "the server's environment currently selects:")
bullets(doc, [
    "**Test connection** signs in to Microsoft Graph without sending anything.",
    "**Run diagnostics** checks each layer in turn — name resolution, the HTTPS connection, then authentication — and names the layer that failed with what to do about it.",
    "**Send test** delivers a real message to an address you choose.",
])
callout(doc, "note",
        "If the console itself will not load because the service failed to start, the same "
        "four checks are available from a terminal on the server as "
        "`node server/scripts/verify-email.mjs` — the first thing to run when diagnosing a "
        "mail outage.")

h2(doc, "10.4 Other settings")
table(doc, ["Group", "Contains"], [
    ["Portal and URLs", "The public and internal addresses used in emails and magic links."],
    ["Security", "CAPTCHA keys, session idle and absolute lifetimes, and the sign-in and verification rate limits."],
    ["Branding", "Organisation name and the reply-to address shown to requesters."],
], widths=[1.7, 4.7])

page_break(doc)

# ============================================================ 11. reference
h1(doc, "11. Quick reference")

h2(doc, "11.1 Keyboard shortcuts")
table(doc, ["Keys", "Action"], [
    ["Ctrl+K or Cmd+K", "Open the command palette"],
    ["Up and Down", "Move through palette results"],
    ["Enter", "Open the highlighted result"],
    ["Esc", "Close the palette or any dialog"],
], widths=[1.9, 4.5])

h2(doc, "11.2 Common questions")
h3(doc, "A requester says they never received the verification email.")
bullets(doc, [
    "Ask them to check the spam folder; the message comes from the privacy mailbox.",
    "Links expire after 15 minutes. Ask them to press **Verify email** again.",
    "Only three verification emails per address per hour are sent. Ask them to wait if they have tried repeatedly.",
    "If nobody is receiving email, a super administrator should run **Run diagnostics** in Settings.",
])

h3(doc, "A case is overdue but we are waiting on the requester.")
para(doc, "Where the zone's policy allows it, pause the SLA clock from the case screen. Where it "
          "does not, the clock keeps running: that is a legal constraint, not a limitation of "
          "the portal.")

h3(doc, "We need to add a question to a form.")
para(doc, "Open **Forms & SLAs**, choose the form, press **Add field**, configure it and publish. "
          "The public form updates immediately, and existing cases are unaffected.")

h3(doc, "Someone left the team.")
para(doc, "Switch them to inactive on the **Team** screen. Auto-assignment skips them straight "
          "away, and their case history stays intact for the audit trail.")

h2(doc, "11.3 Appearance")
figure(doc, "dashboard-dark", "Figure 22 — the dashboard in dark appearance")
para(doc, "The console supports light and dark appearance, and can follow your operating system. "
          "The choice is per person and remembered on the device.")

out = ROOT / "docs" / "DSR Portal - User Guide.docx"
doc.save(out)
print(f"written: {out}")
