import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard, INTERNAL_SESSION_COOKIE } from './auth.guard';
import type { AuthedRequest } from './auth.guard';
import { RateLimitService } from '../public/rate-limit.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Secure cookies require HTTPS. Defaults to on in production; set
 * COOKIE_SECURE=false only for a temporary HTTP-only deployment.
 */
export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return process.env.COOKIE_SECURE === 'true';
  return process.env.NODE_ENV === 'production';
}

@Controller('internal/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rate: RateLimitService,
    private readonly settings: SettingsService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: string; password?: string },
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    if (!body?.email || !body?.password) throw new BadRequestException();
    // 10 FAILED attempts per IP per hour on the break-glass path —
    // successful logins do not consume the budget.
    const loginLimit = this.settings.getNumber('LOGIN_RATE_LIMIT', 10);
    if (!(await this.rate.isAllowed(`login-ip:${ip}`, loginLimit))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    let sessionId: string;
    let user: Awaited<ReturnType<AuthService['login']>>['user'];
    try {
      ({ sessionId, user } = await this.auth.login(body.email, body.password, ip));
    } catch (err) {
      await this.rate.record(`login-ip:${ip}`);
      throw err;
    }
    res.cookie(INTERNAL_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure(),
      maxAge: 8 * 3600_000,
      path: '/',
    });
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role, zoneId: user.zoneId } };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sid = req.cookies?.[INTERNAL_SESSION_COOKIE] as string | undefined;
    if (sid) await this.auth.logout(sid);
    res.clearCookie(INTERNAL_SESSION_COOKIE);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthedRequest) {
    const { id, name, email, role, zoneId, mustChangePassword } = req.user;
    return { id, name, email, role, zoneId, mustChangePassword: mustChangePassword === true };
  }

  /**
   * Change your own password. Available to every signed-in role, including one
   * whose account was just reset — that is the flow that clears the flag.
   */
  @Post('change-password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Req() req: AuthedRequest,
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Ip() ip: string,
  ) {
    const sessionId = req.cookies?.[INTERNAL_SESSION_COOKIE] ?? '';
    return this.auth.changeOwnPassword(
      req.user.id,
      body?.currentPassword ?? '',
      body?.newPassword ?? '',
      sessionId,
      ip,
    );
  }
}
