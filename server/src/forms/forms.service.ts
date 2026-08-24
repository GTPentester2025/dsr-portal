import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

/** Component types the public renderer knows how to draw. */
export const FIELD_TYPES = [
  'dsrtextfield',
  'textfield',
  'dsremail',
  'email',
  'textarea',
  'dsrselect',
  'select',
  'dsrselectboxes',
  'dsrradio',
  'radio',
  'checkbox',
  'dsrphoneNumber',
  'dsrdatetime',
  'file',
  'datagrid',
] as const;

/** Non-input components used for layout and copy. */
export const LAYOUT_TYPES = ['htmlelement', 'content', 'columns', 'button'] as const;

const ALL_TYPES = new Set<string>([...FIELD_TYPES, ...LAYOUT_TYPES]);

/**
 * Per-form behaviour, mirroring the configuration surface of the source
 * platform so migrated forms keep the same semantics.
 */
export interface WorkflowSettings {
  responseDurationDays: number;
  businessDays: boolean;
  allowExtension: boolean;
  extensionDurationDays: number;
  reminderDays: number;
  emailVerificationExpiryHours: number;
  attachmentsEnabled: boolean;
  attachmentsMandatory: boolean;
  attachmentDescription: string;
  maxRequestsAllowed: number;
  minDaysBetweenRequests: number;
  allowParallelRequests: boolean;
}

export const DEFAULT_WORKFLOW: WorkflowSettings = {
  responseDurationDays: 30,
  businessDays: false,
  allowExtension: true,
  extensionDurationDays: 60,
  reminderDays: 5,
  emailVerificationExpiryHours: 24,
  attachmentsEnabled: false,
  attachmentsMandatory: false,
  attachmentDescription: '',
  maxRequestsAllowed: 10,
  minDaysBetweenRequests: 0,
  allowParallelRequests: true,
};

export interface FormSchemaDoc {
  key: string;
  zone: string;
  name: string;
  components: Record<string, unknown>[];
  display: Record<string, unknown>;
  i18n: Record<string, Record<string, string>>;
  languages: string[];
  defaultLanguage: string;
  requestTypes: Record<string, string>;
  workflow?: WorkflowSettings;
  [k: string]: unknown;
}

