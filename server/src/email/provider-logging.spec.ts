import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every email_log row must name the adapter that actually sent the message.
// A literal here is how the column came to read 'active' for years.
const WRITE_SITES = [
  'public/intake.service.ts',
  'cases/assignment.service.ts',
  'cases/outbound.service.ts',
];

describe('email_log provider column', () => {
  it.each(WRITE_SITES)('%s never hardcodes a provider name', (rel) => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    expect(src).not.toMatch(/provider:\s*'(gmail|graph|active|console|smtp|resend)'/);
  });

  it.each(WRITE_SITES)('%s resolves the provider from the dispatcher', (rel) => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    expect(src).toContain('this.email.activeName()');
  });
});
