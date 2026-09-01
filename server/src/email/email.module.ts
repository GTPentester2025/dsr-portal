import { Injectable, Module, forwardRef } from '@nestjs/common';
import { EMAIL_PROVIDER } from './email-provider.interface';
import type {
  ConnectionStatus,
  EmailProvider,
  SendAsUserArgs,
  SendResult,
  SendTransactionalOptions,
} from './email-provider.interface';
import { ConsoleProvider } from './console.provider';
import { GraphProvider } from './graph.provider';
import { SettingsService } from '../settings/settings.service';
import { diagnoseHttpsEndpoint, type DiagnosticStep } from './net-diagnostics';
import { SystemTemplateService } from './system-template.service';
import { SystemTemplateController } from './system-template.controller';
import { AuthModule } from '../auth/auth.module';
import { SendGuardService, type AttemptedMessage } from './send-guard.service';
import { renderTemplate, SENSITIVE_VARIABLES } from './templates';

/** Stands in for a masked variable, so the record still shows it was there. */
const REDACTED = '[redacted]';

/**
 * Strip the capabilities out of a message before it is written down.
 *
 * Only the failure paths below record a message at all, and they record it
 * into `email_log` and `audit_log` — the first of which is rendered onto the
 * case screen, `body_html` included. For most templates that is exactly right:
 * "what did the requester not receive?" is unanswerable without it. For the
 * two templates whose link *is* a bearer token, it turned every bounce into a
 * working, clickable link persisted in the case's own mail history.
 *
 * The body is dropped rather than scrubbed. The token appears in the rendered
 * HTML as an href, and a template edited from the admin console can put it
 * anywhere else in the markup as well — there is no substitution that stays
 * correct as the template changes, and not storing the body is the only form
 * of this that cannot be edited back into a leak. Which recipients, which
 * subject, which template, which error: all still recorded.
 */
function withoutCapabilities(message: AttemptedMessage): AttemptedMessage {
  const sensitive = message.templateId ? SENSITIVE_VARIABLES[message.templateId] : undefined;
  if (!sensitive?.length) return message;
  return {
    ...message,
    body: null,
    variables: message.variables
      ? Object.fromEntries(
          Object.entries(message.variables).map(([key, value]) => [
            key,
            sensitive.includes(key) ? REDACTED : value,
          ]),
        )
      : message.variables,
  };
}

/**
 * Raised instead of calling the provider when a scope is backed off. Carries
 * the retry time so a caller can say when, not only that it did not go.
 */
export class EmailThrottledError extends Error {
  constructor(
    readonly scope: string,
    readonly retryAfter: Date,
    readonly lastError: string | null,
  ) {
    super(
      `Sending is paused for ${scope} until ${retryAfter.toISOString()} after repeated failures` +
        (lastError ? `: ${lastError}` : ''),
    );
    this.name = 'EmailThrottledError';
  }
}

/**
 * Resolves the active adapter per call from EMAIL_PROVIDER, which is an
 * `envOnly` setting: it comes from /opt/dsr/server/.env or the catalog
 * default, never from an app_settings row, so the Settings screen cannot
 * change it and a restart is what makes a new value take effect. Provider
 * specific logic still lives only inside the adapters (spec section 4).
 */
@Injectable()
export class EmailDispatcher implements EmailProvider {
  constructor(
    private readonly settings: SettingsService,
    private readonly graph: GraphProvider,
    private readonly consoleProvider: ConsoleProvider,
    private readonly guard: SendGuardService,
  ) {}

  /**
   * Stage-by-stage connectivity report for the active adapter: HTTPS
   * reachability, then an authenticated call.
   */
  async diagnose(): Promise<DiagnosticStep[] | null> {
    if (this.activeName() !== 'graph') return null;

    const steps = await diagnoseHttpsEndpoint('graph.microsoft.com');
    if (steps.every((s) => s.ok)) {
      const started = Date.now();
      const status = await this.verifyConnection();
      steps.push({
        step: 'Authentication',
        ok: status.ok,
        detail: status.detail,
        hint: status.ok ? undefined : 'Check GRAPH_* credentials in /opt/dsr/server/.env.',
        ms: Date.now() - started,
      });
    }
    return steps;
  }

  /** Name of the adapter currently selected. */
  activeName(): string {
    return this.settings.get<string>('EMAIL_PROVIDER', 'graph');
  }

