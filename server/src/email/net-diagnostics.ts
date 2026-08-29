import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface DiagnosticStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Operator-facing next action when the step fails. */
  hint?: string;
  ms: number;
}

/**
 * A socket that never connects would otherwise hang the request until nginx
 * gives up, so every stage is bounded.
 */
export const NET_TIMEOUTS = {
  connectionTimeout: 8_000,
};

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
    // Many cloud hosts publish an AAAA record but have no working IPv6 route,
    // which surfaces as ENETUNREACH; pin the lookup to IPv4.
    socket.connect({ host, port, family: 4 });
  });
}

export function explainNetError(err: Error, host: string, port: number): string {
  const msg = err.message || String(err);
  if (/ENETUNREACH/i.test(msg)) {
    return `No route to ${host} (usually an IPv6 address on a host without IPv6). The portal already forces IPv4, so this points at a broken network route.`;
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) {
    return `Nothing answered on port ${port}. The portal reaches Microsoft Graph over HTTPS only, so outbound ${port} must be open. Check the host firewall and any egress proxy.`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${host} actively refused port ${port}.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `The hostname ${host} could not be resolved. Check the server's DNS.`;
  }
  if (/self.signed|unable to verify|CERT/i.test(msg)) {
    return 'The TLS certificate could not be verified. An intercepting proxy will cause this; its CA must be in the system trust store.';
  }
  return msg;
}

/**
 * Transport-level reachability for an HTTPS host, reported stage by stage so
 * the failing layer is obvious instead of arriving as one opaque timeout.
 */
export async function diagnoseHttpsEndpoint(host: string): Promise<DiagnosticStep[]> {
  const steps: DiagnosticStep[] = [];

  const dns = await timed(() => lookup(host, { family: 4 }));
  steps.push({
    step: 'DNS lookup',
    ok: !dns.error,
    detail: dns.error
      ? explainNetError(dns.error, host, 443)
      : `${host} resolves to ${dns.value?.address}`,
    hint: dns.error ? "Check the server's DNS configuration." : undefined,
    ms: dns.ms,
  });
  if (dns.error) return steps;

  const tcp = await timed(() => tcpProbe(host, 443, NET_TIMEOUTS.connectionTimeout));
  steps.push({
    step: 'HTTPS connect to port 443',
    ok: !tcp.error,
    detail: tcp.error ? explainNetError(tcp.error, host, 443) : `${host} is reachable on 443`,
    hint: tcp.error
      ? 'Outbound HTTPS is blocked, which would also break the rest of the portal.'
      : undefined,
    ms: tcp.ms,
  });
  return steps;
}
