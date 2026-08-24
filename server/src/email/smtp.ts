import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { connect as tlsConnect } from 'node:tls';
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS upgrade (587/25). */
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Hosts commonly block outbound SMTP, and a socket that never connects would
 * otherwise hang the request until nginx gives up. Every stage is bounded.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 8_000,
  greetingTimeout: 8_000,
  socketTimeout: 20_000,
};

export function createSmtpTransport(cfg: SmtpConfig): Transporter {
  // `family` reaches net.connect at runtime but is missing from the published
  // types, so widen the option object rather than lose the rest of the typing.
  const options: SMTPTransport.Options & { family?: number } = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // Many cloud hosts publish an AAAA record but have no working IPv6 route,
    // which surfaces as ENETUNREACH; pin the lookup to IPv4.
    family: 4,
    ...SMTP_TIMEOUTS,
  };
  return nodemailer.createTransport(options);
}

export interface DiagnosticStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Operator-facing next action when the step fails. */
  hint?: string;
  ms: number;
}

function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; ms: number }> {
  const started = Date.now();
  return fn()
    .then((value) => ({ value, ms: Date.now() - started }))
    .catch((error: Error) => ({ error, ms: Date.now() - started }));
}

/** Open a plain TCP socket with a hard deadline. */
function tcpProbe(host: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const done = (err?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done());
    socket.once('timeout', () => done(new Error(`no response within ${timeout / 1000}s`)));
    socket.once('error', (e) => done(e));
    socket.connect({ host, port, family: 4 });
  });
}

/** Read the SMTP greeting on an implicit-TLS port. */
function tlsProbe(host: string, port: number, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, timeout }, () => {
      socket.once('data', (buf) => {
        const line = buf.toString().trim();
        socket.destroy();
        resolve(line);
      });
    });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeout / 1000}s`));
    });
    socket.once('error', (e) => {
      socket.destroy();
      reject(e);
    });
  });
}

function explain(err: Error, host: string, port: number): string {
  const msg = err.message || String(err);
  if (/ENETUNREACH/i.test(msg)) {
    return `No route to ${host} (usually an IPv6 address on a host without IPv6). The portal already forces IPv4, so this points at a broken network route.`;
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) {
    return `Nothing answered on port ${port}. Cloud providers including DigitalOcean, AWS, Azure, Google Cloud and Oracle block outbound SMTP by default. Ask your provider to unblock ports 465 and 587, or switch to a provider that sends over HTTPS.`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${host} actively refused port ${port}. Check the host and port are right.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `The hostname ${host} could not be resolved. Check the spelling and the server's DNS.`;
  }
  if (/Invalid login|535|BadCredentials|Username and Password not accepted/i.test(msg)) {
    return 'The server rejected the credentials. For Gmail you must use a 16-character App password, not the account password, with 2-Step Verification switched on.';
  }
  if (/self.signed|unable to verify|CERT/i.test(msg)) {
    return 'The TLS certificate could not be verified. Check the host name matches the certificate, or that the port matches the encryption mode.';
  }
  return msg;
}

/**
 * Stage-by-stage SMTP check: DNS, TCP reachability, TLS greeting, then a real
 * authentication attempt. Each stage reports separately so the failing layer
 * is obvious instead of arriving as one opaque timeout.
 */
export async function diagnoseSmtp(cfg: SmtpConfig): Promise<DiagnosticStep[]> {
  const steps: DiagnosticStep[] = [];

  // 1. DNS
  const dns = await timed(() => lookup(cfg.host, { family: 4 }));
  steps.push({
    step: 'DNS lookup',
    ok: !dns.error,
    detail: dns.error
      ? explain(dns.error, cfg.host, cfg.port)
      : `${cfg.host} resolves to ${dns.value?.address}`,
    hint: dns.error ? 'Check the SMTP host name.' : undefined,
    ms: dns.ms,
  });
  if (dns.error) return steps;

  // 2. TCP reachability — where a blocked provider shows up
  const tcp = await timed(() => tcpProbe(cfg.host, cfg.port, SMTP_TIMEOUTS.connectionTimeout));
  steps.push({
    step: `TCP connect to port ${cfg.port}`,
    ok: !tcp.error,
    detail: tcp.error
      ? explain(tcp.error, cfg.host, cfg.port)
      : `Port ${cfg.port} is reachable`,
    hint: tcp.error
      ? 'Try port 587 as well. If every SMTP port times out, outbound SMTP is blocked by your hosting provider.'
      : undefined,
    ms: tcp.ms,
  });
  if (tcp.error) return steps;

  // 3. TLS greeting (implicit TLS ports only)
  if (cfg.secure) {
    const tls = await timed(() => tlsProbe(cfg.host, cfg.port, SMTP_TIMEOUTS.greetingTimeout));
    steps.push({
      step: 'TLS handshake',
      ok: !tls.error,
      detail: tls.error ? explain(tls.error, cfg.host, cfg.port) : (tls.value ?? 'connected'),
      hint: tls.error ? 'Port 465 expects implicit TLS; 587 and 25 expect STARTTLS.' : undefined,
      ms: tls.ms,
    });
    if (tls.error) return steps;
  }

  // 4. Authentication
  if (!cfg.user || !cfg.pass) {
    steps.push({
      step: 'Authentication',
      ok: false,
      detail: 'No username or password configured.',
      hint: 'Fill in the account and password fields, save, then run the check again.',
      ms: 0,
    });
    return steps;
  }

  const auth = await timed(async () => {
    const transport = createSmtpTransport(cfg);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  });
  steps.push({
    step: 'Authentication',
    ok: !auth.error,
    detail: auth.error
      ? explain(auth.error, cfg.host, cfg.port)
      : `Signed in as ${cfg.user}`,
    hint: auth.error ? 'For Gmail, generate an App password under Security, App passwords.' : undefined,
    ms: auth.ms,
  });

  return steps;
}

/**
 * Reachability probe for providers that send over HTTPS. Mirrors the SMTP
 * report so the Settings screen renders both the same way.
 */
export async function diagnoseHttpsEndpoint(host: string): Promise<DiagnosticStep[]> {
  const steps: DiagnosticStep[] = [];

  const dns = await timed(() => lookup(host, { family: 4 }));
  steps.push({
    step: 'DNS lookup',
    ok: !dns.error,
    detail: dns.error ? explain(dns.error, host, 443) : `${host} resolves to ${dns.value?.address}`,
    hint: dns.error ? "Check the server's DNS configuration." : undefined,
    ms: dns.ms,
  });
  if (dns.error) return steps;

  const tcp = await timed(() => tcpProbe(host, 443, SMTP_TIMEOUTS.connectionTimeout));
  steps.push({
    step: 'HTTPS connect to port 443',
    ok: !tcp.error,
    detail: tcp.error ? explain(tcp.error, host, 443) : `${host} is reachable on 443`,
    hint: tcp.error ? 'Outbound HTTPS is blocked, which would also break the rest of the portal.' : undefined,
    ms: tcp.ms,
  });
  return steps;
}
