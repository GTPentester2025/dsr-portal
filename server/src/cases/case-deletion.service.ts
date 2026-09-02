import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { access } from 'node:fs/promises';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { StorageService } from './storage.service';

/**
 * Destroying a case and everything hanging off it.
 *
 * The portal deliberately has no automatic case retention — `housekeeping.service.ts`
 * says why: how long a data subject request must be kept is a period agreed
 * with Legal per zone, and inventing one would be worse than leaving the gap
 * visible. This is the other thing: a named person deciding that a particular
 * case should not exist, usually because it was a test, a duplicate, or opened
 * in error.
 *
 * Two properties matter more than the deletion itself.
 *
 * **The audit trail survives.** `audit_log.entity_id` is plain text with no
 * foreign key, so every entry about this case outlives it by construction.
 * That is the point: the record that a request was received, worked and then
 * deleted is what an investigation needs, and it is the one thing a delete
 * button must not be able to remove.
 *
 * **The files go too.** An identity document is the most sensitive thing this
 * system holds. Deleting the row that points at it while leaving it on disk
 * would be a deletion in name only — and the kind that is discovered later by
 * somebody auditing the storage directory rather than the database.
 */

/** Every table that holds rows belonging to a case, in foreign-key-safe order. */
const CASE_OWNED_TABLES = [
  'case_fields',
  'case_status_history',
  'case_comments',
  'sla_clocks',
  'email_log',
  'case_delegations',
  'case_attachments',
] as const;

export interface CaseDeletionSummary {
  caseRef: string;
  /** Row counts per table, so the audit entry says what was actually removed. */
  removed: Record<string, number>;
  /** Files that were on disk and are now gone. */
  filesRemoved: number;
  /** Files the database knew about that were already absent. */
  filesMissing: number;
  /**
   * Files that were on disk and still are.
   *
   * Reported rather than swallowed. `StorageService.remove` treats a failure
   * as "already gone", which is right for its own callers and wrong here: the
   * rows pointing at these files have just been destroyed, so nothing is left
   * to say what they are. An identity document nobody can account for is the
   * one outcome of this operation that has to be visible.
   */
  filesFailed: number;
}

@Injectable()
export class CaseDeletionService {
  private readonly log = new Logger(CaseDeletionService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Delete one case.
   *
   * `reason` is required and is not decoration: a deleted request is a hole in
   * a compliance record, and the only thing that makes it explicable later is
   * somebody having said at the time why it was made.
   */
  async purge(
    ctx: ZoneContext,
    caseId: string,
    args: { reason: string; actorId: string; ip?: string },
  ): Promise<CaseDeletionSummary> {
    const reason = args.reason?.trim();
    if (!reason) {
      throw new BadRequestException('Deleting a case needs a reason, recorded in the audit log');
    }
    if (reason.length < 10) {
      throw new BadRequestException(
        'Give a reason somebody reading the audit log in a year will understand',
      );
    }

    // Row-level security decides visibility, so a case in another zone is a
    // 404 here exactly as it is everywhere else.
    const target = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        'SELECT id, case_ref, zone_id, status, source FROM cases WHERE id = $1',
        [caseId],
      );
      return r.rows[0] as
        | { id: string; case_ref: string; zone_id: string; status: string; source: string }
        | undefined;
    });
    if (!target) throw new NotFoundException();

    // An appeal is a separate case that points at this one. Deleting the
    // original would leave the appeal referring to something that no longer
    // exists, and an appeal without the decision it appeals is not a record of
    // anything. Refused, naming the appeal, so the operator can decide.
    const appeals = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        'SELECT case_ref FROM cases WHERE appeal_of_case_id = $1',
        [caseId],
      );
      return r.rows.map((x: { case_ref: string }) => x.case_ref);
    });
    if (appeals.length > 0) {
      throw new BadRequestException(
        `${target.case_ref} has been appealed as ${appeals.join(', ')}. ` +
          'Delete the appeal first, or keep both.',
      );
    }

    // Read the storage keys before the rows go: afterwards there is nothing
    // left to say which files belonged to this case.
    const files = await this.db.system(async (_db, client) => {
      const r = await client.query(
        'SELECT storage_key FROM case_attachments WHERE case_id = $1',
        [caseId],
      );
      return r.rows.map((x: { storage_key: string }) => x.storage_key);
    });

    // One transaction: a half-deleted case is worse than either outcome.
    const removed = await this.db.system(async (_db, client) => {
      const counts: Record<string, number> = {};
      for (const table of CASE_OWNED_TABLES) {
        const r = await client.query(`DELETE FROM ${table} WHERE case_id = $1`, [caseId]);
        counts[table] = r.rowCount ?? 0;
      }
      const c = await client.query('DELETE FROM cases WHERE id = $1', [caseId]);
      counts.cases = c.rowCount ?? 0;
      return counts;
    });

    // Files after the commit, deliberately. If the transaction had failed we
    // would still hold rows pointing at files that exist; the reverse — rows
    // gone, files orphaned — is the state nobody discovers until an audit.
    //
    // Counted by looking, not by asking. `StorageService.remove` swallows its
    // errors on the reasoning that a file already gone is the desired end
    // state — true for its other callers, and misleading here, where the count
    // goes into an audit entry as evidence of what was destroyed. Reporting a
    // file as removed while it sits on disk is worse than reporting nothing.
    let filesRemoved = 0;
    let filesMissing = 0;
    let filesFailed = 0;
    for (const key of files) {
      const existedBefore = await this.onDisk(key);
      if (!existedBefore) {
        filesMissing++;
        continue;
      }
      await this.storage.remove(key);
      if (await this.onDisk(key)) {
        filesFailed++;
        this.log.error(
          `${target.case_ref}: ${key} is still on disk after deletion — the rows ` +
            'pointing at it are gone, so it must be removed by hand',
        );
      } else {
        filesRemoved++;
      }
    }

    // Deliberately no requester identifiers here. The case has just been
    // deleted; writing the person's address into a permanent, append-only
    // table as part of deleting them would defeat the deletion. The reference
    // ties this entry to the case's earlier audit entries, which is what an
    // investigation follows.
    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'case.deleted',
      entityType: 'case',
      entityId: caseId,
      zoneId: target.zone_id,
      before: { caseRef: target.case_ref, status: target.status, source: target.source },
      after: { reason, removed, filesRemoved, filesMissing, filesFailed },
      sourceIp: args.ip,
    });

    this.log.log(
      `${target.case_ref} deleted by ${args.actorId}: ` +
        `${Object.values(removed).reduce((a, b) => a + b, 0)} rows, ${filesRemoved} files`,
    );

    return {
      caseRef: target.case_ref,
      removed,
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
