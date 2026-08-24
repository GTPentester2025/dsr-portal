import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, Roles } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { SettingsService } from './settings.service';
import { SETTINGS, SETTING_GROUPS } from './settings.catalog';
import { EmailDispatcher } from '../email/email.module';
import { GmailOauthService } from './gmail-oauth.service';

/**
 * Runtime configuration API (admin only). Secret values are write-only: the
 * client can set them and see whether they are set, but never read them back.
 */
@Controller('internal/admin/settings')
@UseGuards(AuthGuard)
@Roles('super_admin')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly email: EmailDispatcher,
    private readonly gmailOauth: GmailOauthService,
  ) {}

  /** Field catalog plus current values, for rendering the Settings screen. */
  @Get()
  async list() {
    return {
      groups: SETTING_GROUPS,
      fields: SETTINGS,
      values: await this.settings.describeAll(),
    };
  }

  @Put()
  async update(
    @Req() req: AuthedRequest,
    @Body() body: { values?: Record<string, string> },
    @Ip() ip: string,
  ) {
    const values = body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new BadRequestException('values object is required');
    }
    const result = await this.settings.updateMany(values, req.user.id, ip);
    return { ...result, values: await this.settings.describeAll() };
  }

  /** Probe the currently selected email provider without sending anything. */
  @Post('email/verify')
  async verifyEmail() {
    return this.email.verifyConnection();
  }

  /**
   * Stage-by-stage SMTP check (DNS, TCP, TLS, authentication) so a failure
   * points at the layer responsible instead of one opaque timeout.
   */
  @Post('email/diagnose')
  async diagnose() {
    const steps = await this.email.diagnose();
    if (!steps) {
      return {
        applicable: false,
        reason: 'The active provider sends over HTTPS, so there is no SMTP connection to test.',
        steps: [],
      };
    }
    return { applicable: true, steps, ok: steps.every((s) => s.ok) };
  }

  /**
   * Start Gmail authorisation. Returns the Google consent URL for the browser
   * to visit, plus the redirect address that must be registered on the client.
   */
  @Post('email/gmail/authorize')
  authorizeGmail(@Req() req: AuthedRequest) {
    return this.gmailOauth.begin(req.user.id);
  }

  /** The address to register in Google Cloud, shown in the UI before connecting. */
  @Get('email/gmail/redirect-uri')
  gmailRedirectUri() {
    try {
      return { redirectUri: this.gmailOauth.redirectUri() };
    } catch (err) {
      return { redirectUri: '', error: (err as Error).message };
    }
  }

  /** Send a real test message through the active provider. */
  @Post('email/test-send')
  async testSend(@Body() body: { to?: string }) {
    const to = body?.to?.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      throw new BadRequestException('A valid recipient address is required');
    }
    try {
      const result = await this.email.sendTransactional(to, 'test-email', {
        provider: this.email.activeName(),
        sent_at: new Date().toISOString(),
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
