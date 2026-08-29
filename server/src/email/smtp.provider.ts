import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
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
 * Generic SMTP adapter for any provider that speaks SMTP — a corporate relay,
 * Office 365, Amazon SES, Postmark, Brevo and so on. Gmail with an app
 * password is the same protocol with fixed host settings.
 */
@Injectable()
export class SmtpProvider implements EmailProvider {
  private readonly log = new Logger(SmtpProvider.name);

  constructor(private readonly settings: SettingsService) {}

  config(): SmtpConfig {
    const host = this.settings.get<string>('SMTP_HOST', '');
    if (!host) throw new Error('SMTP host is not configured');
    const port = this.settings.getNumber('SMTP_PORT', 587);
    return {
      host,
      port,
      // Port 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
      secure: this.settings.get<string>('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true',
      user: this.settings.get<string>('SMTP_USER', ''),
      pass: this.settings.get<string>('SMTP_PASSWORD', ''),
    };
  }

  private from(displayName?: string): string {
    const name = displayName ?? this.settings.get<string>('EMAIL_FROM_NAME', 'Privacy Team');
    const address =
      this.settings.get<string>('PRIVACY_MAILBOX', '') || this.config().user;
    return `"${name.replace(/"/g, '')}" <${address}>`;
  }

  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const tpl = renderTemplate(templateId, variables, options?.language);
    const transport = createSmtpTransport(this.config());
    try {
      const info = await transport.sendMail({
        from: this.from(options?.fromDisplayName),
        to,
        subject: tpl.subject,
        html: tpl.html,
        replyTo: options?.replyTo,
      });
      return { providerMessageId: info.messageId, subject: tpl.subject, html: tpl.html };
    } finally {
      transport.close();
    }
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    const cfg = this.config();
    const transport = createSmtpTransport(cfg);
    try {
      const info = await transport.sendMail({
        from: `"${this.settings.get<string>('EMAIL_FROM_NAME', 'Privacy Team')}" <${args.fromMailbox || cfg.user}>`,
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
      return { providerMessageId: info.messageId };
    } finally {
      transport.close();
    }
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    try {
      const cfg = this.config();
      const transport = createSmtpTransport(cfg);
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      return {
        ok: true,
        provider: `smtp/${cfg.host}:${cfg.port}`,
        detail: `Signed in as ${cfg.user}`,
      };
    } catch (err) {
      this.log.warn(`SMTP connection check failed: ${(err as Error).message}`);
      return { ok: false, provider: 'smtp', detail: (err as Error).message };
    }
  }

  /** Stage-by-stage report used by the Settings screen. */
  diagnose() {
    return diagnoseSmtp(this.config());
  }

  activeName(): string {
    return 'smtp';
  }
}
