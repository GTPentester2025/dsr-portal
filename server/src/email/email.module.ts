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

  sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult> {
    return this.active().sendTransactional(to, templateId, variables, options);
  }

  sendAsUser(args: SendAsUserArgs): Promise<SendResult> {
    return this.active().sendAsUser(args);
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
    { provide: EMAIL_PROVIDER, useExisting: EmailDispatcher },
  ],
  exports: [EMAIL_PROVIDER, EmailDispatcher, SystemTemplateService],
})
export class EmailModule {}
