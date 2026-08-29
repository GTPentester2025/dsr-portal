import { REQUIRED_GRAPH_KEYS, missingEmailKeys, assertEmailConfig } from './email-config';

const full: Record<string, string> = {
  EMAIL_PROVIDER: 'graph',
  GRAPH_TENANT_ID: 't',
  GRAPH_CLIENT_ID: 'c',
  GRAPH_CLIENT_SECRET: 's',
  PRIVACY_MAILBOX: 'privacy@company.com',
};
const reader = (o: Record<string, string>) => (k: string) => o[k];

describe('missingEmailKeys', () => {
  it('passes a complete graph configuration', () => {
    expect(missingEmailKeys(reader(full))).toEqual([]);
  });

  it.each(REQUIRED_GRAPH_KEYS)('reports %s when it is absent', (key) => {
    const partial = { ...full };
    delete partial[key];
    expect(missingEmailKeys(reader(partial))).toEqual([key]);
  });

  it.each(REQUIRED_GRAPH_KEYS)('treats %s set to an empty string as missing', (key) => {
    expect(missingEmailKeys(reader({ ...full, [key]: '' }))).toEqual([key]);
  });

  it('reports every missing key at once, not just the first', () => {
    expect(missingEmailKeys(reader({ EMAIL_PROVIDER: 'graph' }))).toEqual([...REQUIRED_GRAPH_KEYS]);
  });

  it('requires nothing of the console adapter', () => {
    expect(missingEmailKeys(reader({ EMAIL_PROVIDER: 'console' }))).toEqual([]);
  });

  it('defaults to graph when EMAIL_PROVIDER is unset', () => {
    expect(missingEmailKeys(reader({}))).toEqual([...REQUIRED_GRAPH_KEYS]);
  });
});

describe('assertEmailConfig', () => {
  it('says nothing when the configuration is complete', () => {
    const log = { error: jest.fn() };
    expect(() => assertEmailConfig(reader(full), log)).not.toThrow();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('names every missing key and the file to fix', () => {
    const log = { error: jest.fn() };
    expect(() => assertEmailConfig(reader({ EMAIL_PROVIDER: 'graph' }), log)).toThrow();
    const output = log.error.mock.calls.flat().join('\n');
    for (const key of REQUIRED_GRAPH_KEYS) expect(output).toContain(key);
    expect(output).toContain('/opt/dsr/server/.env');
  });
});
