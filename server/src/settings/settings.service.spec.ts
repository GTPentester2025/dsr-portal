import { resolveValue } from './settings.service';
import type { SettingDef } from './settings.catalog';

const plain: SettingDef = { key: 'X', label: 'X', group: 'g', type: 'text', default: 'dflt' };
const locked: SettingDef = { ...plain, key: 'Y', envOnly: true };

describe('resolveValue', () => {
  it('prefers the database for an ordinary key', () => {
    expect(resolveValue({ def: plain, dbValue: 'db', envValue: 'env' }))
      .toEqual({ value: 'db', source: 'database' });
  });

  it('ignores a stale database row for an envOnly key', () => {
    expect(resolveValue({ def: locked, dbValue: 'db', envValue: 'env' }))
      .toEqual({ value: 'env', source: 'environment' });
  });

  it('falls back to the catalog default for an envOnly key with no env value', () => {
    expect(resolveValue({ def: locked, dbValue: 'db' }))
      .toEqual({ value: 'dflt', source: 'default' });
  });

  it('treats an empty string as absent', () => {
    expect(resolveValue({ def: plain, dbValue: '', envValue: 'env' }))
      .toEqual({ value: 'env', source: 'environment' });
  });

  it('reports unset when nothing supplies a value', () => {
    const bare: SettingDef = { key: 'Z', label: 'Z', group: 'g', type: 'text' };
    expect(resolveValue({ def: bare })).toEqual({ value: undefined, source: 'unset' });
  });

  it('still resolves when the key is not in the catalog', () => {
    expect(resolveValue({ dbValue: 'db' })).toEqual({ value: 'db', source: 'database' });
  });
});
