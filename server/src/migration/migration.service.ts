import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import { formVersions } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { ENCRYPTED_FIELD_KEYS } from '../crypto/pii-fields';
import { collectInputs } from '../public/form-validation';
import {
  CASE_TARGETS,
  type ColumnProposal,
  type CoercedRow,
  type DateOrder,
  type FormIndex,
  type ParsedFile,
  type RowIssue,
  coerceRow,
  decodeUpload,
  detectDateOrder,
  indexForm,
  parseDelimited,
  proposeMapping,
} from './csv-import';

/**
 * Ceilings on a single upload. Both are about keeping one click from taking
 * the process down: the row cap bounds the transaction, the byte cap bounds
 * what is held in memory while parsing.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

/** Placeholder domain is reserved by RFC 2606 and can never route anywhere. */
const NO_EMAIL_DOMAIN = 'import.invalid';

@Injectable()
export class MigrationService {
  private readonly log = new Logger(MigrationService.name);

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Analyse
  // -------------------------------------------------------------------------

  /**
   * Read the file, work out what each column is, and hold the result for the
   * operator to confirm.
   *
   * Nothing is written to `cases` here. Splitting analyse from commit is what
   * makes a bad date format or a mis-detected column a thing somebody notices
   * on screen rather than a thing they discover in the case list a week later.
   */
  async analyse(args: {
    buffer: Buffer;
    filename: string;
    zoneId: string;
    formKey: string;
    actorId: string;
    ip?: string;
  }) {
    if (args.buffer.length === 0) throw new BadRequestException('The file is empty');
    if (args.buffer.length > MAX_IMPORT_BYTES) {
      throw new BadRequestException(
        `File is larger than ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB — split it and import in parts`,
      );
    }

    const { text, encoding } = decodeUpload(args.buffer);
    const file = parseDelimited(text);
    if (file.headers.length < 2) {
      throw new BadRequestException(
        'No columns found. Save the sheet as CSV — .xlsx is a compressed format this importer cannot read.',
      );
    }
    if (file.rows.length === 0) throw new BadRequestException('The file has headings but no rows');
    if (file.rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `${file.rows.length} rows exceeds the ${MAX_IMPORT_ROWS} row limit for one import`,
      );
    }

    const { form, version } = await this.loadForm(args.formKey, args.zoneId);
    const proposals = proposeMapping(file, form);

    // Date order is sniffed across every column proposed as a date, not just
    // the first, so a file whose created dates are all early in the month
    // still gets the evidence from its deadlines.
    const dateSamples: string[] = [];
    proposals.forEach((p, i) => {
      if (!p.target.startsWith('case:')) return;
      const spec = CASE_TARGETS.find((t) => t.id === p.target.slice(5));
      if (spec?.type !== 'date') return;
      for (const row of file.rows.slice(0, 500)) dateSamples.push(row[i] ?? '');
    });
    const dateOrder = detectDateOrder(dateSamples);

    const mapping = Object.fromEntries(proposals.map((p) => [p.header, p.target]));
    const preview = this.preview(file, form, mapping, dateOrder.order);
    const duplicates = await this.findExisting(preview.rows);

    const record = await this.db.withContext(this.ctxFor(args.zoneId), async (_db, client) => {
      const r = await client.query(
        `INSERT INTO case_imports
           (filename, source_tool, zone_id, form_key, form_version, status,
            total_rows, mapping, payload, issues, uploaded_by)
         VALUES ($1,'securiti',$2,$3,$4,'analysed',$5,$6,$7,$8,$9)
         RETURNING id, created_at`,
        [
          args.filename,
          args.zoneId,
          args.formKey,
          version,
          file.rows.length,
          JSON.stringify(mapping),
          JSON.stringify({ headers: file.headers, rows: file.rows, encoding, delimiter: file.delimiter }),
          JSON.stringify(preview.issues),
          args.actorId,
        ],
      );
      return r.rows[0] as { id: string; created_at: string };
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'import.analysed',
      entityType: 'case_import',
      entityId: record.id,
      zoneId: args.zoneId,
      after: {
        filename: args.filename,
        rows: file.rows.length,
        columns: file.headers.length,
        encoding,
        delimiter: file.delimiter,
      },
      sourceIp: args.ip,
    });