  private active(): EmailProvider {
    const which = this.activeName();
    switch (which) {
      case 'graph':
        return this.graph;
      case 'console':
        if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CONSOLE_EMAIL !== 'true') {
          throw new Error(
            'The console email adapter is not allowed in production. Set EMAIL_PROVIDER=graph in /opt/dsr/server/.env.',
          );
        }
        return this.consoleProvider;
      default:
        throw new Error(`Unknown email provider: ${which}`);
    }
  }

  /**
   * Every send goes through the guard.
   *
   * Placing it here rather than at each call site is deliberate: intake, the
   * reminder cron, escalation and the reply composer all send mail, and a
   * brake that only some of them respect is not a brake. It also means one
   * place knows how to write down a message that never left, which is what
   * makes "what did the requester not receive?" answerable afterwards.
   */
  async sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    const scopes = this.guard.scopesFor([to]);
    const describe = (): AttemptedMessage => {
      // Rendered only when something has gone wrong, so the happy path does
      // not pay for it twice. A template that cannot render is itself a
      // failure worth recording, hence the fallback rather than a throw.
      let subject = `[${templateId}]`;
      let body: string | null = null;
      try {
        const rendered = renderTemplate(templateId, variables, options?.language);
        subject = rendered.subject;
        body = rendered.html;
      } catch {
        /* recorded with the template id and variables instead */
      }
      // Masked here rather than at each recordUndelivered call: describe() is
      // reached only when a send has already failed, and it is the only thing
      // either failure path below hands the guard.
      return withoutCapabilities({
        to: [to],
        subject,
        body,
        templateId,
        variables,
        caseId: options?.caseId ?? null,
        zoneId: options?.zoneId ?? null,
      });
    };

    const blocked = await this.guard.blockedScope(scopes);
    if (blocked) {
      await this.guard.recordUndelivered({
        message: describe(),
        kind: 'throttled',
        error: blocked.lastError ?? 'Sending paused after repeated failures',
        attempt: blocked.consecutiveFailures,
        blockedUntil: blocked.blockedUntil,
      });
      throw new EmailThrottledError(blocked.scope, blocked.blockedUntil, blocked.lastError);
    }

    try {
      const result = await this.active().sendTransactional(to, templateId, variables, options);
      await this.guard.recordSuccess(scopes);
      return result;
    } catch (err) {
      const detail = (err as Error).message;
      const blockedUntil = await this.guard.recordFailure(scopes, detail);
      await this.guard.recordUndelivered({
        message: describe(),
        kind: 'provider',
        error: detail,
        attempt: 1,
        blockedUntil,
      });
      throw err;
    }
  }

  async sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    const recipients = [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])];
    const scopes = this.guard.scopesFor(recipients);
    const message: AttemptedMessage = {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      from: args.fromMailbox,
      subject: args.subject,
      body: args.body,
      caseId: args.caseId ?? null,
      zoneId: args.zoneId ?? null,
    };

    const blocked = await this.guard.blockedScope(scopes);
    if (blocked) {
      await this.guard.recordUndelivered({
        message,
        kind: 'throttled',
        error: blocked.lastError ?? 'Sending paused after repeated failures',
        attempt: blocked.consecutiveFailures,
        blockedUntil: blocked.blockedUntil,
      });
      throw new EmailThrottledError(blocked.scope, blocked.blockedUntil, blocked.lastError);
    }

    try {
      const result = await this.active().sendAsUser(args);
      await this.guard.recordSuccess(scopes);
      return result;
    } catch (err) {
      const detail = (err as Error).message;
      const blockedUntil = await this.guard.recordFailure(scopes, detail);
      await this.guard.recordUndelivered({
        message,
        kind: 'provider',
        error: detail,
        attempt: 1,
        blockedUntil,
      });
      throw err;
    }
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    try {
      return await this.active().verifyConnection();
    } catch (err) {
      return { ok: false, provider: this.activeName(), detail: (err as Error).message };
    }
  }
}

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [SystemTemplateController],
  providers: [
    GraphProvider,
    ConsoleProvider,
    EmailDispatcher,
    SystemTemplateService,
    SendGuardService,
    { provide: EMAIL_PROVIDER, useExisting: EmailDispatcher },
  ],
  exports: [EMAIL_PROVIDER, EmailDispatcher, SystemTemplateService, SendGuardService],
})
export class EmailModule {}
