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

const API = 'https://api.resend.com';

/**
 * Resend adapter. Sends over HTTPS, which matters because most cloud hosts
 * block outbound SMTP entirely; setup is a single API key.
 */
@Injectable()
export class ResendProvider implements EmailProvider {
  private readonly log = new Logger(ResendProvider.name);

  constructor(private readonly settings: SettingsService) {}

  private key(): string {
    const k = this.settings.get<string>('RESEND_API_KEY', '');
    if (!k) throw new Error('Resend API key is not configured');
    return k;
  }

  private from(displayName?: string): string {
    const name = displayName ?? this.settings.get<string>('EMAIL_FROM_NAME', 'Privacy Team');
    const address = this.settings.get<string>('PRIVACY_MAILBOX', '');
    if (!address) {
      throw new Error('Privacy mailbox is not configured; Resend needs a verified sender address');
    }
    return `${name} <${address}>`;
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`${API}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.key()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      throw new Error(body.message ?? `Resend returned ${res.status}`);
    }
    return { providerMessageId: body.id ?? 'resend-accepted' };
  }

  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const tpl = renderTemplate(templateId, variables, options?.language);
    const result = await this.post({
      from: this.from(options?.fromDisplayName),
      to: [to],
      subject: tpl.subject,
      html: tpl.html,
      ...(options?.replyTo ? { reply_to: options.replyTo } : {}),
    });
    return { ...result, subject: tpl.subject, html: tpl.html };
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    return this.post({
      from: this.from(),
      to: args.to,
      ...(args.cc?.length ? { cc: args.cc } : {}),
      ...(args.bcc?.length ? { bcc: args.bcc } : {}),
      subject: args.subject,
      html: args.body,
      ...(args.attachments?.length
        ? { attachments: args.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
        : {}),
    });
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    try {
      // Listing domains is a cheap authenticated call that sends no mail.
      const res = await fetch(`${API}/domains`, {
        headers: { authorization: `Bearer ${this.key()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, provider: 'resend', detail: 'The API key was rejected.' };
      }
      if (!res.ok) {
        return { ok: false, provider: 'resend', detail: `Resend returned ${res.status}` };
      }
      const body = (await res.json().catch(() => ({}))) as { data?: { name: string; status: string }[] };
      const domains = body.data ?? [];
      const verified = domains.filter((d) => d.status === 'verified').map((d) => d.name);
      return {
        ok: true,
        provider: 'resend',
        detail: verified.length
          ? `API key valid. Verified sending domains: ${verified.join(', ')}`
          : 'API key valid. No verified sending domain yet — add and verify one in Resend before sending.',
      };
    } catch (err) {
      this.log.warn(`Resend check failed: ${(err as Error).message}`);
      return { ok: false, provider: 'resend', detail: (err as Error).message };
    }
  }

  activeName(): string {
    return 'resend';
  }
}
