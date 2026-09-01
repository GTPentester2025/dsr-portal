/**
 * Transactional template registry.
 *
 * These are the system messages the portal sends on its own: verification,
 * acknowledgement, assignment, reminders and escalations. Case-reply templates
 * live in the `templates` table and are edited separately.
 *
 * Each one ships with a built-in default and can be overridden from the admin
 * console; an override is held in `overrides` and applied here, so providers
 * keep calling one synchronous function.
 *
 * Substitution is strict: an unknown {{variable}} throws rather than sending a
 * message with a raw placeholder in it. That is also why saving an override
 * validates its variables up front — see VARIABLES below.
 */
import { translationFor } from './translations';

export interface EmailTemplate {
  subject: string;
  html: string;
}

/**
 * What each template may reference. The sender passes exactly these, so a
 * template using anything else would throw at send time. Validating an edit
 * against this list turns that into an error the admin sees while typing.
 */
export const TEMPLATE_VARIABLES: Record<string, string[]> = {
  'verify-email': ['verification_url', 'ttl_minutes'],
  'submission-ack': ['case_ref', 'sla_statement'],
  'case-assigned': ['case_ref', 'zone', 'request_type', 'submission_date', 'due_date', 'case_url'],
  'sla-reminder': ['case_ref', 'zone', 'due_date', 'pct'],
  'case-new': [
    'case_ref', 'zone', 'request_type', 'requester_email', 'submission_date',
    'due_date', 'case_url', 'approvers',
  ],
  'case-escalated': [
    'case_ref', 'zone', 'request_type', 'assignee', 'status', 'pct', 'due_date', 'case_url',
  ],
  'case-unassigned': [
    'case_ref', 'zone', 'request_type', 'waiting', 'submission_date', 'due_date', 'case_url',
  ],
  'delegation-invite': ['case_ref', 'zone', 'request_type', 'due_date', 'note', 'link', 'from_name'],
  'test-email': ['provider', 'sent_at'],
};

/**
 * Variables that must never be written down, per template.
 *
 * `TEMPLATE_VARIABLES` above says what a template may reference. This says
 * which of those values are capabilities rather than content: both of these
 * are links carrying a bearer token, and whoever holds one can act as the
 * person the message was addressed to. Each feature says the same thing about
 * its token — the plaintext exists in the email and nowhere else, so that a
 * database dump does not hand over working links.
 *
 * A failed send was the one path contradicting that. `EmailDispatcher` hands
 * `SendGuardService.recordUndelivered` the rendered body and the variables it
 * was rendered from, and both land in `email_log` and `audit_log` — where
 * `email_log.body_html` is read straight back out onto the case screen. One
 * bouncing address was enough to leave a live, clickable link sitting in a
 * case's email history, and after two consecutive failures the guard throttles
 * that recipient, so every later send takes the same path.
 *
 * Listing a template here masks the named variables and suppresses its
 * rendered body on that path. Everything else a failure record is for
 * survives: the recipients, the subject, the template id, the error and the
 * failure kind are what make it useful. It is the token that must not.
 */
export const SENSITIVE_VARIABLES: Record<string, string[]> = {
  'verify-email': ['verification_url'],
  'delegation-invite': ['link'],
};

/** Shown in the console so an editor knows what each message is for. */
export const TEMPLATE_LABELS: Record<string, { label: string; description: string }> = {
  'verify-email': {
    label: 'Email verification',
    description: 'Sent to a requester to confirm they own the address before a case is created.',
  },
  'submission-ack': {
    label: 'Submission acknowledgement',
    description: 'Confirms receipt and gives the requester their reference number.',
  },
  'case-assigned': {
    label: 'Case assigned to an agent',
    description: 'Tells an agent a case is now theirs, with the deadline.',
  },
  'case-new': {
    label: 'New request notification',
    description: 'Sent to every approver in the zone, with the zone managers copied, when a request arrives.',
  },
  'sla-reminder': {
    label: 'SLA reminder',
    description: 'Warns the assignee as the response deadline approaches.',
  },
  'case-escalated': {
    label: 'SLA escalation',
    description: 'Goes to the zone escalation contact once a case passes its escalation threshold.',
  },
  'case-unassigned': {
    label: 'Unassigned case escalation',
    description: 'Goes to the escalation contact when nobody has picked a case up in time.',
  },
  'test-email': {
    label: 'Test message',
    description: 'Sent by the Send test button on the Settings screen.',
  },
};

