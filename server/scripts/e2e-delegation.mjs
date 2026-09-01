// Case delegation e2e: a group with no portal login, sent a case by an
// approver, accepting it and sending PDFs back through one bearer-token link.
//
// Requires: running server, EMAIL_PROVIDER=console with EMAIL_CONSOLE_FILE
// set (so the invite emails can be read back the way a recipient would --
// only the SHA-256 of the token is ever stored, so there is no other way to
// get it), a migrated schema, imported forms, and admin@example.com from
// create-user.mjs. Model: scripts/e2e-workflow.mjs for login/check/api,
// scripts/e2e-intake.mjs for driving the public, unauthenticated routes.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const EMAIL_FILE = new URL('../.email-out.jsonl', import.meta.url);
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
};

async function login(email, password) {
  const res = await fetch(`${BASE}/internal/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
const api = async (method, path, cookie, body) => {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
// Public, unauthenticated calls -- the applicant's own draft session, kept in
// its own cookie jar so it is never confused with the approver's.
let draftCookie = '';
async function draftCall(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.noCookie ? {} : { cookie: draftCookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !opts.noCookie) draftCookie = setCookie.split(';')[0];
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
// The emailed link itself: no cookie, no account -- exactly what the group
// member clicking it has.
const pub = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
async function pubUpload(token, buffer, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${BASE}/public/delegation/${token}/upload`, { method: 'POST', body: form });
  return { status: res.status, data: await res.json().catch(() => null) };
}
function emailLines() {
  return readFileSync(EMAIL_FILE, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** Every forbidden requester fact, checked by name and by value, never as a
 *  general shape check -- this is the guarantee most likely to be eroded by a
 *  later convenience, so it must fail loudly and specifically if it ever is. */
function assertNoRequesterData(label, view) {
  const text = JSON.stringify(view);
  for (const key of ['requesterEmail', 'requesterName', 'fields', 'requesterEmailEnc', 'requesterNameEnc']) {
    check(`${label}: no "${key}" key`, !text.includes(`"${key}"`), text.slice(0, 200));
  }
  for (const [what, value] of [
    ['requester email address', REQ_EMAIL],
    ['requester name', REQ_NAME],
    ['seeded CPF', CPF],
    ['seeded date of birth', DOB],
    ['seeded phone number', PHONE],
  ]) {
    check(`${label}: no ${what} value`, !text.includes(value), value);
  }
}

const RUN = Date.now();
const REQ_EMAIL = `requester-deleg+${RUN}@example.com`;
const REQ_FIRST = 'Zenobia';
const REQ_LAST = 'Quillfeather';
const REQ_NAME = `${REQ_FIRST} ${REQ_LAST}`;
const CPF = '529.982.247-25';
const DOB = '1988-02-29';
const PHONE = '+55 21 98765-4321';

const db = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await db.connect();

const admin = await login('admin@example.com', process.env.E2E_ADMIN_PASSWORD ?? 'Str0ng-Passw0rd!x');
check('admin logged in', Boolean(admin));

// --- set up the case this delegation will be sent about --------------------
// A real submission through the public form, so encryption, the SLA clock and
// requester identifiers are exactly what a live case has -- not a shortcut
// that would let the "no requester data" assertions pass for the wrong reason.
let draft = await draftCall('POST', '/public/drafts', { formKey: 'eur-1' });
check('draft created', draft.status === 201 && Boolean(draft.data.draftId), JSON.stringify(draft));
const draftId = draft.data.draftId;

let send = await draftCall('POST', '/public/verification/send', { draftId, email: REQ_EMAIL });
check('verification send accepted', send.data.status === 'accepted');

const verifyMail = emailLines().findLast(
  (l) => l.payload.templateId === 'verify-email' && l.payload.to === REQ_EMAIL,
);
check('verification email captured', Boolean(verifyMail));
const verifyToken = /token=([A-Za-z0-9_-]+)/.exec(verifyMail?.payload.html ?? '')?.[1] ?? '';

const consume = await fetch(`${BASE}/public/verification/consume?token=${verifyToken}`);
check('magic link consumed', consume.status === 200);

const submission = await draftCall('POST', '/public/submissions', {
  draftId, formKey: 'eur-1',
  values: {
    ticket_type: { access: true },
    email: REQ_EMAIL,
    first_name: REQ_FIRST,
    last_name: REQ_LAST,
    country: 'Belgium',
    additionalCustomCheckbox: true,
  },
});
check('case submitted', submission.status === 201 && /^DSR-EUR-\d{4}-\d{5}$/.test(submission.data.caseRef ?? ''),
  JSON.stringify(submission));
const caseRef = submission.data.caseRef;
const caseRow = (await db.query('SELECT id FROM cases WHERE case_ref = $1', [caseRef])).rows[0];
const caseId = caseRow.id;

// Direct identifiers the requester never put on a form eur-1 has: seeded
// straight onto the case so the "does the delegation link leak them"
// assertions have real, known values to search for.
await db.query(
  `INSERT INTO case_fields (case_id, field_key, value_json, encrypted) VALUES
     ($1, 'cpf', to_jsonb($2::text), false),
     ($1, 'dob', to_jsonb($3::text), false),
     ($1, 'phone', to_jsonb($4::text), false)`,
  [caseId, CPF, DOB, PHONE],
);

// Baseline, captured before the delegation touches the case, per spec §4:
// ownership, assignment and the SLA clock must not move because a case was
// sent to a group.
const before = await api('GET', `/internal/cases/${caseId}`, admin);
const baseline = { status: before.data.status, assigneeId: before.data.assigneeId, dueAt: before.data.dueAt };
const slaBefore = (await db.query('SELECT due_at, state FROM sla_clocks WHERE case_id = $1', [caseId])).rows[0];

// --- 1. create a group with three members -----------------------------------
const members = [
  { name: 'Priya Shah', email: `priya.hr+${RUN}@example.com` },
  { name: 'Marcus Webb', email: `marcus.hr+${RUN}@example.com` },
  { name: 'Ines Duarte', email: `ines.hr+${RUN}@example.com` },
];
let r = await api('POST', '/internal/groups', admin, {
  zoneId: 'EUR', name: `E2E HR Group ${RUN}`, defaultMessage: 'Please help with this request.', members,
});
check('group created', (r.status === 201 || r.status === 200) && Boolean(r.data.id), JSON.stringify(r));
const groupId = r.data.id;

r = await api('GET', '/internal/groups', admin);
const group = (r.data ?? []).find((g) => g.id === groupId);
check('group has three members', group?.members?.length === 3, JSON.stringify(group));
const member2 = group.members.find((m) => m.email === members[1].email);
const member1 = group.members.find((m) => m.email === members[0].email);
check('member 2 (the accepter) resolved', Boolean(member2));

// --- 2. send the case to it --------------------------------------------------
const noteText = "Please confirm this person's employment dates before we respond.";
const sentAt = Date.now();
r = await api('POST', `/internal/cases/${caseId}/delegate`, admin, { groupId, note: noteText });
check('delegate ok', (r.status === 201 || r.status === 200) && r.data.sentTo === 3, JSON.stringify(r));
const delegationId = r.data.id;

const delegationRows = (await db.query('SELECT * FROM case_delegations WHERE case_id = $1', [caseId])).rows;
check('exactly one delegation row', delegationRows.length === 1, `found ${delegationRows.length}`);
check('delegation stage starts sent', delegationRows[0]?.stage === 'sent');

const memberEmails = members.map((m) => m.email);
const inviteLines = emailLines().filter(
  (l) => l.payload.templateId === 'delegation-invite' && memberEmails.includes(l.payload.to),
);
check('console provider actually sent 3 delegation-invite emails', inviteLines.length === 3,
  `found ${inviteLines.length}`);

// Scoped to the invite template, not just the case: the case already has one
// email_log row from the intake acknowledgement sent at submission (step 6 of
// IntakeService#submit), so `WHERE case_id = $1` alone also counts that
// unrelated row and can never equal exactly 3 once delegation logs its own.
const logRows = (
  await db.query(
    "SELECT * FROM email_log WHERE case_id = $1 AND template_id = 'delegation-invite'",
    [caseId],
  )
).rows;
check('3 emails recorded in email_log for the send', logRows.length === 3,
  `found ${logRows.length} -- delegation.service.ts#send() never writes to email_log on a successful ` +
  `sendTransactional, unlike every other call site (public/intake.service.ts, cases/assignment.service.ts, ` +
  `cases/outbound.service.ts all insert a row on success; EmailDispatcher only logs failures). Real gap, not a test bug.`);

const tokenMatch = /#\/delegation\/([A-Za-z0-9_-]{20,})/.exec(inviteLines[0]?.payload.html ?? '');
check('token recovered from the invite email', Boolean(tokenMatch));
const token = tokenMatch?.[1] ?? '';

// --- 3. GET the public view --------------------------------------------------
r = await pub('GET', `/public/delegation/${token}`);
check('public view 200', r.status === 200, JSON.stringify(r));
check('view has case ref', r.data?.caseRef === caseRef);
check('view has request type', r.data?.requestType === 'access', r.data?.requestType);
check('view has a due date', /^\d{4}-\d{2}-\d{2}$/.test(r.data?.dueDate ?? ''), r.data?.dueDate);
check('view has the approver note', r.data?.note === noteText);
assertNoRequesterData('view before accept', r.data);

// --- 4. upload before accepting ----------------------------------------------
const realPdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>');
r = await pubUpload(token, realPdf, 'evidence.pdf', 'application/pdf');
check('upload before accept -> 403', r.status === 403, JSON.stringify(r));

// --- 5. accept as member 2 ---------------------------------------------------
r = await pub('POST', `/public/delegation/${token}/accept`, { memberId: member2.id });
check('accept ok', r.status === 200 || r.status === 201, JSON.stringify(r));
check('stage now accepted', r.data?.stage === 'accepted', r.data?.stage);
check('acceptedBy is member 2', r.data?.acceptedBy === member2.name, r.data?.acceptedBy);

r = await api('GET', `/internal/cases/${caseId}`, admin);
const namesAccepter = (r.data.history ?? []).some(
  (h) => typeof h.note === 'string' && h.note.includes('Accepted by') && h.note.includes(member2.name),
);
check('case timeline names the accepter', namesAccepter, JSON.stringify(r.data.history?.slice(0, 3)));

// --- 6. accept again ----------------------------------------------------------
r = await pub('POST', `/public/delegation/${token}/accept`, { memberId: member1.id });
check('second accept -> 403', r.status === 403, JSON.stringify(r));

r = await pub('GET', `/public/delegation/${token}`);
check('first accepter still stands', r.data?.acceptedBy === member2.name, r.data?.acceptedBy);

// --- 7. upload a real PDF -----------------------------------------------------
const attachmentsBefore = (
  await db.query(`SELECT count(*)::int AS n FROM case_attachments WHERE case_id = $1 AND source = 'delegate'`, [caseId])
).rows[0].n;
r = await pubUpload(token, realPdf, 'evidence.pdf', 'application/pdf');
check('real pdf upload ok', r.status === 200 || r.status === 201, JSON.stringify(r));
check('uploaded file listed on the view', (r.data?.files ?? []).some((f) => f.filename.includes('evidence')),
  JSON.stringify(r.data?.files));

const attachRow = (
  await db.query(
    `SELECT * FROM case_attachments WHERE case_id = $1 AND source = 'delegate' ORDER BY created_at DESC LIMIT 1`,
    [caseId],
  )
).rows[0];
check('pdf landed in case_attachments with source=delegate', Boolean(attachRow), 'no row found');

// --- 8. upload an EXE renamed .pdf --------------------------------------------
// Bytes decide, not the filename or the declared content type: both look
// exactly like a legitimate PDF upload here.
const exeAsPdf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
r = await pubUpload(token, exeAsPdf, 'report.pdf', 'application/pdf');
check('exe renamed .pdf -> 400', r.status === 400, JSON.stringify(r));

const attachmentsAfterExe = (
  await db.query(`SELECT count(*)::int AS n FROM case_attachments WHERE case_id = $1 AND source = 'delegate'`, [caseId])
).rows[0].n;
check('nothing new stored for the rejected exe', attachmentsAfterExe === attachmentsBefore + 1,
  `before real pdf=${attachmentsBefore}, after exe attempt=${attachmentsAfterExe}`);

// --- 9. case assignee/status/SLA unchanged since step 2 -----------------------
r = await api('GET', `/internal/cases/${caseId}`, admin);
check('status unchanged', r.data.status === baseline.status, `${baseline.status} -> ${r.data.status}`);
check('assignee unchanged', r.data.assigneeId === baseline.assigneeId,
  `${baseline.assigneeId} -> ${r.data.assigneeId}`);
check('due date unchanged', r.data.dueAt === baseline.dueAt, `${baseline.dueAt} -> ${r.data.dueAt}`);
const slaAfter = (await db.query('SELECT due_at, state FROM sla_clocks WHERE case_id = $1', [caseId])).rows[0];
check('sla clock state unchanged', slaAfter.state === slaBefore.state, `${slaBefore.state} -> ${slaAfter.state}`);
check('sla clock due_at unchanged', slaAfter.due_at?.getTime() === slaBefore.due_at?.getTime(),
  `${slaBefore.due_at} -> ${slaAfter.due_at}`);

// --- 10. close the delegation ---------------------------------------------------
r = await api('POST', `/internal/cases/${caseId}/delegations/${delegationId}/close`, admin);
check('close ok', r.status === 200 || r.status === 201, JSON.stringify(r));
const closedRow = (await db.query('SELECT stage FROM case_delegations WHERE id = $1', [delegationId])).rows[0];
check('delegation stage closed', closedRow?.stage === 'closed');

// --- 11. upload after close -----------------------------------------------------
r = await pubUpload(token, realPdf, 'late.pdf', 'application/pdf');
check('upload after close -> 403', r.status === 403, JSON.stringify(r));

// --- 12. GET the view after close ------------------------------------------------
r = await pub('GET', `/public/delegation/${token}`);
check('view after close -> 200', r.status === 200, JSON.stringify(r));
check('view says closed', r.data?.stage === 'closed', r.data?.stage);
assertNoRequesterData('view after close', r.data);

// --- 13. delegate an imported case ------------------------------------------------
const importedRef = `DSR-EUR-IMPORT-${RUN}`;
const importedRow = await db.query(
  `INSERT INTO cases (case_ref, zone_id, form_key, form_version, request_types,
                       requester_email_enc, requester_email_hmac, status, source)
   VALUES ($1, 'EUR', 'eur-1', 1, '["access"]'::jsonb, 'v1:not-real', 'not-a-real-hmac', 'new', 'import')
   RETURNING id`,
  [importedRef],
);
const importedCaseId = importedRow.rows[0].id;
r = await api('POST', `/internal/cases/${importedCaseId}/delegate`, admin, { groupId, note: 'x' });
check('delegating an imported case -> 403 from CaseSourceGuard', r.status === 403, JSON.stringify(r));

// --- 14. nothing ever sent to the requester --------------------------------------
const sentToRequester = emailLines().some(
  (l) => l.kind === 'transactional' && l.payload.to === REQ_EMAIL && l.payload.templateId !== 'verify-email'
    && l.payload.templateId !== 'submission-ack',
);
check('nothing sent to the requester over the course of the delegation', !sentToRequester);
const requesterInAnyDelegationMail = inviteLines.some((l) => l.payload.to === REQ_EMAIL);
check('the requester was never among the delegation-invite recipients', !requesterInAnyDelegationMail);

await db.end();
process.exit(failures ? 1 : 0);
