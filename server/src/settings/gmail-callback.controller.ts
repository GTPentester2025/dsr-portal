import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GmailOauthService } from './gmail-oauth.service';
import { SettingsService } from './settings.service';

/**
 * Google's redirect target.
 *
 * Deliberately outside the authenticated controller: the session cookie is
 * SameSite=Strict, so it is not sent on this cross-site hop. The single-use
 * `state` value carries the trust instead.
 */
@Controller('internal/admin/settings/email/gmail')
export class GmailCallbackController {
  constructor(
    private readonly gmailOauth: GmailOauthService,
    private readonly settings: SettingsService,
  ) {}

  private page(title: string, message: string, ok: boolean, backTo: string): string {
    const accent = ok ? '#0f7a44' : '#c4322b';
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f4f4f2;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
  <div style="max-width:460px;padding:32px;background:#fff;border:1px solid rgba(9,9,11,.08);border-radius:14px;text-align:center">
    <div style="width:44px;height:44px;margin:0 auto 16px;border-radius:12px;background:${accent}1a;color:${accent};display:flex;align-items:center;justify-content:center;font-size:22px">${ok ? '&#10003;' : '!'}</div>
    <h1 style="margin:0 0 8px;font-size:17px;color:#0a0a0a">${title}</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#555555">${message}</p>
    <a href="${backTo}" style="display:inline-block;padding:9px 16px;border-radius:9px;background:#d3a238;color:#0a0a0a;text-decoration:none;font-size:13px;font-weight:500">Back to Settings</a>
  </div>
</body>`;
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const back = `${this.settings.get<string>('INTERNAL_BASE_URL', '/admin')}/#/settings`;

    if (error) {
      return res
        .status(200)
        .type('html')
        .send(this.page('Authorisation cancelled', `Google reported: ${error}`, false, back));
    }
    if (!code) {
      return res
        .status(200)
        .type('html')
        .send(this.page('Authorisation failed', 'Google did not return an authorisation code.', false, back));
    }

    try {
      const { email } = await this.gmailOauth.complete(code, state);
      return res.status(200).type('html').send(
        this.page(
          'Gmail connected',
          email
            ? `The portal will now send as <strong>${email}</strong>. You can close this tab.`
            : 'The refresh token has been stored. You can close this tab.',
          true,
          back,
        ),
      );
    } catch (err) {
      return res
        .status(200)
        .type('html')
        .send(this.page('Could not connect Gmail', (err as Error).message, false, back));
    }
  }
}
