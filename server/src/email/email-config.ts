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

/**
 * The providers EmailDispatcher can actually resolve.
 *
 * The same pair is declared in settings.catalog.ts as the EMAIL_PROVIDER
 * dropdown's `options`. The literal is repeated here rather than imported for
 * two reasons: that array's other job is rendering a UI control, and an edit
 * to a label there must not be able to change what the service accepts at
 * boot; and keeping this module free of settings imports is what lets it be
 * tested, and reasoned about, without a Nest context. Adding an adapter means
 * editing both lists and the switch in email.module.ts.
 */
export const EMAIL_PROVIDERS = ['graph', 'console'] as const;

/**
 * The provider the dispatcher will select. Unset and empty fall back to
 * `graph`, matching the catalog default; nothing else is normalised, because
 * `Graph` and `graph ` are what the dispatcher would actually be handed.
 */
export function selectedEmailProvider(read: (key: string) => string | undefined): string {
  const raw = read('EMAIL_PROVIDER');
  return raw === undefined || raw === '' ? 'graph' : raw;
}

/**
 * The offending value when EMAIL_PROVIDER names something no adapter answers
 * to, otherwise null.
 *
 * Deliberately exact: a hand-edited env file yields `Graph`, `graph ` or a
 * leftover `smtp` far more often than it yields a typo nobody would recognise.
 * All three used to pass boot validation with zero required keys and then
 * throw `Unknown email provider` on the first send to a data subject — the
 * failure this module exists to move to startup.
 */
export function unknownEmailProvider(
  read: (key: string) => string | undefined,
): string | null {
  const provider = selectedEmailProvider(read);
  return (EMAIL_PROVIDERS as readonly string[]).includes(provider) ? null : provider;
}

export function missingEmailKeys(read: (key: string) => string | undefined): string[] {
  if (selectedEmailProvider(read) !== 'graph') return [];
  return REQUIRED_GRAPH_KEYS.filter((key) => {
    const v = read(key);
    return v === undefined || v.trim() === '';
  });
}

export function assertEmailConfig(
  read: (key: string) => string | undefined,
  log: { error: (message: string) => void },
): void {
  // Checked before the key sweep and reported on its own: an unrecognised
  // provider needs no Graph credentials, so listing missing keys would send
  // the operator to the wrong four lines of the file.
  const unknown = unknownEmailProvider(read);
  if (unknown !== null) {
    log.error(
      `EMAIL_PROVIDER is ${JSON.stringify(unknown)}, which is not an email ` +
        `provider this service has. Valid values are ` +
        `${EMAIL_PROVIDERS.join(' and ')} — exact, lower case, no surrounding spaces.`,
    );
    log.error(`Correct it in ${ENV_FILE}, then restart the service.`);
    throw new Error(`Unknown email provider: ${unknown}`);
  }

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
