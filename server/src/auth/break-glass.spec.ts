import { canUsePassword } from './break-glass';
import type { Role } from './permissions';

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
