/**
 * Boot-time check on the mail configuration.
 *
 * A missing Graph credential used to surface as a silently dropped email to a
 * data subject waiting on a verification link. Failing here instead means
 * systemd reports a service that refused to start and `journalctl` names the
 * key, seconds after a bad deploy rather than hours later.
 *
 * Pure over an injected reader so it can be tested without a Nest context and
 * reused by scripts/verify-email.mjs.
 */

export const REQUIRED_GRAPH_KEYS = [
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'PRIVACY_MAILBOX',
] as const;

export const ENV_FILE = '/opt/dsr/server/.env';

export function missingEmailKeys(read: (key: string) => string | undefined): string[] {
  const provider = read('EMAIL_PROVIDER') || 'graph';
  if (provider !== 'graph') return [];
  return REQUIRED_GRAPH_KEYS.filter((key) => {
    const v = read(key);
    return v === undefined || v.trim() === '';
  });
}

export function assertEmailConfig(
  read: (key: string) => string | undefined,
  log: { error: (message: string) => void },
): void {
  const missing = missingEmailKeys(read);
  if (missing.length === 0) return;
  log.error(
    `Email is set to Microsoft Graph but ${missing.length} required ` +
      `setting${missing.length === 1 ? ' is' : 's are'} empty:`,
  );
  for (const key of missing) log.error(`  ${key}`);
  log.error(`Set them in ${ENV_FILE}, then restart the service.`);
  throw new Error(`Incomplete email configuration: ${missing.join(', ')}`);
}
