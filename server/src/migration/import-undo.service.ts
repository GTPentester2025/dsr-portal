import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { access } from 'node:fs/promises';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../cases/storage.service';
import { CASE_OWNED_TABLES } from '../cases/case-deletion.service';

/**
 * Reversing an upload.
 *
 * An import is the one operation in this portal that creates thousands of
 * cases from a single click, so it is also the one whose mistakes arrive
 * thousands at a time: the wrong file, the wrong zone, a date order that read
 * every arrival date backwards. Undoing that by hand is not a real option, and
 * an import nobody can reverse is an import nobody dares run.
 *
 * Three properties define what this can honestly promise.
 *
 * **It removes what the upload created, and only that.** Cases carry the id of
 * the upload that made them. A later upload correcting an earlier one does not
 * take ownership of those cases, so undoing the correction never deletes the
 * original import's work.
 *
 * **It cannot revert an overwrite.** Where an upload updated a case an earlier
 * upload had created, the previous values are gone — nothing snapshots them.
 * Undo says so, with a count, before and after. Refusing outright would make
 * undo useless for the ordinary case of re-uploading a whole export; pretending
 * otherwise would be worse.
 *
 * **The audit trail survives, and carries the list.** Once the cases are gone,
 * the audit entry is the only remaining record that they existed, so it holds
 * every reference — not a sample. `import.committed` can summarise with a first
 * and last reference because its cases are still there to query. This cannot.
 */

export interface ImportUndoSummary {
  filename: string;
  /** Cases created by this upload and now deleted. */
  casesDeleted: number;
  /** Row counts per owned table, so the audit entry says what actually went. */
  removed: Record<string, number>;
  /**
   * Cases this upload overwrote rather than created. Left in place with the
   * uploaded values, because the values they had before were not kept.
   */
  updatedNotReverted: number;
  filesRemoved: number;
  filesMissing: number;
  /** Files still on disk after the rows naming them were destroyed. */
  filesFailed: number;
}

