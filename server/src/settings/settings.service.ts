import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { SETTINGS, SETTINGS_BY_KEY, type SettingDef } from './settings.catalog';

export function resolveValue(args: {
  def?: SettingDef;
  dbValue?: string;
  envValue?: string;
}): { value?: string; source: 'database' | 'environment' | 'default' | 'unset' } {
  const { def, dbValue, envValue } = args;
  if (!def?.envOnly && dbValue !== undefined && dbValue !== '') {
    return { value: dbValue, source: 'database' };
  }
  if (envValue !== undefined && envValue !== '') return { value: envValue, source: 'environment' };
  if (def?.default !== undefined) return { value: def.default, source: 'default' };
  return { value: undefined, source: 'unset' };
}

/**
 * Runtime configuration with a database override layer.
 *
 * Resolution order: `app_settings` row -> process env -> catalog default.
 * The whole table is cached in memory so `get()` stays synchronous and can be
 * a drop-in replacement for `ConfigService.get()` inside the providers.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SettingsService.name);
  private cache = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly env: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    // Re-read periodically so a second instance (or a direct DB edit) is
    // picked up without a restart. Unref'd so it never holds the process open.
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reload the in-memory cache from the database. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.db.system(async (_db, client) => {
        const res = await client.query(
          'SELECT key, value, value_enc, secret FROM app_settings',
        );
        return res.rows as {
          key: string;
          value: string | null;
          value_enc: string | null;
          secret: boolean;
        }[];
      });
      const next = new Map<string, string>();
      for (const row of rows) {
        try {
          const v = row.secret
            ? row.value_enc
              ? this.crypto.decrypt(row.value_enc)
              : ''
            : (row.value ?? '');
          if (v !== '') next.set(row.key, v);
        } catch {
          this.log.warn(`Could not decrypt setting ${row.key}; falling back to env`);
        }
      }
      this.cache = next;
      this.log.log(`Loaded ${next.size} runtime settings from the database`);
    } catch (err) {
      // A missing table on first boot must not stop the app from starting.
      this.log.warn(`Settings not loaded, using environment only: ${(err as Error).message}`);
    }
  }

  /** Synchronous read: database value, then env, then catalog default. */
  get<T = string>(key: string, fallback?: T): T {
    const { value } = resolveValue({
      def: SETTINGS_BY_KEY[key],
      dbValue: this.cache.get(key),
      envValue: this.env.get<string>(key),
    });
    return (value ?? fallback) as T;
  }

  getNumber(key: string, fallback: number): number {
    const raw = this.get<string | undefined>(key, undefined);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** True when the key resolves to a non-empty value from any source. */
  has(key: string): boolean {
    const v = this.get<string | undefined>(key, undefined);
    return v !== undefined && v !== '';
  }

  /**
   * Values for the admin UI. Secrets never leave the server: the client only
   * learns whether one is set, and where the effective value comes from.
   */
  async describeAll(): Promise<
    {
      key: string;
      value: string;
      isSet: boolean;
      source: 'database' | 'environment' | 'default' | 'unset';
      secret: boolean;
    }[]
  > {
    return SETTINGS.map((def) => {
      const inDb = this.cache.get(def.key);
      const inEnv = this.env.get<string>(def.key);
      const { value: effective, source } = resolveValue({
        def,
        dbValue: inDb,
        envValue: inEnv,
      });
      return {
        key: def.key,
        value: def.secret ? '' : (effective ?? ''),
        isSet: Boolean(effective),
        source,
        secret: Boolean(def.secret),
      };
    });
  }

  private validate(def: SettingDef, value: string): void {
    if (value === '') return; // clearing is always allowed
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException(`${def.label} must be a number`);
      if (def.min !== undefined && n < def.min) {
        throw new BadRequestException(`${def.label} must be at least ${def.min}`);
      }
      if (def.max !== undefined && n > def.max) {
        throw new BadRequestException(`${def.label} must be at most ${def.max}`);
      }
    }
    if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      throw new BadRequestException(`${def.label} must be a valid email address`);
    }
    if (def.type === 'url' && !/^https?:\/\/[^\s]+$/.test(value)) {
      throw new BadRequestException(`${def.label} must start with http:// or https://`);
    }
    if (def.type === 'select' && !def.options?.some((o) => o.value === value)) {
      throw new BadRequestException(`${def.label} has an unsupported value`);
    }
  }

  /**
   * Persist a batch of settings. Secret values are encrypted; an empty string
   * clears the stored override so the environment value applies again.
   */
  async updateMany(
    patch: Record<string, string>,
    actorId: string,
    ip?: string,
  ): Promise<{ updated: string[] }> {
    const updated: string[] = [];

    for (const [key, rawValue] of Object.entries(patch)) {
      const def = SETTINGS_BY_KEY[key];
      if (!def) throw new BadRequestException(`Unknown setting: ${key}`);
      if (def.envOnly) {
        throw new BadRequestException(
          `${def.label} is set in /etc/dsr/dsr-api.env and cannot be changed here.`,
        );
      }
      // App passwords are displayed in groups of four; the transport ignores them.
      const value = def.key === 'GMAIL_APP_PASSWORD' ? rawValue.replace(/\s+/g, '') : rawValue.trim();
      this.validate(def, value);

      await this.db.system(async (_db, client) => {
        if (value === '') {
          await client.query('DELETE FROM app_settings WHERE key = $1', [key]);
          return;
        }
        const enc = def.secret ? this.crypto.encrypt(value) : null;
        await client.query(
          `INSERT INTO app_settings (key, value, value_enc, secret, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 value_enc = EXCLUDED.value_enc,
                 secret = EXCLUDED.secret,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
          [key, def.secret ? null : value, enc, Boolean(def.secret), actorId],
        );
      });
      updated.push(key);
    }

    await this.refresh();

    // Secret values must never reach the audit trail; record only the keys.
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'settings.updated',
      entityType: 'settings',
      after: {
        keys: updated,
        values: Object.fromEntries(
          updated.map((k) => [k, SETTINGS_BY_KEY[k]?.secret ? '[redacted]' : patch[k]]),
        ),
      },
      sourceIp: ip,
    });

    return { updated };
  }
}
