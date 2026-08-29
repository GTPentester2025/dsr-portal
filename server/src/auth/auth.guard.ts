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
import { hasPermission, type Permission } from './permissions';

export const INTERNAL_SESSION_COOKIE = 'dsr_int';
const PERMISSION_KEY = 'dsr:permission';

/** Restrict a handler to holders of a permission, e.g. @Requires('team.manage'). */
export const Requires = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

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

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required && !hasPermission(user.role, required)) {
      throw new ForbiddenException();
    }

    req.user = user;
    req.zoneCtx = zoneContextFor(user);
    return true;
  }
}