@Injectable()
export class ImportUndoService {
  private readonly log = new Logger(ImportUndoService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async undo(
    ctx: ZoneContext,
    id: string,
    args: { reason: string; actorId: string; actorName?: string | null; ip?: string },
  ): Promise<ImportUndoSummary> {
    const reason = args.reason?.trim();
    if (!reason) {
      throw new BadRequestException('Undoing an import needs a reason, recorded in the audit log');
    }
    if (reason.length < 10) {
      throw new BadRequestException(
        'Give a reason somebody reading the audit log in a year will understand',
      );
    }

    // Row-level security decides visibility, so an import belonging to another
    // zone is a 404 here exactly as it is everywhere else.
    const record = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT id, filename, zone_id, status, undoable, imported, updated
           FROM case_imports WHERE id = $1`,
        [id],
      );
      return r.rows[0] as
        | {
            id: string;
            filename: string;
            zone_id: string;
            status: string;
            undoable: boolean;
            imported: number;
            updated: number;
          }
        | undefined;
    });
    if (!record) throw new NotFoundException();

    if (record.status === 'undone') {
      throw new BadRequestException('This import has already been undone');
    }
    if (record.status !== 'committed') {
      throw new BadRequestException(
        `Only a committed import can be undone; this one is ${record.status}. ` +
          'An import that was never committed wrote no cases.',
      );
    }
    // The refusal that matters most. Before provenance existed, nothing
    // recorded which cases an upload created — so an undo would match nothing,
    // delete nothing, and report success, leaving the operator believing the
    // import had been reversed.
    if (!record.undoable) {
      throw new BadRequestException(
        `${record.filename} was imported before the portal recorded which cases came ` +
          'from which upload, so its cases cannot be identified. They have to be ' +
          'found and deleted individually.',
      );
    }

    const cases = await this.db.system(async (_db, client) => {
      const r = await client.query(
        // `source` as well as `import_id`: the column is immutable by trigger,
        // so this can only ever narrow, and it makes the intent unambiguous —
        // an undo never touches a case this portal actually received.
        `SELECT id, case_ref FROM cases WHERE import_id = $1 AND source = 'import'
          ORDER BY case_ref`,
        [id],
      );
      return r.rows as { id: string; case_ref: string }[];
    });
    const caseIds = cases.map((c) => c.id);
    const caseRefs = cases.map((c) => c.case_ref);

    // An appeal is a case raised in this portal against an imported decision.
    // Deleting the decision would leave the appeal referring to nothing, and
    // the appeal is a live request somebody is owed an answer to. Refused,
    // naming what is in the way.
    if (caseIds.length > 0) {
      const appeals = await this.db.system(async (_db, client) => {
        const r = await client.query(
          `SELECT a.case_ref FROM cases a
            WHERE a.appeal_of_case_id = ANY($1::uuid[]) ORDER BY a.case_ref LIMIT 20`,
          [caseIds],
        );
        return r.rows.map((x: { case_ref: string }) => x.case_ref);
      });
      if (appeals.length > 0) {
        throw new BadRequestException(
          `Cases from this import have been appealed (${appeals.join(', ')}). ` +
            'Delete or resolve those appeals first.',
        );
      }
    }

    // Read the storage keys before the rows go: afterwards nothing is left to
    // say which files belonged to these cases.
    const files =
      caseIds.length === 0
        ? []
        : await this.db.system(async (_db, client) => {
            const r = await client.query(
              'SELECT storage_key FROM case_attachments WHERE case_id = ANY($1::uuid[])',
              [caseIds],
            );
            return r.rows.map((x: { storage_key: string }) => x.storage_key);
          });

    // One transaction for the whole set. A half-undone import — some cases
    // gone, some left, and nothing on the outside to say which — is worse than
    // either end state.
    const removed = await this.db.system(async (_db, client) => {
      const counts: Record<string, number> = {};
      for (const table of CASE_OWNED_TABLES) {
        const r =
          caseIds.length === 0
            ? { rowCount: 0 }
            : await client.query(`DELETE FROM ${table} WHERE case_id = ANY($1::uuid[])`, [caseIds]);
        counts[table] = r.rowCount ?? 0;
      }
      const c =
        caseIds.length === 0
          ? { rowCount: 0 }
          : await client.query('DELETE FROM cases WHERE id = ANY($1::uuid[])', [caseIds]);
      counts.cases = c.rowCount ?? 0;

      await client.query(
        `UPDATE case_imports
            SET status = 'undone', undone_at = now(), undone_by = $2, undone_by_name = $3
          WHERE id = $1`,
        [id, args.actorId, args.actorName ?? null],
      );
      return counts;
    });

    // Files after the commit, deliberately. A failed transaction leaving rows
    // that point at real files is recoverable; rows gone with files orphaned is
    // the state nobody finds until somebody audits the storage directory.
    //
    // Counted by looking, not by asking. `StorageService.remove` treats a
    // failure as "already gone", which is right for its own callers and wrong
    // here, where the count is evidence in an audit entry.
    let filesRemoved = 0;
    let filesMissing = 0;
    let filesFailed = 0;
    for (const key of files) {
      if (!(await this.onDisk(key))) {
        filesMissing++;
        continue;
      }
      await this.storage.remove(key);
      if (await this.onDisk(key)) {
        filesFailed++;
        this.log.error(
          `import ${id}: ${key} is still on disk after undo — the rows naming it are ` +
            'gone, so it must be removed by hand',
        );
      } else {
        filesRemoved++;
      }
    }

    // The full list, not a sample. These references are about to stop existing
    // anywhere else, and an investigation asking what DSR-SAZ-2024-00312 was
    // has only this entry left to answer from. No requester identifiers: the
    // cases have just been deleted, and writing those people's addresses into
    // an append-only table as part of removing them would defeat that.
    await this.audit.record({
      actorId: args.actorId,
      actorName: args.actorName ?? null,
      actorType: 'user',
      action: 'import.undone',
      entityType: 'case_import',
      entityId: id,
      zoneId: record.zone_id,
      before: { filename: record.filename, imported: record.imported, updated: record.updated },
      after: {
        reason,
        casesDeleted: caseIds.length,
        removed,
        updatedNotReverted: record.updated ?? 0,
        filesRemoved,
        filesMissing,
        filesFailed,
        caseRefs,
      },
      sourceIp: args.ip,
    });

    this.log.log(
      `import ${id} (${record.filename}) undone by ${args.actorId}: ` +
        `${caseIds.length} cases, ${filesRemoved} files`,
    );

    return {
      filename: record.filename,
      casesDeleted: caseIds.length,
      removed,
      updatedNotReverted: record.updated ?? 0,
      filesRemoved,
      filesMissing,
      filesFailed,
    };
  }

  /** Whether the stored file is actually there. */
  private async onDisk(storageKey: string): Promise<boolean> {
    try {
      await access(this.storage.pathFor(storageKey));
      return true;
    } catch {
      return false;
    }
  }
}
