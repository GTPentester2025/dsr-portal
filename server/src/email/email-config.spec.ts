import {
  EMAIL_PROVIDERS,
  REQUIRED_GRAPH_KEYS,
  assertEmailConfig,
  missingEmailKeys,
  unknownEmailProvider,
} from './email-config';

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

describe('unknownEmailProvider', () => {
  it.each([...EMAIL_PROVIDERS])('accepts %s', (provider) => {
    expect(unknownEmailProvider(reader({ EMAIL_PROVIDER: provider }))).toBeNull();
  });

  it('accepts an unset provider, which means the graph default', () => {
    expect(unknownEmailProvider(reader({}))).toBeNull();
    expect(unknownEmailProvider(reader({ EMAIL_PROVIDER: '' }))).toBeNull();
  });

  // The shapes a hand-edited env file actually produces. Every one of these
  // used to pass boot validation and then throw on the first send.
  it.each([
    ['wrong case', 'Graph'],
    ['a trailing space', 'graph '],
    ['a leading space', ' graph'],
    ['whitespace only', '   '],
    ['a provider removed from this branch', 'smtp'],
    ['a typo', 'grahp'],
  ])('rejects %s', (_label, value) => {
    expect(unknownEmailProvider(reader({ EMAIL_PROVIDER: value }))).toBe(value);
  });
});

describe('assertEmailConfig on an unrecognised provider', () => {
  const badGraph = { EMAIL_PROVIDER: 'Graph' };

  it('refuses to boot even though no Graph key is required', () => {
    expect(missingEmailKeys(reader(badGraph))).toEqual([]);
    expect(() => assertEmailConfig(reader(badGraph), { error: jest.fn() })).toThrow(
      /Unknown email provider: Graph/,
    );
  });

  it('reports the bad value and the legal ones, not a list of missing keys', () => {
    const log = { error: jest.fn() };
    expect(() => assertEmailConfig(reader(badGraph), log)).toThrow();
    const output = log.error.mock.calls.flat().join('\n');
    expect(output).toContain('"Graph"');
    for (const provider of EMAIL_PROVIDERS) expect(output).toContain(provider);
    expect(output).toContain('/opt/dsr/server/.env');
    for (const key of REQUIRED_GRAPH_KEYS) expect(output).not.toContain(key);
  });

  it('quotes the value so a trailing space is visible', () => {
    const log = { error: jest.fn() };
    expect(() =>
      assertEmailConfig(reader({ ...full, EMAIL_PROVIDER: 'graph ' }), log),
    ).toThrow();
    expect(log.error.mock.calls.flat().join('\n')).toContain('"graph "');
  });

  it('still passes a complete, correctly spelled configuration', () => {
    expect(() => assertEmailConfig(reader(full), { error: jest.fn() })).not.toThrow();
  });
});
