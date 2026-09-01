import { EmailDispatcher } from './email.module';

const stub = (name: string) => ({ activeName: () => name }) as never;
/**
 * These cases only exercise adapter resolution, which happens before the send
 * guard is consulted, so it is a stub that would fail loudly if reached.
 */
const guardStub = {
  scopesFor: () => [],
  blockedScope: () => Promise.resolve(null),
  recordFailure: () => Promise.resolve(null),
  recordSuccess: () => Promise.resolve(),
  recordUndelivered: () => Promise.resolve(),
} as never;
const dispatcherFor = (provider?: string) =>
  new EmailDispatcher(
    { get: (_k: string, fallback?: string) => provider ?? fallback } as never,
    stub('graph'),
    stub('console'),
    guardStub,
  );

describe('EmailDispatcher', () => {
  it('defaults to graph when nothing is configured', () => {
    expect(dispatcherFor(undefined).activeName()).toBe('graph');
  });

  it('resolves graph', () => {
    expect(dispatcherFor('graph').activeName()).toBe('graph');
  });

  it('resolves console', () => {
    expect(dispatcherFor('console').activeName()).toBe('console');
  });

  it('names the offending value when the provider is unknown', async () => {
    await expect(dispatcherFor('smtp').verifyConnection()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('smtp'),
    });
  });

  it('has nothing to diagnose for the console adapter', async () => {
    await expect(dispatcherFor('console').diagnose()).resolves.toBeNull();
  });
});
