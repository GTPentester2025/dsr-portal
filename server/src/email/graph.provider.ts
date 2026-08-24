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

/**
 * Microsoft Graph adapter (spec §4B) — production path.
 * Client-credentials flow with Mail.Send application permission, sending as
 * the PRIVACY_MAILBOX shared mailbox. Token cached until 5 min before expiry.
 *
 * Azure setup required (documented in README): app registration, Mail.Send
 * application permission with admin consent, and an application access
 * policy scoping the permission to the shared mailbox only.
 */
@Injectable()
export class GraphProvider implements EmailProvider {
  private readonly log = new Logger(GraphProvider.name);
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: SettingsService) {}

  private cfg(key: string): string {
    const v = this.config.get<string>(key);
    if (!v) throw new Error(`${key} is not configured`);
    return v;
  }

  private get mailbox(): string {
    return this.cfg('PRIVACY_MAILBOX');
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 300_000) {
      return this.token.value;
    }
    const tenant = this.cfg('GRAPH_TENANT_ID');
    const res = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.cfg('GRAPH_CLIENT_ID'),
          client_secret: this.cfg('GRAPH_CLIENT_SECRET'),
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.token.value;
  }

  private async sendMail(fromMailbox: string, message: Record<string, unknown>): Promise<SendResult> {
    const token = await this.getToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/sendMail`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message, saveToSentItems: true }),
      },
    );
    if (res.status !== 202) {
      throw new Error(`Graph sendMail failed: ${res.status} ${await res.text()}`);
    }
    // Graph returns no message id on sendMail; use the request id header.
    return { providerMessageId: res.headers.get('request-id') ?? 'graph-accepted' };
  }

  private recipients(addrs: string[] | undefined) {
    return (addrs ?? []).map((a) => ({ emailAddress: { address: a } }));
  }

  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const tpl = renderTemplate(templateId, variables, options?.language);
    const result = await this.sendMail(this.mailbox, {
      subject: tpl.subject,
      body: { contentType: 'HTML', content: tpl.html },
      toRecipients: this.recipients([to]),
      ...(options?.replyTo
        ? { replyTo: this.recipients([options.replyTo]) }
        : {}),
    });
    return { ...result, subject: tpl.subject, html: tpl.html };
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    return this.sendMail(args.fromMailbox, {
      subject: args.subject,
      body: { contentType: 'HTML', content: args.body },
      toRecipients: this.recipients(args.to),
      ccRecipients: this.recipients(args.cc),
      bccRecipients: this.recipients(args.bcc),
      attachments: (args.attachments ?? []).map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType ?? 'application/octet-stream',
        contentBytes: a.content,
      })),
    });
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    try {
      const token = await this.getToken();
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.mailbox)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        return {
          ok: false,
          provider: 'graph',
          detail: `Token OK but mailbox lookup failed: ${res.status}`,
        };
      }
      const user = (await res.json()) as { displayName?: string };
      return {
        ok: true,
        provider: 'graph',
        detail: `Mailbox reachable: ${user.displayName ?? this.mailbox}`,
      };
    } catch (err) {
      this.log.warn(`Graph connection check failed: ${(err as Error).message}`);
      return { ok: false, provider: 'graph', detail: (err as Error).message };
    }
  }
}
