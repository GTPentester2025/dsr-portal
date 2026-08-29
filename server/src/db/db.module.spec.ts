import { Logger } from '@nestjs/common';
import { DbService } from './db.module';

/**
 * The pool bounds have to survive a malformed env value.
 *
 * ConfigService.get(key, default) returns the default only when the key is
 * undefined, so a key that is present but empty gives '' and a typo gives NaN.
 * pg-pool reads both idleTimeoutMillis and connectionTimeoutMillis with a
 * falsiness check, so 0 and NaN both disable the timeout entirely -- silently,
 * on a clean boot. These lock the guard that turns such a value back into the
 * default.
 *
 * Constructing DbService directly, as email.module.spec.ts does with
 * EmailDispatcher. new Pool() does not connect, so nothing here touches a
 * database.
 */
const config = (env: Record<string, string>) =>
  ({
    get: (k: string, fallback?: string) => (k in env ? env[k] : fallback),
  }) as never;

const optionsFor = (env: Record<string, string>) => new DbService(config(env)).pool.options;

describe('DbService pool bounds', () => {
  beforeAll(() => {
    // The constructor reports the effective values at boot; that line is the
    // point of the change, but it is noise in a test run.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('applies the defaults when nothing is configured', () => {
    const o = optionsFor({});
    expect(o.max).toBe(10);
    expect(o.idleTimeoutMillis).toBe(30_000);
    expect(o.connectionTimeoutMillis).toBe(5_000);
  });

  it('takes a well-formed override', () => {
    const o = optionsFor({
      DB_POOL_MAX: '25',
      DB_IDLE_TIMEOUT_MS: '60000',
      DB_CONNECT_TIMEOUT_MS: '2000',
    });
    expect(o.max).toBe(25);
    expect(o.idleTimeoutMillis).toBe(60_000);
    expect(o.connectionTimeoutMillis).toBe(2_000);
  });

  // '' and ' ' are Number 0; '5s', '30_000' and 'NaN' are NaN; '0' and '-1'
  // are a timeout nobody could have meant. Every one of them would leave the
  // pool unbounded if it reached pg-pool.
  it.each(['', ' ', '5s', '30_000', 'NaN', '0', '-1'])(
    'keeps the defaults rather than unbounding the pool on %p',
    (bad) => {
      const o = optionsFor({
        DB_POOL_MAX: bad,
        DB_IDLE_TIMEOUT_MS: bad,
        DB_CONNECT_TIMEOUT_MS: bad,
      });
      expect(o.max).toBe(10);
      expect(o.idleTimeoutMillis).toBe(30_000);
      expect(o.connectionTimeoutMillis).toBe(5_000);
    },
  );

  it('rejects a value that is not finite', () => {
    const o = optionsFor({ DB_CONNECT_TIMEOUT_MS: 'Infinity' });
    expect(o.connectionTimeoutMillis).toBe(5_000);
  });
});
