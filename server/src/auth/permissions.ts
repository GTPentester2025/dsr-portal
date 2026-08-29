/**
 * Who may do what, as a table rather than an algorithm.
 *
 * This replaces a privilege ladder that ranked the operational roles and then
 * needed an explicit carve-out to stop `auditor` — a deliberately read-only
 * lane — inheriting write access by rank. Explicit grants make that carve-out
 * unnecessary: a role holds exactly what is listed here.
 *
 * Permissions are grouped by the decision an operator actually makes, not by
 * route. `config.manage` covers forms, SLA policies and response templates
 * together because the same two roles hold all three; splitting them would be
 * three names for one grant.
 */

export type Role = 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor';

export const PERMISSIONS = [
  /** Work a case: status, assignment, SLA clock, correspondence, attachments. */
  'cases.work',
  /** Administer people: users, assignment configuration, team exports. */
  'team.manage',
  /** Configure the portal: forms, SLA policies, response templates. */
  'config.manage',
  /** Run and read management reports. */
  'reports.run',
  /** Read the audit log and export it. */
  'audit.read',
  /** Instance-wide operations: SLA recompute, report send, system templates. */
  'system.operate',
  /** Change instance configuration and reset another user's password. */
  'instance.administer',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: [
    'cases.work',
    'team.manage',
    'config.manage',
    'reports.run',
    'audit.read',
    'system.operate',
    'instance.administer',
  ],
  admin: ['cases.work', 'team.manage', 'config.manage', 'reports.run', 'audit.read', 'system.operate'],
  zone_manager: ['cases.work', 'team.manage', 'config.manage', 'reports.run'],
  approver: ['cases.work'],
  auditor: ['audit.read'],
};

/** False for an unrecognised role: an unknown role grants nothing. */
export function hasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role as Role];
  return granted ? granted.includes(permission) : false;
}
