import { seesEveryZone, type Role } from './permissions';

export interface RoleActor {
  role: Role;
  zoneId: string | null;
}

/**
 * Who may create a user with a given role in a given zone, or change an
 * existing user into one.
 *
 * This is not a permission. `team.manage` answers "may this person administer
 * users at all"; this answers "may they produce *this* user", which depends on
 * the target's role and zone as well as the actor's. Both the create and update
 * paths call it, because two copies of an escalation rule is one copy too many.
 *
 * Returns null when permitted, or the operator-facing reason when not.
 */
export function canAssignRole(
  actor: RoleActor,
  targetRole: Role,
  targetZone: string | null,
): string | null {
  if (targetRole === 'super_admin' && actor.role !== 'super_admin') {
    return 'Only a super admin can grant the super admin role';
  }
  if (actor.role === 'zone_manager') {
    // Pinning the target's zone is not enough on its own: a zone-wide role
    // ignores the zone it is filed under. `zoneContextFor` resolves every role
    // in ZONE_WIDE_ROLES to `zone: '*'`, so an `auditor` created with
    // `zoneId: 'EUR'` still reads every zone's cases and exports the whole
    // audit log. Asking `seesEveryZone` rather than naming roles here means a
    // role added to that list in the future is refused the moment it is added,
    // instead of quietly reopening this the way `auditor` did.
    if (seesEveryZone(targetRole)) {
      return 'Zone managers can only manage their own zone';
    }
    if (targetZone !== actor.zoneId) {
      return 'Zone managers can only manage their own zone';
    }
  }
  return null;
}

/**
 * Whether `actor` may permanently delete the account `target`.
 *
 * Returns a refusal to show the operator, or null when it is allowed.
 *
 * The rule mirrors `canAssignRole`: only a super admin may grant that role, so
 * only a super admin may take it away. Without this, an administrator could
 * remove every super admin but the last — the last-one guard in the controller
 * stops the account list emptying, not an administrator clearing out everybody
 * who outranks them, which is the harm worth preventing.
 *
 * A zone manager holds `team.manage` but not `users.administer`, so deletion
 * never reaches this function for them; the zone rule is stated anyway so the
 * policy reads completely rather than depending on a permission check
 * elsewhere staying as it is.
 *
 * Refusing to delete your own account is the controller's, not this
 * function's: it needs the actor's id, and `RoleActor` deliberately carries
 * only what a policy decision needs.
 */
export function canDeleteUser(
  actor: RoleActor,
  target: { role: Role; zoneId: string | null },
): string | null {
  if (target.role === 'super_admin' && actor.role !== 'super_admin') {
    return 'Only a super admin can delete a super admin';
  }
  if (actor.role === 'zone_manager') {
    if (seesEveryZone(target.role) || target.zoneId !== actor.zoneId) {
      return 'Zone managers can only manage their own zone';
    }
  }
  return null;
}
