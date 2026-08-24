import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, SessionUser, zoneContextFor } from './auth.service';
import type { ZoneContext } from '../db/db.module';

export const INTERNAL_SESSION_COOKIE = 'dsr_int';
const ROLES_KEY = 'dsr:roles';

/**
 * Privilege ladder for the operational roles, so @Roles('admin') also admits a
 * super admin without every decorator listing both.
 *
 * `auditor` is deliberately NOT on the ladder: it is a read-only lane that
 * must never be reachable by inheritance, and must never inherit anything.
 */
const RANK: Record<string, number> = {
  approver: 1,
  zone_manager: 2,
  admin: 3,
  super_admin: 4,
};

export function satisfies(actual: string, required: string[]): boolean {
  if (required.includes(actual)) return true;
  if (actual === 'auditor') return false;

  // Only ladder roles contribute to the threshold; a route open to auditors
  // must not therefore become open to every ladder role.
  const ladder = required.filter((r) => r in RANK);
  if (ladder.length === 0) return false;
  const need = Math.min(...ladder.map((r) => RANK[r]));
  return (RANK[actual] ?? 0) >= need;
}

/** Restrict a handler to specific roles, e.g. @Roles('admin'). */
export const Roles = (...roles: SessionUser['role'][]) => SetMetadata(ROLES_KEY, roles);

export interface AuthedRequest extends Request {
  user: SessionUser;
  zoneCtx: ZoneContext;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const sessionId = (req.cookies?.[INTERNAL_SESSION_COOKIE] as string | undefined) ?? '';
    const user = await this.auth.resolveSession(sessionId);
    if (!user) throw new UnauthorizedException();

    const roles = this.reflector.getAllAndOverride<SessionUser['role'][] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (roles && roles.length > 0 && !satisfies(user.role, roles)) {
      throw new ForbiddenException();
    }

    req.user = user;
    req.zoneCtx = zoneContextFor(user);
    return true;
  }
}
