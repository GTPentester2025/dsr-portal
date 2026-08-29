import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type Role } from './permissions';

const ROLES: Role[] = ['super_admin', 'admin', 'zone_manager', 'approver', 'auditor'];

describe('ROLE_PERMISSIONS', () => {
  it('grants every role only permissions that exist', () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  it('keeps the auditor read-only', () => {
    expect(ROLE_PERMISSIONS.auditor).toEqual(['audit.read']);
  });

  it('gives the approver case work and nothing else', () => {
    expect(ROLE_PERMISSIONS.approver).toEqual(['cases.work']);
  });

  it('reserves instance administration for the super admin', () => {
    for (const role of ROLES) {
      expect(hasPermission(role, 'instance.administer')).toBe(role === 'super_admin');
    }
  });

  it('gives the super admin everything', () => {
    for (const p of PERMISSIONS) expect(hasPermission('super_admin', p)).toBe(true);
  });

  it('withholds system.operate from the zone manager', () => {
    expect(hasPermission('zone_manager', 'system.operate')).toBe(false);
    expect(hasPermission('admin', 'system.operate')).toBe(true);
  });

  it('lets the auditor read the audit log but not work cases', () => {
    expect(hasPermission('auditor', 'audit.read')).toBe(true);
    expect(hasPermission('auditor', 'cases.work')).toBe(false);
  });

  it('refuses an unknown role rather than throwing', () => {
    expect(hasPermission('root', 'cases.work')).toBe(false);
    expect(hasPermission('', 'audit.read')).toBe(false);
  });
});
