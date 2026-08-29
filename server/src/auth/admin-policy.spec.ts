import { canAssignRole } from './admin-policy';

const superAdmin = { role: 'super_admin' as const, zoneId: null };
const admin = { role: 'admin' as const, zoneId: null };
const eurManager = { role: 'zone_manager' as const, zoneId: 'EUR' };

describe('canAssignRole', () => {
  it('lets a super admin grant the super admin role', () => {
    expect(canAssignRole(superAdmin, 'super_admin', null)).toBeNull();
  });

  it('stops an admin granting the super admin role', () => {
    expect(canAssignRole(admin, 'super_admin', null)).toBe(
      'Only a super admin can grant the super admin role',
    );
  });

  it('stops a zone manager granting the super admin role', () => {
    expect(canAssignRole(eurManager, 'super_admin', 'EUR')).toBe(
      'Only a super admin can grant the super admin role',
    );
  });

  it('stops a zone manager creating an admin', () => {
    expect(canAssignRole(eurManager, 'admin', 'EUR')).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('stops a zone manager acting outside their zone', () => {
    expect(canAssignRole(eurManager, 'approver', 'SAZ')).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('stops a zone manager moving a user to a zone they do not manage', () => {
    // The resulting zone is what matters, not only the zone the user came from.
    expect(canAssignRole(eurManager, 'approver', null)).toBe(
      'Zone managers can only manage their own zone',
    );
  });

  it('lets a zone manager manage an approver in their own zone', () => {
    expect(canAssignRole(eurManager, 'approver', 'EUR')).toBeNull();
  });

  it('lets an admin manage any operational role in any zone', () => {
    expect(canAssignRole(admin, 'zone_manager', 'SAZ')).toBeNull();
    expect(canAssignRole(admin, 'auditor', null)).toBeNull();
  });
});
