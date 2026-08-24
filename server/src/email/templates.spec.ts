import { renderTemplate } from './templates';

describe('renderTemplate', () => {
  it('substitutes variables and escapes HTML in body', () => {
    const out = renderTemplate('submission-ack', {
      case_ref: 'DSR-EUR-2026-00001',
      sla_statement: 'We will respond within one month. <script>x</script>',
    });
    expect(out.subject).toBe(
      'Your privacy request DSR-EUR-2026-00001 has been received',
    );
    expect(out.html).toContain('DSR-EUR-2026-00001');
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('throws on unknown template', () => {
    expect(() => renderTemplate('nope', {})).toThrow('Unknown email template');
  });

  it('throws on missing variable rather than sending a raw placeholder', () => {
    expect(() => renderTemplate('verify-email', { ttl_minutes: '15' })).toThrow(
      'missing variable verification_url',
    );
  });

  it('renders the verification email with a URL intact', () => {
    const url = 'https://example.com/verify?token=abc&d=1';
    const out = renderTemplate('verify-email', {
      verification_url: url,
      ttl_minutes: '15',
    });
    expect(out.html).toContain('href="https://example.com/verify?token=abc&amp;d=1"');
  });
});
