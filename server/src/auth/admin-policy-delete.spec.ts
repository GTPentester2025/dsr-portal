import { canDeleteUser } from './admin-policy';
import { ROLE_PERMISSIONS, hasPermission } from './permissions';

/**
 * Deleting an account is irreversible and the rules around it are the kind
 * that get relaxed by accident, so they are pinned here rather than left to
 * the controller that calls them.
 */
describe('canDeleteUser', () => {
  const superAdmin = { role: 'super_admin' as const, zoneId: null };
  const admin = { role: 'admin' as const, zoneId: null };
  const zoneManager = { role: 'zone_manager' as const, zoneId: 'SAZ' };

  it('lets a super admin delete anyone', () => {
    expect(canDeleteUser(superAdmin, { role: 'super_admin', zoneId: null })).toBeNull();
    expect(canDeleteUser(superAdmin, { role: 'admin', zoneId: null })).toBeNull();
    expect(canDeleteUser(superAdmin, { role: 'approver', zoneId: 'SAZ' })).toBeNull();
  });

  it('refuses an admin deleting a super admin', () => {
    // Only a super admin may grant that role, so only a super admin may take
    // it away — otherwise an admin can clear out everyone above them.
    expect(canDeleteUser(admin, { role: 'super_admin', zoneId: null }))
      .toMatch(/only a super admin/i);
  });

  it('lets an admin delete every role below super admin', () => {
    for (const role of ['admin', 'zone_manager', 'approver', 'auditor'] as const) {
      expect(canDeleteUser(admin, { role, zoneId: 'SAZ' })).toBeNull();
    }
  });

  it('holds a zone manager to their own zone', () => {
    expect(canDeleteUser(zoneManager, { role: 'approver', zoneId: 'SAZ' })).toBeNull();
    expect(canDeleteUser(zoneManager, { role: 'approver', zoneId: 'EUR' }))
      .toMatch(/own zone/i);
  });

  it('refuses a zone manager a zone-wide role even inside their own zone', () => {
    // An auditor filed under SAZ still reads every zone, so deleting one is
    // not a local act.
    expect(canDeleteUser(zoneManager, { role: 'auditor', zoneId: 'SAZ' }))
      .toMatch(/own zone/i);
  });
});

describe('the destructive permissions', () => {
  it('gives an admin the user powers but not the instance ones', () => {
    // The split exists so that trusting somebody to remove a departed
    // colleague does not also hand them the mail provider's credentials.
    expect(hasPermission('admin', 'users.administer')).toBe(true);
    expect(hasPermission('admin', 'schema.migrate')).toBe(true);
    expect(hasPermission('admin', 'instance.administer')).toBe(false);
  });

  it('keeps both away from everyone below admin', () => {
    for (const role of ['zone_manager', 'approver', 'auditor'] as const) {
      expect(hasPermission(role, 'users.administer')).toBe(false);
      expect(hasPermission(role, 'schema.migrate')).toBe(false);
    }
  });

  it('leaves a super admin holding everything', () => {
    expect(ROLE_PERMISSIONS.super_admin).toEqual(
      expect.arrayContaining(['users.administer', 'schema.migrate', 'instance.administer']),
    );
  });
});
