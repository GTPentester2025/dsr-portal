// End-to-end intake test against a running dev server (console email
// provider writing to .email-out.jsonl). Covers spec §3 flow + negatives.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const EMAIL_FILE = new URL('../.email-out.jsonl', import.meta.url);
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
};

const RUN = Date.now();
const EMAIL = `requester+${RUN}@example.com`;

// deterministic run: clear rate-limit counters from previous runs
{
  const c = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
  await c.connect();
  await c.query('DELETE FROM rate_counters');
  await c.end();
}

let cookie = '';
async function call(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.noCookie ? {} : { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !opts.noCookie) cookie = setCookie.split(';')[0];
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// 1. create draft
const draft = await call('POST', '/public/drafts', { formKey: 'eur-1' });
check('draft created', draft.status === 201 && draft.data.draftId, JSON.stringify(draft));
const draftId = draft.data.draftId;

// 2. status: not verified yet
let st = await call('GET', `/public/drafts/${draftId}/status`);
check('draft not verified initially', st.data.verified === false);

// 3. send verification
const send = await call('POST', '/public/verification/send', {
  draftId, email: EMAIL,
});
check('verification send uniform response', send.data.status === 'accepted');

// 4. extract token from console email
const lines = readFileSync(EMAIL_FILE, 'utf-8').trim().split('\n');
const mail = JSON.parse(lines[lines.length - 1]);
const m = /token=([A-Za-z0-9_-]+)/.exec(mail.payload.html);
check('verification email captured with token', Boolean(m));
const token = m?.[1] ?? '';

// 5. submission before verification is rejected
const early = await call('POST', '/public/submissions', {
  draftId, formKey: 'eur-1',
  values: { email: EMAIL },
});
check('submission blocked before verification', early.status === 400);

// 6. consume magic link
const consume = await fetch(`${BASE}/public/verification/consume?token=${token}`);
const consumeHtml = await consume.text();
check('magic link consume 200 + confirmed page', consume.status === 200 && consumeHtml.includes('confirmed'));

// 7. replay shows generic expired page
const replay = await fetch(`${BASE}/public/verification/consume?token=${token}`);
const replayHtml = await replay.text();
check('replayed link generic expired', replay.status === 200 && replayHtml.includes('no longer valid'));

// 8. draft now verified (same session)
st = await call('GET', `/public/drafts/${draftId}/status`);
check('draft verified after consume', st.data.verified === true);

// 9. full valid submission
const values = {
  user_type: 'consumer',
  ticket_type: { access: true, rectify: true },
  email: EMAIL,
  first_name: 'Ada',
  last_name: 'Lovelace',
  country: 'Belgium',
  additionalCustomCheckbox: true,
  rectification_details: [{ attr_name: 'Age', curr_val: '30', new_val: '31' }],
};
const sub = await call('POST', '/public/submissions', { draftId, formKey: 'eur-1', values });
check('valid submission accepted', sub.status === 201 && /^DSR-EUR-\d{4}-\d{5}$/.test(sub.data.caseRef ?? ''), JSON.stringify(sub.data));

// 10. ack email sent
const ackLines = readFileSync(EMAIL_FILE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
const ack = ackLines.findLast((l) => l.payload.templateId === 'submission-ack');
check('ack email contains case ref', Boolean(ack) && ack.payload.subject.includes(sub.data.caseRef ?? 'X'));

// 11. unknown field rejected
const d2 = await call('POST', '/public/drafts', { formKey: 'eur-1' });
const bad = await call('POST', '/public/submissions', {
  draftId: d2.data.draftId, formKey: 'eur-1',
  values: { ...values, evil_field: 'x' },
});
check('unknown field rejected', bad.status === 400);

// 12. submission with mismatched email (session verified different address)
const mismatch = await call('POST', '/public/submissions', {
  draftId, formKey: 'eur-1',
  values: { ...values, email: 'other@example.com' },
});
check('email mismatch rejected', mismatch.status === 400);

// 13. required-field enforcement server-side (missing ticket_type)
const { ticket_type, ...noTicket } = values;
const missing = await call('POST', '/public/submissions', {
  draftId, formKey: 'eur-1', values: noTicket,
});
check('missing required rejected', missing.status === 400);

// 14. hidden-field rule: rectification rows validated only when rectify chosen
const badRow = await call('POST', '/public/submissions', {
  draftId, formKey: 'eur-1',
  values: { ...values, rectification_details: [{ attr_name: '' }] },
});
check('empty required row field rejected', badRow.status === 400);

// 15. DB: case fields persisted, identifiers encrypted
const db = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await db.connect();
const caseRow = (await db.query('SELECT * FROM cases WHERE case_ref=$1', [sub.data.caseRef])).rows[0];
check('case row exists', Boolean(caseRow));
check('requester email stored encrypted', caseRow.requester_email_enc.startsWith('v1:'));
const fieldRows = (await db.query('SELECT field_key, value_json, value_enc, encrypted FROM case_fields WHERE case_id=$1', [caseRow.id])).rows;
const emailField = fieldRows.find((r) => r.field_key === 'email');
check('email field encrypted at rest', emailField?.encrypted && emailField.value_enc?.startsWith('v1:') && emailField.value_json === null);
const history = (await db.query('SELECT * FROM case_status_history WHERE case_id=$1 ORDER BY id', [caseRow.id])).rows;
check('status history written', history.length >= 1 && history[0].to_status === 'new');
const clock = (await db.query('SELECT * FROM sla_clocks WHERE case_id=$1', [caseRow.id])).rows;
check('sla clock started', clock.length === 1 && clock[0].state === 'running');
const audit = (await db.query(`SELECT * FROM audit_log WHERE action='case.created' AND entity_id=$1`, [caseRow.id])).rows;
check('audit log entry written', audit.length === 1);
await db.end();

// 16. rate limit: 3 sends/hour per email — 4th suppressed (no new email row)
const before = readFileSync(EMAIL_FILE, 'utf-8').trim().split('\n').length;
for (let i = 0; i < 4; i++) {
  await call('POST', '/public/verification/send', { draftId: d2.data.draftId, email: `ratelimit+${RUN}@example.com` });
}
const after = readFileSync(EMAIL_FILE, 'utf-8').trim().split('\n').length;
check('rate limit: 4 sends produce at most 3 emails', after - before <= 3, `delta=${after - before}`);

process.exit(failures ? 1 : 0);
