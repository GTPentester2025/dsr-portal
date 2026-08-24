/**
 * Catalog of every runtime-configurable setting.
 *
 * Single source of truth for what the admin Settings screen renders, how each
 * value is validated, and which values are secrets (stored encrypted, never
 * returned to the browser).
 */

export type SettingType =
  | 'text'
  | 'password'
  | 'email'
  | 'select'
  | 'number'
  | 'boolean'
  | 'url';

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  /** Secrets are envelope-encrypted at rest and masked in API responses. */
  secret?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Render only when every condition holds (logical AND). */
  visibleWhen?: { key: string; equals: string[] }[];
  min?: number;
  max?: number;
  /** Fallback when neither the DB nor the environment provides a value. */
  default?: string;
}

export interface SettingGroup {
  id: string;
  label: string;
  description: string;
  icon: string;
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'email',
    label: 'Email delivery',
    description:
      'How the portal sends verification links, acknowledgements and case responses.',
    icon: 'mail',
  },
  {
    id: 'portal',
    label: 'Portal & URLs',
    description: 'Public addresses used in emails and magic links.',
    icon: 'globe',
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Bot protection, session lifetimes and rate limits.',
    icon: 'shield',
  },
  {
    id: 'branding',
    label: 'Branding',
    description: 'Organisation identity shown to data subjects.',
    icon: 'sparkles',
  },
];