    return {
      id: record.id,
      filename: args.filename,
      zoneId: args.zoneId,
      formKey: args.formKey,
      formVersion: version,
      encoding,
      delimiter: file.delimiter,
      totalRows: file.rows.length,
      dateOrder: dateOrder.order,
      dateOrderConfident: dateOrder.confident,
      columns: proposals,
      targets: this.targetCatalogue(form),
      sampleRows: preview.samples,
      issues: preview.issues.slice(0, 200),
      errorRows: preview.errorRows,
      duplicates,
    };
  }

  /**
   * Re-run the coercion against a mapping the operator has changed, without
   * re-uploading. The preview and the commit share one code path so what is
   * shown is what gets written.
   */
  async reanalyse(
    ctx: ZoneContext,
    id: string,
    body: { mapping?: Record<string, string>; dateOrder?: DateOrder },
  ) {
    const record = await this.load(ctx, id);
    if (record.status !== 'analysed') {
      throw new BadRequestException('This import has already been committed');
    }
    const file = this.fileOf(record);
    const { form } = await this.loadForm(record.form_key, record.zone_id);
    const mapping = body.mapping ?? (record.mapping as Record<string, string>);
    const dateOrder = body.dateOrder ?? 'dmy';
    const preview = this.preview(file, form, mapping, dateOrder);
    const duplicates = await this.findExisting(preview.rows);

    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        'UPDATE case_imports SET mapping = $2, issues = $3 WHERE id = $1',
        [id, JSON.stringify(mapping), JSON.stringify(preview.issues)],
      );
    });

    return {
      id,
      dateOrder,
      sampleRows: preview.samples,
      issues: preview.issues.slice(0, 200),
      errorRows: preview.errorRows,
      duplicates,
    };
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  /**
   * Write the cases.
   *
   * Rows with errors are skipped rather than failing the whole file: an import
   * of 11 000 historical cases should not be blocked by three of them having a
   * malformed date, and the ones that were skipped are reported by row number
   * so they can be fixed and re-uploaded. Re-importing is safe — a row whose
   * source id is already present is counted as skipped, not written twice.
   */
  async commit(
    ctx: ZoneContext,
    id: string,
    body: { mapping?: Record<string, string>; dateOrder?: DateOrder },
    actorId: string,
    ip?: string,
  ) {
    const record = await this.load(ctx, id);
    if (record.status === 'committed') {
      throw new BadRequestException('This import has already been committed');
    }
    const file = this.fileOf(record);
    const { form } = await this.loadForm(record.form_key, record.zone_id);
    const mapping = body.mapping ?? (record.mapping as Record<string, string>);
    const dateOrder = body.dateOrder ?? 'dmy';

    const coerced = file.rows.map((cells, i) =>
      coerceRow(file.headers, cells, i + 2, { dateOrder, form, mapping }),
    );

    const owners = await this.ownerIndex(record.zone_id);
    const issues: RowIssue[] = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let placeholderEmails = 0;
    const createdRefs: string[] = [];

    for (const row of coerced) {
      if (row.issues.some((i) => i.severity === 'error')) {
        issues.push(...row.issues);
        failed++;
        continue;
      }
      try {
        const result = await this.writeCase(record, row, owners, actorId);
        issues.push(...row.issues);
        if (result.duplicate) {
          issues.push({
            row: row.index,
            message: `Already imported as ${result.caseRef}`,
            severity: 'warning',
          });
          skipped++;
          continue;
        }
        if (result.placeholderEmail) placeholderEmails++;
        createdRefs.push(result.caseRef);
        imported++;
      } catch (err) {
        // One bad row must not roll back the rest: each case is written in its
        // own transaction, so a failure is a reported row, not a lost import.
        this.log.error(`import ${id} row ${row.index}: ${(err as Error).message}`);
        issues.push({ row: row.index, message: (err as Error).message, severity: 'error' });
        failed++;
      }
    }

    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        `UPDATE case_imports
            SET status = 'committed', mapping = $2, imported = $3, skipped = $4,
                failed = $5, issues = $6, payload = NULL, committed_at = now()
          WHERE id = $1`,
        [id, JSON.stringify(mapping), imported, skipped, failed, JSON.stringify(issues.slice(0, 2000))],
      );
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'import.committed',
      entityType: 'case_import',
      entityId: id,
      zoneId: record.zone_id,
      after: {
        filename: record.filename,
        formKey: record.form_key,
        imported,
        skipped,
        failed,
        placeholderEmails,
        // Enough to reconstruct which cases arrived this way without listing
        // eleven thousand references in one audit row.
        firstRef: createdRefs[0] ?? null,
        lastRef: createdRefs[createdRefs.length - 1] ?? null,
      },
      sourceIp: ip,
    });

    return { ok: true, imported, skipped, failed, placeholderEmails, issues: issues.slice(0, 500) };
  }

  /**
   * One case, in its own transaction.
   *
   * Imported cases are marked `source = 'import'` and are never acknowledged
   * by email: the portal did not receive these requests and must not write to
   * people about correspondence that happened somewhere else, possibly years
   * ago. That is also why the SLA clock is stopped for anything already closed
   * and starts with its past reminder thresholds already marked fired.
   */
  private async writeCase(
    record: ImportRecord,
    row: CoercedRow,
    owners: Map<string, string>,
    actorId: string,
  ): Promise<{ caseRef: string; duplicate: boolean; placeholderEmail: boolean }> {
    const props = row.caseProps as Record<string, any>;
    const externalId = props.externalId ? String(props.externalId) : null;

    return this.db.system(async (db, client) => {
      if (externalId) {
        const seen = await client.query('SELECT case_ref FROM cases WHERE external_id = $1', [externalId]);
        if (seen.rows[0]) {
          return { caseRef: seen.rows[0].case_ref as string, duplicate: true, placeholderEmail: false };
        }
      }

      const createdAt = new Date(String(props.createdAt));
      const status: string = props.status ?? 'open';
      const closedAt = props.closedAt ? new Date(String(props.closedAt)) : status === 'closed' ? createdAt : null;
      const requestTypes: string[] = Array.isArray(props.requestTypes) ? props.requestTypes : [];

      // Deadline: what the file says, or what this zone's policy would have
      // produced from the arrival date. Inventing one from today would make
      // every historical case look brand new to the SLA engine.
      const policyRes = await client.query(
        `SELECT id, target_minutes FROM sla_policies
          WHERE zone_id = $1 AND (request_type = ANY($2::text[]) OR request_type = '*')
          ORDER BY (request_type = '*') ASC LIMIT 1`,
        [record.zone_id, requestTypes.length ? requestTypes : ['*']],
      );
      const policy = policyRes.rows[0] ?? null;
      const dueAt = props.dueAt
        ? new Date(String(props.dueAt))
        : new Date(createdAt.getTime() + Number(policy?.target_minutes ?? 30 * 1440) * 60_000);

      const year = createdAt.getUTCFullYear();
      const seqRes = await client.query(
        `INSERT INTO case_sequences (zone_id, year, last_seq) VALUES ($1, $2, 1)
         ON CONFLICT (zone_id, year) DO UPDATE SET last_seq = case_sequences.last_seq + 1
         RETURNING last_seq`,
        [record.zone_id, year],
      );
      const caseRef = `DSR-${record.zone_id}-${year}-${String(Number(seqRes.rows[0].last_seq)).padStart(5, '0')}`;

      // An email is required by the schema and by every lookup that resolves a
      // requester. Where the source file has none, a reserved-domain
      // placeholder keeps the record intact and unmistakably marks it as one
      // that cannot be written to. The count is reported after the import.
      const rawEmail: string | null =
        (props.requesterEmail as string | undefined) ??
        (typeof row.fields.email === 'string' ? row.fields.email : null) ??
        (typeof row.fields.account_email === 'string' ? row.fields.account_email : null);
      const placeholderEmail = !rawEmail;
      const email = rawEmail ?? `no-email+${externalId ?? caseRef}@${NO_EMAIL_DOMAIN}`;

      const ownerId = this.matchOwner(owners, props.assigneeEmail);

      const inserted = await client.query(
        `INSERT INTO cases
           (case_ref, zone_id, form_key, form_version, request_types,
            requester_email_enc, requester_email_hmac, requester_name_enc,
            status, assignee_id, due_at, created_at, updated_at, closed_at,
            residency, skip_completion_notification, completed_after_deadline,
            auto_extended, report_published_at, report_accessed_at,
            can_be_appealed, can_appeal_until, is_appeal, appeal_status,
            source, external_id, external_request_id, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16,$17,$18,$19,
                 $20,$21,$22,$23,'import',$24,$25,now())
         RETURNING id`,
        [
          caseRef,
          record.zone_id,
          record.form_key,
          record.form_version,
          JSON.stringify(requestTypes),
          this.crypto.encrypt(email),
          this.crypto.lookupHmac(email),
          props.requesterName ? this.crypto.encrypt(String(props.requesterName)) : null,
          status,
          ownerId,
          dueAt,
          createdAt,
          closedAt,
          props.residency ?? null,
          props.skipCompletionNotification ?? false,
          // Prefer what the file asserts; fall back to the dates it carries.
          props.completedAfterDeadline ?? (closedAt && dueAt ? closedAt > dueAt : null),
          props.autoExtended ?? false,
          row.reportPublished ? (closedAt ?? createdAt) : null,
          row.reportAccessed ? (closedAt ?? createdAt) : null,
          props.canBeAppealed ?? false,
          props.canAppealUntil ? new Date(String(props.canAppealUntil)) : null,
          props.isAppeal ?? false,
          props.appealStatus ?? null,
          externalId,
          props.externalRequestId ?? null,
        ],
      );
      const caseId = inserted.rows[0].id as string;

      const fieldEntries = Object.entries(row.fields).filter(([, v]) => v !== null && v !== '');
      if (fieldEntries.length) {
        // Same encryption rule as intake: a direct identifier is encrypted at
        // rest whether it arrived through the form or through a file.
        const values: unknown[] = [];
        const tuples = fieldEntries.map(([key, value], i) => {
          const encrypted = ENCRYPTED_FIELD_KEYS.has(key) && typeof value === 'string';
          values.push(
            caseId,
            key,
            encrypted ? null : JSON.stringify(value),
            encrypted ? this.crypto.encrypt(value as string) : null,
            encrypted,
          );
          const b = i * 5;
          return `($${b + 1},$${b + 2},$${b + 3}::jsonb,$${b + 4},$${b + 5})`;
        });
        await client.query(
          `INSERT INTO case_fields (case_id, field_key, value_json, value_enc, encrypted)
           VALUES ${tuples.join(',')}`,
          values,
        );
      }

      await client.query(
        `INSERT INTO case_status_history (case_id, actor_id, from_status, to_status, note, created_at)
         VALUES ($1,$2,NULL,$3,$4,$5)`,
        [
          caseId,
          actorId,
          status,
          `Imported from ${record.filename}${externalId ? ` (source id ${externalId})` : ''}`,
          createdAt,
        ],
      );

      if (policy) {
        // Thresholds are recorded as already fired so the reminder cron does
        // not send a burst of "your deadline is approaching" mail about cases
        // whose deadlines passed months ago.
        await client.query(
          `INSERT INTO sla_clocks
             (case_id, policy_id, started_at, due_at, original_due_at, state, fired_thresholds)
           VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb)`,
          [
            caseId,
            policy.id,
            createdAt,
            dueAt,
            status === 'closed' ? 'stopped' : 'running',
            JSON.stringify([0.75, 0.9, 1]),
          ],
        );
      }

      return { caseRef, duplicate: false, placeholderEmail };
    });
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async list(ctx: ZoneContext) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT i.id, i.filename, i.zone_id, i.form_key, i.status, i.total_rows,
                i.imported, i.skipped, i.failed, i.created_at, i.committed_at,
                COALESCE(i.uploaded_by_name, u.name) AS uploaded_by_name
           FROM case_imports i
      LEFT JOIN users u ON u.id = i.uploaded_by
          ORDER BY i.created_at DESC
          LIMIT 100`,
      );
      return r.rows;
    });
  }

  async detail(ctx: ZoneContext, id: string) {
    const record = await this.load(ctx, id);
    return {
      id: record.id,
      filename: record.filename,
      zoneId: record.zone_id,
      formKey: record.form_key,
      status: record.status,
      totalRows: record.total_rows,
      imported: record.imported,
      skipped: record.skipped,
      failed: record.failed,
      mapping: record.mapping,
      issues: record.issues,
      createdAt: record.created_at,
      committedAt: record.committed_at,
    };
  }

  /** Throw away an analysed file that is not going to be committed. */
  async discard(ctx: ZoneContext, id: string, actorId: string) {
    const record = await this.load(ctx, id);
    if (record.status === 'committed') {
      throw new BadRequestException('A committed import cannot be discarded');
    }
    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        `UPDATE case_imports SET status = 'discarded', payload = NULL WHERE id = $1`,
        [id],
      );
    });
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'import.discarded',
      entityType: 'case_import',
      entityId: id,
      zoneId: record.zone_id,
      after: { filename: record.filename },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private preview(
    file: ParsedFile,
    form: FormIndex,
    mapping: Record<string, string>,
    dateOrder: DateOrder,
  ) {
    const rows = file.rows.map((cells, i) =>
      coerceRow(file.headers, cells, i + 2, { dateOrder, form, mapping }),
    );
    const issues = rows.flatMap((r) => r.issues);
    return {
      rows,
      issues,
      errorRows: rows.filter((r) => r.issues.some((i) => i.severity === 'error')).length,
      samples: rows.slice(0, 10).map((r) => ({
        row: r.index,
        caseProps: r.caseProps,
        fields: r.fields,
        reportPublished: r.reportPublished,
        reportAccessed: r.reportAccessed,
        issues: r.issues,
      })),
    };
  }

  /** Which source ids are already in the database, so re-imports are visible. */
  private async findExisting(rows: CoercedRow[]): Promise<{ count: number; sample: string[] }> {
    const ids = rows
      .map((r) => r.caseProps.externalId)
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (ids.length === 0) return { count: 0, sample: [] };
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        'SELECT external_id FROM cases WHERE external_id = ANY($1::text[])',
        [ids],
      );
      return {
        count: r.rows.length,
        sample: r.rows.slice(0, 10).map((x: { external_id: string }) => x.external_id),
      };
    });
  }

  /** Portal accounts, indexed by both email and name, for the Owner column. */
  private async ownerIndex(zoneId: string): Promise<Map<string, string>> {
    return this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT id, email, name FROM users WHERE active AND (zone_id = $1 OR zone_id IS NULL)`,
        [zoneId],
      );
      const map = new Map<string, string>();
      for (const u of r.rows as { id: string; email: string; name: string }[]) {
        map.set(u.email.trim().toLowerCase(), u.id);
        map.set(u.name.trim().toLowerCase(), u.id);
      }
      return map;
    });
  }

  private matchOwner(owners: Map<string, string>, raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return owners.get(raw.trim().toLowerCase()) ?? null;
  }

  private async loadForm(formKey: string, zoneId: string) {
    const version = await this.db.system((db) =>
      db.query.formVersions.findFirst({
        where: eq(formVersions.formKey, formKey),
        orderBy: desc(formVersions.version),
      }),
    );
    if (!version) throw new BadRequestException(`Unknown form: ${formKey}`);
    if (version.zoneId !== zoneId) {
      throw new BadRequestException(`Form ${formKey} belongs to zone ${version.zoneId}, not ${zoneId}`);
    }
    return {
      form: indexForm(version.schema as never, collectInputs),
      version: version.version,
    };
  }

  /** Every place a column can go, for the mapping dropdown. */
  private targetCatalogue(form: FormIndex) {
    return {
      case: CASE_TARGETS.map((t) => ({ id: `case:${t.id}`, label: t.label, help: t.help })),
      field: [...form.keyToLabel].map(([key, label]) => ({ id: `field:${key}`, label, key })),
    };
  }

  private fileOf(record: ImportRecord): ParsedFile {
    const payload = record.payload as ParsedFile | null;
    if (!payload?.headers) {
      throw new BadRequestException('The parsed file is no longer held — upload it again');
    }
    return payload;
  }

  private async load(ctx: ZoneContext, id: string): Promise<ImportRecord> {
    const row = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query('SELECT * FROM case_imports WHERE id = $1', [id]);
      return r.rows[0];
    });
    if (!row) throw new NotFoundException();
    return row as ImportRecord;
  }

  /**
   * Imports run against the zone the operator chose. Route-level checks keep a
   * zone manager from choosing somebody else's.
   */
  private ctxFor(zoneId: string): ZoneContext {
    return { role: 'system', zone: zoneId };
  }
}

interface ImportRecord {
  id: string;
  filename: string;
  zone_id: string;
  form_key: string;
  form_version: number;
  status: string;
  total_rows: number;
  imported: number;
  skipped: number;
  failed: number;
  mapping: unknown;
  payload: unknown;
  issues: unknown;
  created_at: string;
  committed_at: string | null;
}

export type { ColumnProposal };