const DEFAULTS: Record<string, EmailTemplate> = {
  'verify-email': {
    subject: 'Confirm your email address',
    html: `<p>To continue with your privacy request, please confirm your email address by clicking the link below:</p>
<p><a href="{{verification_url}}">Confirm my email address</a></p>
<p>This link expires in {{ttl_minutes}} minutes and can be used once.</p>
<p>If you did not start a privacy request, you can ignore this email.</p>`,
  },
  'submission-ack': {
    subject: 'Your privacy request {{case_ref}} has been received',
    html: `<p>We have received your privacy request.</p>
<p>Your reference number is <strong>{{case_ref}}</strong>. Please quote it in any correspondence.</p>
<p>{{sla_statement}}</p>`,
  },
  'case-assigned': {
    subject: '[{{zone}}] Case {{case_ref}} assigned to you — due {{due_date}}',
    html: `<p>Case <strong>{{case_ref}}</strong> has been assigned to you.</p>
<ul>
<li>Zone: {{zone}}</li>
<li>Request type: {{request_type}}</li>
<li>Submitted: {{submission_date}}</li>
<li>SLA due date: {{due_date}}</li>
</ul>
<p><a href="{{case_url}}">Open the case</a></p>`,
  },
  'case-new': {
    subject: '[{{zone}}] New privacy request {{case_ref}} — due {{due_date}}',
    html: `<p>A new privacy request has been submitted and is ready to be worked.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td><strong>Reference</strong></td><td>{{case_ref}}</td></tr>
<tr><td><strong>Zone</strong></td><td>{{zone}}</td></tr>
<tr><td><strong>Request type</strong></td><td>{{request_type}}</td></tr>
<tr><td><strong>Requester</strong></td><td>{{requester_email}}</td></tr>
<tr><td><strong>Submitted</strong></td><td>{{submission_date}}</td></tr>
<tr><td><strong>Response due</strong></td><td>{{due_date}}</td></tr>
</table>
<p><a href="{{case_url}}">Open the case</a></p>
<p><strong>Approvers for this zone</strong><br>{{approvers}}</p>
<p>Every approver in {{zone}} can work this request; it is not assigned to one person.</p>`,
  },
  'sla-reminder': {
    subject: '[{{zone}}] {{case_ref}} at {{pct}}% of SLA — due {{due_date}}',
    html: `<p>Case <strong>{{case_ref}}</strong> has used {{pct}}% of its SLA. Response is due by <strong>{{due_date}}</strong>.</p>`,
  },
  'case-escalated': {
    subject: '[{{zone}}] ESCALATION: {{case_ref}} at {{pct}}% of SLA — due {{due_date}}',
    html: `<p>Case <strong>{{case_ref}}</strong> has reached {{pct}}% of its response deadline and is being escalated.</p>
<ul>
<li>Zone: {{zone}}</li>
<li>Request type: {{request_type}}</li>
<li>Assigned to: {{assignee}}</li>
<li>Current status: {{status}}</li>
<li>Response due: {{due_date}}</li>
</ul>
<p><a href="{{case_url}}">Open the case</a></p>
<p>This message was sent to the escalation contact configured for {{zone}}.</p>`,
  },
  'case-unassigned': {
    subject: '[{{zone}}] ESCALATION: {{case_ref}} unassigned for {{waiting}}',
    html: `<p>Case <strong>{{case_ref}}</strong> has been waiting <strong>{{waiting}}</strong> without an assignee.</p>
<ul>
<li>Zone: {{zone}}</li>
<li>Request type: {{request_type}}</li>
<li>Submitted: {{submission_date}}</li>
<li>Response due: {{due_date}}</li>
</ul>
<p><a href="{{case_url}}">Open the case and assign it</a></p>
<p>Automatic assignment either found no available agent or is set to manual for this zone.</p>`,
  },
  'test-email': {
    subject: 'DSR portal — test email',
    html: `<p>This is a test email from the DSR portal.</p><p>Active provider: <strong>{{provider}}</strong>. Sent at {{sent_at}}.</p>`,
  },
  'delegation-invite': {
    subject: 'Help needed on privacy request {{case_ref}}',
    html: `<p>{{from_name}} has asked for your help with privacy request
<strong>{{case_ref}}</strong>, which is due by {{due_date}}.</p>
<blockquote>{{note}}</blockquote>
<p><a href="{{link}}">Open the request</a> to accept it and send documents back.</p>
<p>This link does not show the requester's personal details. If you need them,
reply to this email and ask.</p>`,
  },
};

/**
 * Admin overrides, refreshed from the database by SystemTemplateService.
 * Empty until that service loads, so the built-ins apply during boot.
 */
let overrides: Record<string, EmailTemplate> = {};

export function setSystemTemplateOverrides(next: Record<string, EmailTemplate>): void {
  overrides = next;
}

/** The built-in text, for showing an editor what they are changing from. */
export function defaultTemplate(templateId: string): EmailTemplate | undefined {
  return DEFAULTS[templateId];
}

export function systemTemplateIds(): string[] {
  return Object.keys(DEFAULTS);
}

/**
 * Check an override before it is stored. Returns the offending variables so the
 * message can name them.
 */
export function unknownVariables(templateId: string, ...sources: string[]): string[] {
  const allowed = new Set(TEMPLATE_VARIABLES[templateId] ?? []);
  const found = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!allowed.has(m[1])) found.add(m[1]);
    }
  }
  return [...found];
}

export function renderTemplate(
  templateId: string,
  variables: Record<string, string>,
  language?: string,
): EmailTemplate {
  // Order: an admin's override for this language, then the shipped translation,
  // then the English override, then the English built-in. Each step is a
  // fallback, so a partial translation still sends something sensible.
  const lang = (language ?? 'en').slice(0, 2).toLowerCase();
  const tpl =
    (lang !== 'en' ? overrides[`${templateId}:${lang}`] : undefined) ??
    (lang !== 'en' ? translationFor(templateId, lang) : undefined) ??
    overrides[templateId] ??
    DEFAULTS[templateId];
  if (!tpl) throw new Error(`Unknown email template: ${templateId}`);
  const render = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const v = variables[name];
      if (v === undefined) {
        throw new Error(`Template ${templateId}: missing variable ${name}`);
      }
      return escapeHtml(v);
    });
  // Subject is plain text; strip any HTML-escaping there.
  return { subject: renderPlain(tpl.subject, variables), html: render(tpl.html) };
}

function renderPlain(s: string, variables: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = variables[name];
    if (v === undefined) throw new Error(`missing variable ${name}`);
    return v;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
