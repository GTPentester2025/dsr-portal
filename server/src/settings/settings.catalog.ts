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
  /**
   * Resolved from the environment only. A database row is ignored and the
   * settings API refuses to write one, so the file on the server is the whole
   * truth for this key.
   */
  envOnly?: boolean;
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
    default: 'graph',
    help: 'Set in /etc/dsr/dsr-api.env. Changing it needs a service restart.',
    envOnly: true,
    options: [
      { value: 'graph', label: 'Microsoft Graph (shared mailbox)' },
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
    envOnly: true,
  },
  {
    key: 'PRIVACY_MAILBOX',
    label: 'Privacy mailbox',
    group: 'email',
    type: 'email',
    placeholder: 'privacy@company.com',
    help: 'Address that case responses are sent from. Required for Microsoft Graph.',
    envOnly: true,
  },

  // microsoft graph
  {
    key: 'GRAPH_TENANT_ID',
    label: 'Azure tenant ID',
    group: 'email',
    type: 'text',
    placeholder: '00000000-0000-0000-0000-000000000000',
    envOnly: true,
  },
  {
    key: 'GRAPH_CLIENT_ID',
    label: 'Application (client) ID',
    group: 'email',
    type: 'text',
    envOnly: true,
  },
  {
    key: 'GRAPH_CLIENT_SECRET',
    label: 'Client secret',
    group: 'email',
    type: 'password',
    secret: true,
    help: 'Needs Mail.Send application permission with admin consent, scoped to the privacy mailbox.',
    envOnly: true,
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
