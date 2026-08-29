import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import {
  ConnectionStatus,
  EmailProvider,
  SendAsUserArgs,
  SendResult,
  SendTransactionalOptions,
} from './email-provider.interface';
import { renderTemplate } from './templates';
import { createSmtpTransport, diagnoseSmtp, type SmtpConfig } from './smtp';

/**
 * Gmail adapter (spec §4A). Two auth modes, selected by GMAIL_AUTH:
 *  - "oauth2"       Gmail API users.messages.send with a refresh token
 *  - "app-password" SMTP smtp.gmail.com:465 with an app password
 */
@Injectable()
export class GmailProvider implements EmailProvider {
  private readonly log = new Logger(GmailProvider.name);

  constructor(private readonly config: SettingsService) {}

  private get authMode(): 'oauth2' | 'app-password' {
    const mode = this.config.get<string>('GMAIL_AUTH', 'app-password');
    if (mode !== 'oauth2' && mode !== 'app-password') {
      throw new Error(`GMAIL_AUTH must be oauth2 or app-password, got: ${mode}`);
    }
    return mode;
  }

  private get user(): string {
    const u = this.config.get<string>('GMAIL_USER');
    if (!u) throw new Error('GMAIL_USER is not configured');
    return u;
  }

  private get fromDisplayName(): string {
    return this.config.get<string>('EMAIL_FROM_NAME', 'Privacy Team');
  }

  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const tpl = renderTemplate(templateId, variables, options?.language);
    const result = await this.send({
      from: this.formatFrom(options?.fromDisplayName),
      to,
      subject: tpl.subject,
      html: tpl.html,
      replyTo: options?.replyTo,
    });
    return { ...result, subject: tpl.subject, html: tpl.html };
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    // Gmail can only send as the authenticated account (or its configured
    // aliases). fromMailbox is honored as an alias; Graph handles true
    // shared-mailbox send-as in production.
    return this.send({
      from: `${this.quoteName(this.fromDisplayName)} <${args.fromMailbox}>`,
      to: args.to.join(', '),
      cc: args.cc?.join(', '),
      bcc: args.bcc?.join(', '),
      subject: args.subject,
      html: args.body,
      attachments: args.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, 'base64'),
        contentType: a.contentType,
      })),
    });
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    try {
      if (this.authMode === 'oauth2') {
        const gmail = this.gmailClient();
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return {
          ok: true,
          provider: 'gmail/oauth2',
          detail: `Authenticated as ${profile.data.emailAddress}`,
        };
      }
      const transport = this.smtpTransport();
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      return {
        ok: true,
        provider: 'gmail/app-password',
        detail: `SMTP login OK for ${this.user}`,
      };
    } catch (err) {
      const detail = explainGmailError(err as Error);
      this.log.warn(`Gmail connection check failed: ${detail}`);
      return {
        ok: false,
        provider: `gmail/${this.authMode}`,
        detail,
      };
    }
  }

  // ---- internals ----------------------------------------------------------

  private formatFrom(displayName?: string): string {
    return `${this.quoteName(displayName ?? this.fromDisplayName)} <${this.user}>`;
  }

  private quoteName(name: string): string {
    return `"${name.replace(/"/g, '')}"`;
  }

  private async send(mail: Mail.Options): Promise<SendResult> {
    if (this.authMode === 'app-password') {
      const transport = this.smtpTransport();
      try {
        const info = await transport.sendMail(mail);
        return { providerMessageId: info.messageId };
      } finally {
        transport.close();
      }
    }
    const gmail = this.gmailClient();
    const raw = await new MailComposer(mail).compile().build();
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: raw.toString('base64url') },
    });
    return { providerMessageId: res.data.id ?? 'unknown' };
  }

  /** Gmail SMTP endpoint; the port is configurable because 465 is blocked on
   *  many cloud hosts while 587 sometimes is not. */
  smtpConfig(): SmtpConfig {
    const pass = this.config.get<string>('GMAIL_APP_PASSWORD', '');
    const port = this.config.getNumber('GMAIL_SMTP_PORT', 465);
    return {
      host: 'smtp.gmail.com',
      port,
      secure: port === 465,
      user: this.config.get<string>('GMAIL_USER', ''),
      pass,
    };
  }

  /** Stage-by-stage report used by the Settings screen. */
  diagnose() {
    return diagnoseSmtp(this.smtpConfig());
  }

  private smtpTransport() {
    const cfg = this.smtpConfig();
    if (!cfg.pass) throw new Error('GMAIL_APP_PASSWORD is not configured');
    if (!cfg.user) throw new Error('GMAIL_USER is not configured');
    return createSmtpTransport(cfg);
  }

  private gmailClient() {
    const clientId = this.config.get<string>('GMAIL_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('GMAIL_OAUTH_CLIENT_SECRET');
    const refreshToken = this.config.get<string>('GMAIL_OAUTH_REFRESH_TOKEN');
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN must all be configured for GMAIL_AUTH=oauth2',
      );
    }
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
  }

  activeName(): string {
    return 'gmail';
  }
}

/**
 * Google returns `invalid_grant` for several unrelated causes, all of which look
 * identical to an operator. The one that actually happens in practice is the
 * seven-day refresh token lifetime that Google applies to OAuth clients left in
 * "Testing" publishing status, so name it rather than pass the raw string on.
 */
export function explainGmailError(err: Error): string {
  const raw = err.message ?? String(err);
  if (/invalid_grant/i.test(raw)) {
    return (
      'Google rejected the stored refresh token (invalid_grant). This normally means the ' +
      'OAuth consent screen is still in "Testing", where refresh tokens expire after seven ' +
      'days. Set the publishing status to "In production" in Google Cloud, then press ' +
      'Connect Google account again. It can also mean the token was revoked or the account ' +
      'password changed.'
    );
  }
  if (/invalid_client/i.test(raw)) {
    return 'Google rejected the client ID or secret (invalid_client). Check both values in Settings.';
  }
  if (/access_denied/i.test(raw)) {
    return 'Google denied the request (access_denied). Add the sending address as a test user on the OAuth consent screen, or publish the app.';
  }
  if (/insufficient|scope/i.test(raw) && /gmail/i.test(raw)) {
    return 'The stored token does not carry the gmail.send scope. Press Connect Google account again and approve the send permission.';
  }
  return raw;
}