export const SETTINGS: SettingDef[] = [
  // ----------------------------------------------------------------- email --
  {
    key: 'EMAIL_PROVIDER',
    label: 'Active provider',
    group: 'email',
    type: 'select',
    default: 'gmail',
    help: 'Switching providers takes effect immediately, with no redeploy.',
    options: [
      { value: 'gmail', label: 'Gmail (SMTP or API)' },
      { value: 'graph', label: 'Microsoft Graph (shared mailbox)' },
      { value: 'resend', label: 'Resend (HTTPS API - works where SMTP is blocked)' },
      { value: 'smtp', label: 'Custom SMTP server' },
      { value: 'console', label: 'Console (development only, writes to the log)' },
    ],
  },
  {
    key: 'EMAIL_FROM_NAME',
    label: 'From display name',
    group: 'email',
    type: 'text',
    default: 'Privacy Team',
    placeholder: 'Privacy Team',
  },
  {
    key: 'PRIVACY_MAILBOX',
    label: 'Privacy mailbox',
    group: 'email',
    type: 'email',
    placeholder: 'privacy@company.com',
    help: 'Address that case responses are sent from. Required for Microsoft Graph.',
  },

  // gmail
  {
    key: 'GMAIL_AUTH',
    label: 'Gmail authentication',
    group: 'email',
    type: 'select',
    default: 'app-password',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['gmail'] }],
    options: [
      { value: 'app-password', label: 'App password (SMTP)' },
      { value: 'oauth2', label: 'OAuth2 (Gmail API)' },
    ],
  },
  {
    key: 'GMAIL_USER',
    label: 'Gmail account',
    group: 'email',
    type: 'email',
    placeholder: 'you@company.com',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['gmail'] }],
  },
  {
    key: 'GMAIL_APP_PASSWORD',
    label: 'Gmail app password',
    group: 'email',
    type: 'password',
    secret: true,
    placeholder: 'xxxx xxxx xxxx xxxx',
    help: 'Google Account, Security, 2-Step Verification, App passwords. Spaces are ignored.',
    visibleWhen: [
      { key: 'EMAIL_PROVIDER', equals: ['gmail'] },
      { key: 'GMAIL_AUTH', equals: ['app-password'] },
    ],
  },
  {
    key: 'GMAIL_OAUTH_CLIENT_ID',
    label: 'OAuth client ID',
    group: 'email',
    type: 'text',
    visibleWhen: [
      { key: 'EMAIL_PROVIDER', equals: ['gmail'] },
      { key: 'GMAIL_AUTH', equals: ['oauth2'] },
    ],
  },
  {
    key: 'GMAIL_OAUTH_CLIENT_SECRET',
    label: 'OAuth client secret',
    group: 'email',
    type: 'password',
    secret: true,
    visibleWhen: [
      { key: 'EMAIL_PROVIDER', equals: ['gmail'] },
      { key: 'GMAIL_AUTH', equals: ['oauth2'] },
    ],
  },
  {
    key: 'GMAIL_OAUTH_REFRESH_TOKEN',
    label: 'OAuth refresh token',
    group: 'email',
    type: 'password',
    secret: true,
    visibleWhen: [
      { key: 'EMAIL_PROVIDER', equals: ['gmail'] },
      { key: 'GMAIL_AUTH', equals: ['oauth2'] },
    ],
  },

  {
    key: 'GMAIL_SMTP_PORT',
    label: 'Gmail SMTP port',
    group: 'email',
    type: 'select',
    default: '465',
    help: 'This host blocks 25, 465 and 587, and Gmail offers no other port, so app-password sending cannot work here. Use OAuth2 instead, which sends over HTTPS.',
    visibleWhen: [
      { key: 'EMAIL_PROVIDER', equals: ['gmail'] },
      { key: 'GMAIL_AUTH', equals: ['app-password'] },
    ],
    options: [
      { value: '465', label: '465 - implicit TLS' },
      { value: '587', label: '587 - STARTTLS' },
    ],
  },

  // resend (https)
  {
    key: 'RESEND_API_KEY',
    label: 'Resend API key',
    group: 'email',
    type: 'password',
    secret: true,
    placeholder: 're_xxxxxxxxxxxxxxxx',
    help: 'From resend.com, API Keys. Sends over HTTPS, so it works on hosts that block SMTP. The privacy mailbox above must be on a domain you have verified in Resend.',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['resend'] }],
  },

  // generic smtp
  {
    key: 'SMTP_HOST',
    label: 'SMTP host',
    group: 'email',
    type: 'text',
    placeholder: 'smtp.office365.com',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['smtp'] }],
  },
  {
    key: 'SMTP_PORT',
    label: 'SMTP port',
    group: 'email',
    type: 'number',
    default: '587',
    min: 1,
    max: 65535,
    help: 'Common values: 587 with STARTTLS, 465 with implicit TLS. Many hosts block those but leave 2525 open, which SendGrid, Brevo and Mailgun all accept.',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['smtp'] }],
  },
  {
    key: 'SMTP_SECURE',
    label: 'Encryption',
    group: 'email',
    type: 'select',
    default: 'false',
    help: 'Implicit TLS wraps the whole connection (port 465). STARTTLS upgrades an open connection (ports 587 and 25).',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['smtp'] }],
    options: [
      { value: 'false', label: 'STARTTLS' },
      { value: 'true', label: 'Implicit TLS' },
    ],
  },
  {
    key: 'SMTP_USER',
    label: 'SMTP username',
    group: 'email',
    type: 'text',
    placeholder: 'privacy@company.com',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['smtp'] }],
  },
  {
    key: 'SMTP_PASSWORD',
    label: 'SMTP password',
    group: 'email',
    type: 'password',
    secret: true,
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['smtp'] }],
  },

  // microsoft graph
  {
    key: 'GRAPH_TENANT_ID',
    label: 'Azure tenant ID',
    group: 'email',
    type: 'text',
    placeholder: '00000000-0000-0000-0000-000000000000',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['graph'] }],
  },
  {
    key: 'GRAPH_CLIENT_ID',
    label: 'Application (client) ID',
    group: 'email',
    type: 'text',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['graph'] }],
  },
  {
    key: 'GRAPH_CLIENT_SECRET',
    label: 'Client secret',
    group: 'email',
    type: 'password',
    secret: true,
    help: 'Needs Mail.Send application permission with admin consent, scoped to the privacy mailbox.',
    visibleWhen: [{ key: 'EMAIL_PROVIDER', equals: ['graph'] }],
  },

  // ---------------------------------------------------------------- portal --
  {
    key: 'PUBLIC_BASE_URL',
    label: 'Public portal URL',
    group: 'portal',
    type: 'url',
    placeholder: 'https://privacy.company.com',
    help: 'Base address used to build email-verification magic links.',
  },
  {
    key: 'INTERNAL_BASE_URL',
    label: 'Internal portal URL',
    group: 'portal',
    type: 'url',
    placeholder: 'https://privacy.company.com/admin',
    help: 'Used for the deep link in case-assignment notifications.',
  },

  // -------------------------------------------------------------- security --
  {
    key: 'TURNSTILE_SITE_KEY',
    label: 'Turnstile site key',
    group: 'security',
    type: 'text',
    help: 'Cloudflare Turnstile CAPTCHA on the public form. Leave both fields blank to disable.',
  },
  {
    key: 'TURNSTILE_SECRET',
    label: 'Turnstile secret key',
    group: 'security',
    type: 'password',
    secret: true,
  },
  {
    key: 'SESSION_IDLE_MINUTES',
    label: 'Session idle timeout',
    group: 'security',
    type: 'number',
    default: '30',
    min: 5,
    max: 480,
    help: 'Minutes of inactivity before an internal user is signed out.',
  },
  {
    key: 'SESSION_ABSOLUTE_HOURS',
    label: 'Absolute session lifetime',
    group: 'security',
    type: 'number',
    default: '8',
    min: 1,
    max: 72,
    help: 'Hours before a session expires regardless of activity.',
  },
  {
    key: 'LOGIN_RATE_LIMIT',
    label: 'Failed sign-ins per IP each hour',
    group: 'security',
    type: 'number',
    default: '10',
    min: 3,
    max: 100,
  },
  {
    key: 'VERIFY_EMAIL_RATE_LIMIT',
    label: 'Verification emails per address each hour',
    group: 'security',
    type: 'number',
    default: '3',
    min: 1,
    max: 20,
    help: 'Once an address hits this, further attempts are accepted but no email is sent — requesters are never told they are limited. Raise it while testing; the server log names the limit each time one is hit.',
  },
  {
    key: 'VERIFY_IP_RATE_LIMIT',
    label: 'Verification emails per IP each hour',
    group: 'security',
    type: 'number',
    default: '10',
    min: 1,
    max: 100,
    help: 'Counts every address tried from one network. Testing repeatedly from the office will reach this before real requesters ever do.',
  },

  {
    key: 'DAILY_REPORT_ENABLED',
    label: 'Send the daily report',
    group: 'security',
    type: 'select',
    default: 'true',
    options: [
      { value: 'true', label: 'Enabled' },
      { value: 'false', label: 'Disabled' },
    ],
    help:
      "Emails each zone manager their zone's figures at 07:00 UTC, with the executive PDF attached. Administrators receive an all-zones copy.",
  },

  // -------------------------------------------------------------- branding --
  {
    key: 'ORG_NAME',
    label: 'Organisation name',
    group: 'branding',
    type: 'text',
    default: 'ABInBev',
    help: 'Shown in acknowledgement emails and the portal header.',
  },
  {
    key: 'SUPPORT_EMAIL',
    label: 'Reply-to address',
    group: 'branding',
    type: 'email',
    placeholder: 'privacy@company.com',
    help: 'Where requesters reach a human if they reply to an automated email.',
  },
];

export const SETTINGS_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS.map((s) => [s.key, s]),
);
