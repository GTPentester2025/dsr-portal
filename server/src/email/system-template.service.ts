import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService, type ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import {
  TEMPLATE_LABELS,
  TEMPLATE_VARIABLES,
  defaultTemplate,
  setSystemTemplateOverrides,
  systemTemplateIds,
  unknownVariables,
  type EmailTemplate,
} from './templates';

export interface SystemTemplateView {
  key: string;
  label: string;
  description: string;
  variables: string[];
  subject: string;
  html: string;
  defaultSubject: string;
  defaultHtml: string;
  customised: boolean;
  updatedAt: string | null;
}

/**
 * Keeps the admin's system-template overrides in memory so `renderTemplate`
 * can stay synchronous for every provider, and reloads after each save.
 *
 * The pattern mirrors SettingsService: the database is the source of truth, the
 * cache is what the hot path reads, and a failure to load must not stop the
 * app from booting — the built-in templates are always a working fallback.
 */
@Injectable()
export class SystemTemplateService implements OnModuleInit {
  private readonly log = new Logger(SystemTemplateService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      // Read while rendering outbound mail, where there is no user context.
      const rows = await this.db.system(async (_db, client) => {
        const res = await client.query('SELECT key, subject, html FROM system_templates');
        return res.rows as { key: string; subject: string; html: string }[];
      });
      const map: Record<string, EmailTemplate> = {};
      for (const row of rows) {
        // Ignore rows for templates the code no longer defines rather than
        // letting a stale key shadow nothing.
        if (!defaultTemplate(row.key)) continue;
        map[row.key] = { subject: row.subject, html: row.html };
      }
      setSystemTemplateOverrides(map);
      this.log.log(`system template overrides loaded: ${Object.keys(map).length}`);
    } catch (err) {
      this.log.warn(`Could not load system templates, using built-ins: ${(err as Error).message}`);
    }
  }

  async list(): Promise<SystemTemplateView[]> {
    // The admin console lists every system template; system_templates has no
    // zone column to scope the read by.
    const rows = await this.db.system(async (_db, client) => {
      const res = await client.query('SELECT key, subject, html, updated_at FROM system_templates');
      return res.rows as { key: string; subject: string; html: string; updated_at: Date }[];
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));

    return systemTemplateIds().map((key) => {
      const base = defaultTemplate(key)!;
      const override = byKey.get(key);
      const meta = TEMPLATE_LABELS[key] ?? { label: key, description: '' };
      return {
        key,
        label: meta.label,
        description: meta.description,
        variables: TEMPLATE_VARIABLES[key] ?? [],
        subject: override?.subject ?? base.subject,
        html: override?.html ?? base.html,
        defaultSubject: base.subject,
        defaultHtml: base.html,
        customised: Boolean(override),
        updatedAt: override?.updated_at ? new Date(override.updated_at).toISOString() : null,
      };
    });
  }

  async save(
    ctx: ZoneContext,
    key: string,
    subject: string,
    html: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    if (!defaultTemplate(key)) throw new BadRequestException('Unknown template');
    if (!subject?.trim()) throw new BadRequestException('Subject cannot be empty');
    if (!html?.trim()) throw new BadRequestException('Body cannot be empty');

    // Strict substitution means an unknown variable would throw at send time,
    // silently stopping verification emails. Refuse it here instead.
    const bad = unknownVariables(key, subject, html);
    if (bad.length > 0) {
      throw new BadRequestException(
        `Unknown variable${bad.length > 1 ? 's' : ''}: ${bad.map((b) => `{{${b}}}`).join(', ')}. ` +
          `This template can use: ${(TEMPLATE_VARIABLES[key] ?? []).map((v) => `{{${v}}}`).join(', ')}`,
      );
    }

    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        `INSERT INTO system_templates (key, subject, html, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET
           subject = EXCLUDED.subject,
           html = EXCLUDED.html,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [key, subject, html, actorId],
      );
    });
    await this.refresh();
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'system_template.updated',
      entityType: 'system_template',
      entityId: key,
    });
    return { ok: true };
  }

  /** Drop the override so the built-in applies again. */
  async reset(ctx: ZoneContext, key: string, actorId: string): Promise<{ ok: true }> {
    if (!defaultTemplate(key)) throw new BadRequestException('Unknown template');
    await this.db.withContext(ctx, async (_db, client) => {
      await client.query('DELETE FROM system_templates WHERE key = $1', [key]);
    });
    await this.refresh();
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'system_template.reset',
      entityType: 'system_template',
      entityId: key,
    });
    return { ok: true };
  }

  /** Render with placeholder values so an editor can see the result safely. */
  preview(key: string, subject: string, html: string): { subject: string; html: string } {
    const bad = unknownVariables(key, subject, html);
    if (bad.length > 0) {
      throw new BadRequestException(`Unknown variable: {{${bad[0]}}}`);
    }
    const sample: Record<string, string> = {
      verification_url: 'https://example.com/verify?token=…',
      ttl_minutes: '15',
      case_ref: 'DSR-EUR-2026-00147',
      sla_statement: 'We will respond within 30 days.',
      zone: 'EUR',
      request_type: 'access',
      submission_date: '2026-08-18 09:15 UTC',
      due_date: '2026-09-17 09:15 UTC',
      case_url: 'https://example.com/admin/#/cases/…',
      pct: '90',
      assignee: 'Alex Martin',
      status: 'in_progress',
      waiting: '2 hours',
      provider: 'graph',
      sent_at: '2026-08-18 09:15 UTC',
    };
    const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, n: string) => sample[n] ?? `{{${n}}}`);
    return { subject: fill(subject), html: fill(html) };
  }
}
