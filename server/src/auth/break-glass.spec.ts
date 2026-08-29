import { canUsePassword } from './break-glass';
import type { Role } from './permissions';
import { SETTINGS_BY_KEY } from '../settings/settings.catalog';
import { resolveValue } from '../settings/settings.service';

const ROLES: Role[] = ['super_admin', 'admin', 'zone_manager', 'approver', 'auditor'];
const REFUSAL = 'Password sign-in is disabled. Sign in through your organisation instead.';

describe('canUsePassword', () => {
  it('permits every role while SSO is off, break-glass or not', () => {
    for (const role of ROLES) {
      expect(canUsePassword({ role, isBreakGlass: false }, false)).toBeNull();
      expect(canUsePassword({ role, isBreakGlass: true }, false)).toBeNull();
    }
  });

  it('still permits a super admin once SSO is on', () => {
    expect(canUsePassword({ role: 'super_admin', isBreakGlass: false }, true)).toBeNull();
  });

  it('permits any break-glass account once SSO is on', () => {
    for (const role of ROLES) {
      expect(canUsePassword({ role, isBreakGlass: true }, true)).toBeNull();
    }
  });

  it('refuses every other role once SSO is on', () => {
    for (const role of ROLES.filter((r) => r !== 'super_admin')) {
      expect(canUsePassword({ role, isBreakGlass: false }, true)).toBe(REFUSAL);
    }
  });

  it('gives a reason a signed-out operator can act on', () => {
    const reason = canUsePassword({ role: 'approver', isBreakGlass: false }, true);
    expect(reason).toContain('organisation');
    expect(reason).not.toMatch(/break.?glass|super.?admin/i);
  });
});

// canUsePassword takes ssoEnabled as an already-resolved boolean, so it cannot
// itself go wrong. The two things that actually gate dormancy are the catalog
// entry (is SSO_ENABLED really envOnly?) and resolveValue's env-vs-database
// precedence for it — both exercised here, not in the policy function above.
describe('SSO_ENABLED dormancy', () => {
  const def = SETTINGS_BY_KEY['SSO_ENABLED'];

  it('is registered under that exact key and is envOnly', () => {
    expect(def?.envOnly).toBe(true);
  });

  it('cannot be enabled by a database row', () => {
    // A stale or malicious app_settings row must be ignored: envOnly means
    // only the environment (or the catalog default) can supply a value.
    expect(resolveValue({ def, dbValue: 'true' }).value).toBe('false');
  });

  it('does not resolve to the exact string "true" from a case-typo env value', () => {
    // auth.service.ts compares with === 'true'; anything else, including a
    // near-miss like this, must resolve as disabled.
    expect(resolveValue({ def, envValue: 'True' }).value).not.toBe('true');
  });
});