@Injectable()
export class FormsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Latest version of every form, for the admin list and the public picker. */
  async list(): Promise<
    {
      key: string;
      zone: string;
      name: string;
      version: number;
      fieldCount: number;
      languages: string[];
      country: string | null;
      updatedAt: string;
    }[]
  > {
    return this.db.system(async (_db, client) => {
      const res = await client.query(`
        SELECT DISTINCT ON (form_key) form_key, zone_id, version, schema, imported_at
          FROM form_versions
         ORDER BY form_key, version DESC
      `);
      return res.rows.map((r) => ({
        key: r.form_key,
        zone: r.zone_id,
        name: (r.schema as FormSchemaDoc).name,
        version: r.version,
        fieldCount: countFields((r.schema as FormSchemaDoc).components),
        languages: (r.schema as FormSchemaDoc).languages ?? [],
        country: ((r.schema as FormSchemaDoc).country as string | null) ?? null,
        updatedAt: r.imported_at,
      }));
    });
  }

  /** Latest published schema for one form. */
  async get(key: string): Promise<{ version: number; schema: FormSchemaDoc }> {
    if (!/^[a-z0-9-]{1,50}$/.test(key)) throw new BadRequestException('bad form key');
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        'SELECT version, schema FROM form_versions WHERE form_key = $1 ORDER BY version DESC LIMIT 1',
        [key],
      );
      if (res.rowCount === 0) throw new NotFoundException('Form not found');
      const schema = res.rows[0].schema as FormSchemaDoc;
      schema.workflow = { ...DEFAULT_WORKFLOW, ...(schema.workflow ?? {}) };
      return { version: res.rows[0].version, schema };
    });
  }

  /** Version history, so an operator can see when a form changed. */
  async history(key: string) {
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT version, imported_at FROM form_versions WHERE form_key = $1 ORDER BY version DESC LIMIT 30`,
        [key],
      );
      return res.rows.map((r) => ({ version: r.version, at: r.imported_at }));
    });
  }

  /**
   * Publish an edited schema as a new version. Existing cases keep pointing at
   * the version they were submitted under, so history always renders correctly.
   */
  async publish(
    key: string,
    incoming: Partial<FormSchemaDoc>,
    actorId: string,
    ip?: string,
  ): Promise<{ version: number }> {
    const current = await this.get(key);

    const next: FormSchemaDoc = {
      ...current.schema,
      ...incoming,
      key: current.schema.key,
      zone: current.schema.zone,
    };
    validateSchema(next);

    const version = await this.db.system(async (_db, client) => {
      const res = await client.query(
        `INSERT INTO form_versions (form_key, zone_id, version, schema)
         VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM form_versions WHERE form_key = $1), $3)
         RETURNING version`,
        [key, next.zone, JSON.stringify(next)],
      );
      return res.rows[0].version as number;
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'form.published',
      entityType: 'form',
      entityId: key,
      zoneId: next.zone,
      before: { version: current.version, fields: countFields(current.schema.components) },
      after: { version, fields: countFields(next.components) },
      sourceIp: ip,
    });

    return { version };
  }

  /** Roll back by re-publishing an older version as the newest one. */
  async restore(key: string, version: number, actorId: string, ip?: string) {
    const schema = await this.db.system(async (_db, client) => {
      const res = await client.query(
        'SELECT schema FROM form_versions WHERE form_key = $1 AND version = $2',
        [key, version],
      );
      if (res.rowCount === 0) throw new NotFoundException('Version not found');
      return res.rows[0].schema as FormSchemaDoc;
    });
    const result = await this.publish(key, schema, actorId, ip);
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'form.restored',
      entityType: 'form',
      entityId: key,
      after: { restoredFrom: version, newVersion: result.version },
      sourceIp: ip,
    });
    return result;
  }
}

/* ------------------------------- helpers --------------------------------- */

export function countFields(components: unknown): number {
  let n = 0;
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const comp = c as Record<string, unknown>;
      if (FIELD_TYPES.includes(comp.type as never)) n++;
      walk(comp.components);
      for (const col of (comp.columns as { components?: unknown }[]) ?? []) walk(col?.components);
    }
  };
  walk(components);
  return n;
}

/**
 * Structural validation before a form goes live. Rejects anything the public
 * renderer could not draw, and anything that would break submission handling.
 */
export function validateSchema(doc: FormSchemaDoc): void {
  if (!Array.isArray(doc.components) || doc.components.length === 0) {
    throw new BadRequestException('The form must contain at least one component');
  }

  const keys = new Set<string>();
  const errors: string[] = [];

  const walk = (list: unknown, path: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') {
        errors.push(`${path}[${i}] is not a component`);
        return;
      }
      const c = raw as Record<string, unknown>;
      const type = String(c.type ?? '');
      if (!ALL_TYPES.has(type)) {
        errors.push(`${path}[${i}] has unsupported type "${type}"`);
        return;
      }

      if (FIELD_TYPES.includes(type as never)) {
        const key = String(c.key ?? '');
        if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)) {
          errors.push(`"${key || '(blank)'}" is not a valid field name (letters, digits and underscores)`);
        } else if (keys.has(key)) {
          errors.push(`Duplicate field name "${key}"`);
        } else {
          keys.add(key);
        }
        if (!String(c.label ?? '').trim() && !c.hideLabel) {
          errors.push(`Field "${key}" needs a label`);
        }
        // Choice fields must offer something to choose.
        if (['dsrselectboxes', 'dsrradio', 'radio'].includes(type)) {
          const values = (c.values as unknown[]) ?? [];
          if (values.length === 0) errors.push(`Field "${key}" needs at least one option`);
        }
        if (['select', 'dsrselect'].includes(type)) {
          const data = (c.data as { values?: unknown[]; url?: string }) ?? {};
          const remote = c.dataSrc === 'url' && data.url;
          if (!remote && (data.values ?? []).length === 0) {
            errors.push(`Field "${key}" needs at least one option`);
          }
        }
      }

      walk(c.components, `${path}[${i}].components`);
      ((c.columns as { components?: unknown }[]) ?? []).forEach((col, ci) =>
        walk(col?.components, `${path}[${i}].columns[${ci}]`),
      );
    });
  };

  walk(doc.components, 'components');

  // Verification binds to this field, so the form cannot lose it.
  if (!keys.has('email')) {
    errors.push('The form must keep a field named "email" — email verification depends on it');
  }

  if (errors.length) {
    throw new BadRequestException({ message: 'The form could not be published', issues: errors });
  }
}
