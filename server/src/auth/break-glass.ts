import { UnauthorizedException } from '@nestjs/common';
import type { Role } from './permissions';

export interface PasswordCandidate {
  role: Role;
  isBreakGlass: boolean;
}

/**
 * Thrown when `canUsePassword` refuses a login that authenticated correctly.
 *
 * A subclass of `UnauthorizedException` (not a new status) so the SPA's 401
 * handling on the login screen is unaffected; the controller distinguishes
 * this case only to skip charging it against the failed-login rate budget —
 * see the comment at that call site for why.
 */
export class PasswordDisabledException extends UnauthorizedException {}

/**
 * Who may still authenticate with a password once an identity provider is live.
 *
 * `is_break_glass` has existed since migration 0002 and nothing has ever read
 * it: it is set by scripts/create-user.mjs and displayed on the Team page. This
 * is the decision it was added for.
 *
 * While `ssoEnabled` is false — which is the default, and the state of every
 * deployment until an identity provider is actually wired — this returns null
 * for everyone and sign-in behaves exactly as it always has. Enforcement
 * without that gate would lock every non-super-admin out of a portal with no
 * other way in.
 *
 * Returns null when a password is permitted, or the reason when it is not.
 */
export function canUsePassword(user: PasswordCandidate, ssoEnabled: boolean): string | null {
  if (!ssoEnabled) return null;
  if (user.role === 'super_admin') return null;
  if (user.isBreakGlass) return null;
  return 'Password sign-in is disabled. Sign in through your organisation instead.';
}
