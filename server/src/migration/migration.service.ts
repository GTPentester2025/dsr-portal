import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService, ZoneContext } from '../db/db.module';
import type { PoolClient } from 'pg';
import { formVersions } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { ENCRYPTED_FIELD_KEYS } from '../crypto/pii-fields';
import { collectInputs, type Component } from '../public/form-validation';
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
import { buildZoneImportSchema, canonicalJson, importFormKey } from './import-form';

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
    /** Optional override; normally worked out from the file itself. */
    formKey?: string;
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

    const { form, version, formKey, formName } = args.formKey
      ? await this.loadForm(args.formKey, args.zoneId)
      : await this.zoneImportForm(args.zoneId);
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
          formKey,
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
        formKey,
      },
      sourceIp: args.ip,
    });

    return {
      id: record.id,
      filename: args.filename,
      zoneId: args.zoneId,
      formKey,
      formName,
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
    let updated = 0;
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
        if (result.outcome === 'conflict') {
          issues.push({
            row: row.index,
            message:
              `${result.caseRef} was raised in this portal, not imported — an upload cannot ` +
              'overwrite it',
            severity: 'error',
          });
          failed++;
          continue;
        }
        if (result.outcome === 'updated') {
          issues.push({
            row: row.index,
            message: `Updated ${result.caseRef} from this upload`,
            severity: 'warning',
          });
          updated++;
          continue;
        }
        if (result.outcome === 'unchanged') {
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
                failed = $5, issues = $6, payload = NULL, committed_at = now(),
                updated = $7
          WHERE id = $1`,
        [id, JSON.stringify(mapping), imported, skipped, failed,
         JSON.stringify(issues.slice(0, 2000)), updated],
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
        updated,
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

    return {
      ok: true,
      imported,
      updated,
      skipped,
      failed,
      placeholderEmails,
      issues: issues.slice(0, 500),
    };
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
  ): Promise<{
    caseRef: string;
    outcome: 'created' | 'updated' | 'unchanged' | 'conflict';
    placeholderEmail: boolean;
  }> {
    const props = row.caseProps as Record<string, any>;
    const externalId = props.externalId ? String(props.externalId) : null;

    return this.db.system(async (db, client) => {
      // A row whose source id is already here is not a duplicate to be thrown
      // away: it is a newer copy of the same record. Re-uploading the export is
      // the only way an imported case changes — the workflow is closed to
      // them — so a second upload has to be able to move one from `open` to
      // `closed`, fill in a completion date, or correct an answer.
      //
      // Only ever an imported case. A portal case that somehow carried this id
      // is left alone and reported: an upload must not be able to overwrite a
      // request this portal actually received.
      if (externalId) {
        const seen = await client.query(
          'SELECT id, case_ref, source FROM cases WHERE external_id = $1',
          [externalId],
        );
        const existing = seen.rows[0];
        if (existing && existing.source !== 'import') {
          return {
            caseRef: existing.case_ref as string,
            outcome: 'conflict' as const,
            placeholderEmail: false,
          };
        }
        if (existing) {
          const changed = await this.updateImportedCase(client, existing.id as string, row, owners);
          return {
            caseRef: existing.case_ref as string,
            outcome: changed ? ('updated' as const) : ('unchanged' as const),
            placeholderEmail: false,
          };
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
            source, external_id, external_request_id, imported_at,
            unassigned_escalated_at, source_status, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16,$17,$18,$19,
                 $20,$21,$22,$23,'import',$24,$25,now(),now(),$26,$27)
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
          row.sourceStatus,
          // Which upload created this case, so it can be undone as a set. Set
          // only here: a later upload that updates this case corrects it, it
          // does not adopt it, and undoing the later upload must not delete a
          // case the earlier one brought in.
          record.id,
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
        // Every "somebody should look at this" marker is pre-set, so the SLA
        // sweep — which runs every minute — treats an imported backlog as
        // already handled rather than as news.
        //
        // Without this an import of open historical cases sends a burst of
        // mail within sixty seconds: reminders at each threshold, a
        // `case-escalated` for every case past its escalation fraction (all of
        // them, since the deadlines are months old), and a `case-unassigned`
        // for every case with no owner. Those go to the zone's managers, not
        // to requesters, but nobody asked for them and importing history is
        // not an event anyone needs alerting to. The cases still show as
        // overdue on the dashboard, which is where a backlog belongs.
        await client.query(
          `INSERT INTO sla_clocks
             (case_id, policy_id, started_at, due_at, original_due_at, state,
              fired_thresholds, escalated_at)
           VALUES ($1,$2,$3,$4,$4,'stopped',$5::jsonb,now())`,
          [caseId, policy.id, createdAt, dueAt, JSON.stringify([0.75, 0.9, 1])],
        );
      }

      return { caseRef, outcome: 'created', placeholderEmail };
    });
  }

  /**
   * Bring an already-imported case up to date from a newer upload.
   *
   * The only way an imported case changes. Its workflow is closed — no status
   * button, no assignment, no correspondence — because the system that is
   * actually handling it is the one the export comes from. So a second upload
   * has to be able to move a case from `open` to `closed`, fill in a
   * completion date, or correct an answer that was wrong the first time.
   *
   * Everything the file asserts is applied; everything it is silent about is
   * left alone, so a narrower export does not blank fields a wider one filled.
   * The case reference, its id and its arrival record are never touched — the
   * case is the same case.
   *
   * Returns whether anything actually changed, so an unchanged re-upload is
   * reported as skipped rather than as a stream of no-op edits.
   */
  private async updateImportedCase(
    client: PoolClient,
    caseId: string,
    row: CoercedRow,
    owners: Map<string, string>,
  ): Promise<boolean> {
    const props = row.caseProps as Record<string, any>;
    const before = (
      await client.query('SELECT * FROM cases WHERE id = $1', [caseId])
    ).rows[0];

    const closedAt = props.closedAt ? new Date(String(props.closedAt)) : null;
    const dueAt = props.dueAt ? new Date(String(props.dueAt)) : null;
    const ownerId = this.matchOwner(owners, props.assigneeEmail);

    // COALESCE on the parameter, not the column: a null here means the file
    // said nothing, which must not erase what an earlier upload established.
    const res = await client.query(
      `UPDATE cases SET
         status = COALESCE($2, status),
         closed_at = COALESCE($3, closed_at),
         due_at = COALESCE($4, due_at),
         residency = COALESCE($5, residency),
         assignee_id = COALESCE($6, assignee_id),
         completed_after_deadline = COALESCE($7, completed_after_deadline),
         auto_extended = COALESCE($8, auto_extended),
         skip_completion_notification = COALESCE($9, skip_completion_notification),
         can_be_appealed = COALESCE($10, can_be_appealed),
         can_appeal_until = COALESCE($11, can_appeal_until),
         is_appeal = COALESCE($12, is_appeal),
         appeal_status = COALESCE($13, appeal_status),
         external_request_id = COALESCE($14, external_request_id),
         source_status = COALESCE($17, source_status),
         report_published_at = CASE WHEN $15::boolean
           THEN COALESCE(report_published_at, COALESCE($3, now())) ELSE report_published_at END,
         report_accessed_at = CASE WHEN $16::boolean
           THEN COALESCE(report_accessed_at, COALESCE($3, now())) ELSE report_accessed_at END,
         updated_at = now(),
         imported_at = now()
       WHERE id = $1 AND source = 'import'
       RETURNING status, closed_at, due_at, residency, assignee_id,
                 completed_after_deadline, appeal_status, report_published_at`,
      [
        caseId,
        props.status ?? null,
        closedAt,
        dueAt,
        props.residency ?? null,
        ownerId,
        props.completedAfterDeadline ?? (closedAt && dueAt ? closedAt > dueAt : null),
        props.autoExtended ?? null,
        props.skipCompletionNotification ?? null,
        props.canBeAppealed ?? null,
        props.canAppealUntil ? new Date(String(props.canAppealUntil)) : null,
        props.isAppeal ?? null,
        props.appealStatus ?? null,
        props.externalRequestId ?? null,
        row.reportPublished,
        row.reportAccessed,
        row.sourceStatus,
      ],
    );
    const after = res.rows[0];

    // Answers are replaced key by key rather than wholesale: the upload may
    // carry fewer columns than the one before it, and dropping the rest would
    // lose detail this record is the only copy of.
    let fieldsChanged = false;
    for (const [key, value] of Object.entries(row.fields)) {
      if (value === null || value === '') continue;
      const encrypted = ENCRYPTED_FIELD_KEYS.has(key) && typeof value === 'string';
      const existing = await client.query(
        'SELECT value_json, value_enc FROM case_fields WHERE case_id = $1 AND field_key = $2',
        [caseId, key],
      );
      const current = existing.rows[0];
      if (current) {
        // Encrypted values re-encrypt to different ciphertext every time, so
        // they are compared decrypted; anything else would report a change on
        // every upload.
        const same = encrypted
          ? this.safeDecrypt(current.value_enc) === value
          : JSON.stringify(current.value_json) === JSON.stringify(value);
        if (same) continue;
      }
      await client.query(
        `INSERT INTO case_fields (case_id, field_key, value_json, value_enc, encrypted)
         VALUES ($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (case_id, field_key) DO UPDATE SET
           value_json = EXCLUDED.value_json,
           value_enc = EXCLUDED.value_enc,
           encrypted = EXCLUDED.encrypted`,
        [
          caseId,
          key,
          encrypted ? null : JSON.stringify(value),
          encrypted ? this.crypto.encrypt(value as string) : null,
          encrypted,
        ],
      );
      fieldsChanged = true;
    }

    const caseChanged =
      String(before.status) !== String(after.status) ||
      String(before.closed_at) !== String(after.closed_at) ||
      String(before.due_at) !== String(after.due_at) ||
      String(before.residency) !== String(after.residency) ||
      String(before.assignee_id) !== String(after.assignee_id) ||
      String(before.appeal_status) !== String(after.appeal_status) ||
      String(before.report_published_at) !== String(after.report_published_at);

    if (!caseChanged && !fieldsChanged) return false;

    // The SLA clock follows the status, so a case the upload closes stops
    // being counted as outstanding.
    if (after.status === 'closed') {
      await client.query(
        `UPDATE sla_clocks SET state = 'stopped' WHERE case_id = $1 AND state <> 'stopped'`,
        [caseId],
      );
    }

    await client.query(
      `INSERT INTO case_status_history (case_id, from_status, to_status, note)
       VALUES ($1, $2, $3, $4)`,
      [
        caseId,
        before.status,
        after.status,
        before.status === after.status
          ? 'Updated by a later upload'
          : `Updated by a later upload: ${before.status} to ${after.status}`,
      ],
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async list(ctx: ZoneContext) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT i.id, i.filename, i.zone_id, i.form_key, i.status, i.total_rows,
                i.imported, i.updated, i.skipped, i.failed, i.created_at, i.committed_at,
                i.undoable, i.undone_at, i.undone_by_name,
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

  /** An unreadable value must not fail an upload; it just counts as changed. */
  private safeDecrypt(value: string | null): string | null {
    if (!value) return null;
    try {
      return this.crypto.decrypt(value);
    } catch {
      return null;
    }
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

  private async loadForm(formKey: string, zoneId: string): Promise<LoadedForm> {
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
    const schema = version.schema as { name?: string };
    return {
      form: indexForm(version.schema as never, collectInputs),
      version: version.version,
      formKey,
      formName: schema?.name ?? formKey,
    };
  }

  /**
   * The form imported cases are recorded against, published on demand.
   *
   * Not one of the zone's country forms: within a zone they are
   * field-identical down to the wording of the request types, so nothing in a
   * CSV says whether a case is Brazilian or Argentine, and stamping every
   * imported case with a country it may not be from would put a false fact on
   * a compliance record. The zone gets one form of its own instead, the union
   * of what its country forms collect.
   *
   * Republished only when the union actually changes, so re-importing does not
   * pile up versions.
   */
  private async zoneImportForm(zoneId: string): Promise<LoadedForm> {
    const formKey = importFormKey(zoneId);
    const sources = await this.db.system(async (_db, client) => {
      const r = await client.query(
        `SELECT DISTINCT ON (form_key) form_key, schema
           FROM form_versions
          WHERE zone_id = $1 AND form_key <> $2
          ORDER BY form_key, version DESC`,
        [zoneId, formKey],
      );
      return r.rows as { form_key: string; schema: { components?: Component[] } }[];
    });
    if (sources.length === 0) {
      throw new BadRequestException(`No forms are published for zone ${zoneId}`);
    }

    const schema = buildZoneImportSchema(
      zoneId,
      sources.map((r) => ({ formKey: r.form_key, schema: r.schema })),
      collectInputs,
    );

    const version = await this.db.system(async (_db, client) => {
      const current = await client.query(
        `SELECT version, schema FROM form_versions
          WHERE form_key = $1 ORDER BY version DESC LIMIT 1`,
        [formKey],
      );
      const latest = current.rows[0];
      // Canonical on both sides: jsonb hands the schema back with its own key
      // order, so a plain stringify comparison never matches and every import
      // would publish another version of an unchanged schema.
      if (latest && canonicalJson(latest.schema) === canonicalJson(schema)) {
        return latest.version as number;
      }
      const next = latest ? Number(latest.version) + 1 : 1;
      await client.query(
        `INSERT INTO form_versions (form_key, zone_id, version, schema)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (form_key, version) DO NOTHING`,
        [formKey, zoneId, next, JSON.stringify(schema)],
      );
      return next;
    });

    return {
      form: indexForm(schema as never, collectInputs),
      version,
      formKey,
      formName: schema.name,
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

/** A form resolved for an import, and how sure we are it is the right one. */
interface LoadedForm {
  form: FormIndex;
  version: number;
  formKey: string;
  formName: string;
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
