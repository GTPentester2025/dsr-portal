// Workflow + assignment + SLA + templates + dashboard e2e.
// Requires: running server, test users, at least the EUR case from e2e-intake.
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
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

const admin = await login('admin@example.com', 'AdminPassw0rd12345');
const eurAgent = await login('eur.agent@example.com', 'AgentPassw0rd12345');

// The suite closes the case it works on, so always pick an open one. Run
// e2e-intake.mjs first if none is available.
let r = await api('GET', '/internal/cases?zone=EUR&pageSize=100', admin);
const c = (r.data.items ?? []).find((x) => x.status !== 'closed');
check('have an open EUR case to work on', Boolean(c),
  'run scripts/e2e-intake.mjs first to create one');
if (!c) process.exit(1);

// users list for assignee id
r = await api('GET', '/internal/admin/users?zone=EUR', admin);
const eurAgentRow = r.data.find((u) => u.email === 'eur.agent@example.com');
check('admin lists EUR users', Boolean(eurAgentRow));

// nothing in the matrix transitions *to* 'new', so this is illegal from any state
r = await api('POST', `/internal/cases/${c.id}/status`, admin, { toStatus: 'new' });
check('illegal transition rejected', r.status === 400, JSON.stringify(r.data));

// user cannot set overdue
r = await api('POST', `/internal/cases/${c.id}/status`, admin, { toStatus: 'overdue' });
check('manual overdue rejected', r.status === 400);

// assign to EUR agent (fresh case may be unassigned or auto-assigned)
r = await api('POST', `/internal/cases/${c.id}/assign`, admin, {
  assigneeId: eurAgentRow.id, reason: 'routing to EUR agent for test',
});
check('assign ok', r.status === 201 || r.status === 200, JSON.stringify(r.data));

// status new->open (if auto-assign already moved it, this 400s; accept either path)
r = await api('POST', `/internal/cases/${c.id}/status`, admin, { toStatus: 'open', note: 'triaged' });
check('transition to open (or already open)', r.status === 201 || r.status === 200 || r.status === 400);

// extension without justification rejected
r = await api('POST', `/internal/cases/${c.id}/status`, admin, { toStatus: 'extended' });
check('extension needs justification', r.status === 400);

// extension with justification works + returns Art.12(3) notice
const newDue = new Date(Date.now() + 45 * 86400000).toISOString();
r = await api('POST', `/internal/cases/${c.id}/status`, admin, {
  toStatus: 'extended', justification: 'Complex request, multiple systems', newDueDate: newDue,
});
check('extension accepted with notice', (r.status === 201 || r.status === 200) && String(r.data?.notice ?? '').includes('extension'), JSON.stringify(r.data));

// close requires outcome
r = await api('POST', `/internal/cases/${c.id}/status`, admin, { toStatus: 'closed' });
check('close needs outcome', r.status === 400);

// templates: create once and reuse, so repeat runs do not pile up rows
r = await api('GET', '/internal/templates?zone=EUR', admin);
const existingTpl = (r.data ?? []).find((t) => t.name === 'E2E acknowledgement');
r = await api('POST', '/internal/templates', admin, {
  id: existingTpl?.id, name: 'E2E acknowledgement', zoneId: 'EUR',
  subject: 'Update on {{case_ref}}',
  body: '<p>Dear {{requester_name}},</p><p>Your {{request_type}} request {{case_ref}} is due {{due_date}}.</p>',
});
check('template created', (r.status === 201 || r.status === 200) && r.data.id, JSON.stringify(r.data));
const tplId = r.data.id;

// zone agent cannot create templates
r = await api('POST', '/internal/templates', eurAgent, { name: 'x', subject: 's', body: 'b' });
check('agent cannot create template (403)', r.status === 403);

r = await api('GET', `/internal/cases/${c.id}/draft-email?templateId=${tplId}`, eurAgent);
check('draft renders variables',
  r.status === 200 && r.data.subject.includes(c.caseRef) && /^requester(\+\d+)?@example\.com$/.test(r.data.to ?? ''),
  JSON.stringify(r.data));

r = await api('POST', `/internal/cases/${c.id}/send-email`, eurAgent, {
  to: [r.data.to], subject: r.data.subject, body: r.data.body, templateId: tplId,
});
check('outbound send ok', (r.status === 201 || r.status === 200) && r.data.ok, JSON.stringify(r.data));

// SLA: force the clock past due directly, then recompute -> overdue
const db = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await db.connect();
await db.query(`UPDATE sla_clocks SET due_at = now() - interval '1 hour', state='running' WHERE case_id = $1`, [c.id]);
await db.query(`UPDATE cases SET due_at = now() - interval '1 hour' WHERE id = $1`, [c.id]);
r = await api('POST', '/internal/sla/recompute', admin);
check('recompute reports breach', (r.status === 201 || r.status === 200) && r.data.breached >= 1, JSON.stringify(r.data));
const st = await db.query(`SELECT status FROM cases WHERE id = $1`, [c.id]);
check('case now overdue (system-set)', st.rows[0].status === 'overdue');

// close it properly now
r = await api('POST', `/internal/cases/${c.id}/status`, admin, {
  toStatus: 'closed', outcomeCode: 'fulfilled', closureNote: 'Data package delivered.',
});
check('close with outcome ok', r.status === 201 || r.status === 200, JSON.stringify(r.data));
const clock = await db.query(`SELECT state FROM sla_clocks WHERE case_id = $1`, [c.id]);
check('clock stopped on close', clock.rows[0].state === 'stopped');

// dashboard
r = await api('GET', '/internal/dashboard?zone=EUR', admin);
check('dashboard aggregates', r.status === 200 && Array.isArray(r.data.byStatus) && r.data.slaHealth, JSON.stringify(r.data).slice(0, 120));

// audit log has the trail
r = await api('GET', `/internal/admin/audit-log?entityType=case&entityId=${c.id}`, admin);
const actions = new Set((r.data ?? []).map((a) => a.action));
check('audit trail complete', ['case.status_change', 'case.reassigned', 'case.email_sent'].every((a) => actions.has(a)), [...actions].join(','));

// zone agent cannot read audit log
r = await api('GET', '/internal/admin/audit-log', eurAgent);
check('agent audit log 403', r.status === 403);

await db.end();
process.exit(failures ? 1 : 0);
