import { explainNetError } from './net-diagnostics';

describe('explainNetError', () => {
  it('names DNS failures as DNS failures', () => {
    const out = explainNetError(new Error('getaddrinfo ENOTFOUND graph.microsoft.com'), 'graph.microsoft.com', 443);
    expect(out).toContain('could not be resolved');
    expect(out).toContain('graph.microsoft.com');
  });

  it('describes a timeout as blocked outbound HTTPS, not blocked SMTP', () => {
    const out = explainNetError(new Error('connect ETIMEDOUT'), 'login.microsoftonline.com', 443);
    expect(out).toContain('443');
    expect(out).not.toMatch(/SMTP|465|587/);
  });

  it('explains a refused connection', () => {
    expect(explainNetError(new Error('connect ECONNREFUSED'), 'example.com', 443)).toContain('refused');
  });

  it('explains an unroutable host', () => {
    expect(explainNetError(new Error('connect ENETUNREACH'), 'example.com', 443)).toContain('No route');
  });

  it('explains a certificate failure', () => {
    expect(explainNetError(new Error('unable to verify the first certificate'), 'example.com', 443))
      .toContain('certificate');
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(explainNetError(new Error('something odd'), 'example.com', 443)).toBe('something odd');
  });
});
