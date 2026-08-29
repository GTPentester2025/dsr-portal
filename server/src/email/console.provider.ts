import { Injectable, Logger } from '@nestjs/common';
import { appendFileSync } from 'node:fs';
import {
  ConnectionStatus,
  EmailProvider,
  SendAsUserArgs,
  SendResult,
  SendTransactionalOptions,
} from './email-provider.interface';
import { renderTemplate } from './templates';

/**
 * Dev/e2e adapter: emails are written to the log and (optionally) a file
 * given by EMAIL_CONSOLE_FILE. Never use in production.
 */
@Injectable()
export class ConsoleProvider implements EmailProvider {
  private readonly log = new Logger('ConsoleEmail');
  private counter = 0;

  private emit(kind: string, payload: unknown): SendResult {
    const id = `console-${Date.now()}-${++this.counter}`;
    const line = JSON.stringify({ id, kind, payload });
    this.log.log(line);
    const file = process.env.EMAIL_CONSOLE_FILE;
    if (file) appendFileSync(file, line + '\n');
    return { providerMessageId: id };
  }

  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    _options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const tpl = renderTemplate(templateId, variables, _options?.language);
    const result = await this.emit('transactional', {
      to, templateId, subject: tpl.subject, html: tpl.html,
    });
    return { ...result, subject: tpl.subject, html: tpl.html };
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    return this.emit('as-user', {
      from: args.fromMailbox,
      to: args.to,
      subject: args.subject,
    });
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    return { ok: true, provider: 'console', detail: 'console adapter (dev only)' };
  }

  activeName(): string {
    return 'console';
  }
}
