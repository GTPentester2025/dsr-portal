import { satisfies } from './auth.guard';

describe('role hierarchy', () => {
  it('lets a higher ladder role satisfy a lower requirement', () => {
    expect(satisfies('super_admin', ['admin'])).toBe(true);
    expect(satisfies('admin', ['zone_manager'])).toBe(true);
    expect(satisfies('zone_manager', ['approver'])).toBe(true);
  });

  it('refuses a lower role', () => {
    expect(satisfies('approver', ['zone_manager'])).toBe(false);
    expect(satisfies('zone_manager', ['admin'])).toBe(false);
    expect(satisfies('admin', ['super_admin'])).toBe(false);
  });

  it('keeps auditor read-only and outside the ladder', () => {
    // An auditor route must not admit ladder roles by rank alone...
    expect(satisfies('approver', ['admin', 'auditor'])).toBe(false);
    expect(satisfies('zone_manager', ['admin', 'auditor'])).toBe(false);
    // ...but the auditor itself passes, and admins above the threshold do too.
    expect(satisfies('auditor', ['admin', 'auditor'])).toBe(true);
    expect(satisfies('admin', ['admin', 'auditor'])).toBe(true);
    expect(satisfies('super_admin', ['admin', 'auditor'])).toBe(true);
    // An auditor never inherits write permissions.
    expect(satisfies('auditor', ['approver'])).toBe(false);
    expect(satisfies('auditor', ['admin'])).toBe(false);
  });

  it('locks super-admin-only routes to super admins', () => {
    expect(satisfies('super_admin', ['super_admin'])).toBe(true);
    for (const r of ['admin', 'zone_manager', 'approver', 'auditor']) {
      expect(satisfies(r, ['super_admin'])).toBe(false);
    }
  });

  it('admits every ladder role when the lowest is required', () => {
    for (const r of ['approver', 'zone_manager', 'admin', 'super_admin']) {
      expect(satisfies(r, ['admin', 'zone_manager', 'approver'])).toBe(true);
    }
    expect(satisfies('auditor', ['admin', 'zone_manager', 'approver'])).toBe(false);
  });
});
