import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, ZoneContext } from '../db/db.module';

/**
 * The line between a case this portal is handling and a case it is merely
 * holding.
 *
 * A case imported from another tool is a **record of something that already
 * happened somewhere else**. It was received, worked and answered by a
 * different system, possibly years ago, and the person who raised it has had
 * their reply. The portal's job for these is to keep them findable,
 * exportable and auditable — not to work them.
 *
 * That distinction has to be enforced at the server, not in the console.
 * Hiding a button stops the honest mistake; it does not stop a stale tab, a
 * script, or a future screen that forgets. The one fact everything keys off is
 * `cases.source`, written once at creation and never edited.
 *
 * What an archive record refuses:
 *
 * - **Correspondence.** Nothing is ever sent about one. Writing to somebody
 *   about a request they made years ago, answered by a system that no longer
 *   runs, is the failure mode this whole boundary exists to prevent.
 * - **Workflow.** Status, assignment, the SLA clock, report delivery,
 *   appeals. Its history is what the other tool recorded; re-litigating it here
 *   would produce a timeline that never happened.
 * - **Evidence.** No new attachments: the file record belongs to the source
 *   system.
 *
 * What it still allows: reading, searching, exporting, the audit trail, and
 * being **corrected by a later upload** — a re-import is how an imported case
 * changes, because that is the same route the record arrived by.
 */

/** Cases created here, through the public form. Everything is permitted. */
export const SOURCE_PORTAL = 'portal';
/** Cases brought in from another tool. Read, export, re-import. */
export const SOURCE_IMPORT = 'import';

export interface CaseSource {
  id: string;
  caseRef: string;
  zoneId: string;
  source: string;
  status: string;
}

@Injectable()
export class CaseSourceGuard {
  constructor(private readonly db: DbService) {}

  /**
   * Load a case and refuse it if it is an archive record.
   *
   * `action` is a phrase that completes "cannot be …", so the refusal names
   * the thing that was attempted rather than a rule number. Row-level security
   * decides visibility first, so a case in another zone is a 404 here, exactly
   * as it is everywhere else.
   */
  async assertLive(ctx: ZoneContext, caseId: string, action: string): Promise<CaseSource> {
    const row = await this.load(ctx, caseId);
    if (row.source === SOURCE_IMPORT) {
      throw new ForbiddenException(
        `${row.caseRef} was imported from another system and is kept as a record only, so it ` +
          `cannot be ${action}. Upload a corrected export to change it.`,
      );
    }
    return row;
  }

  async load(ctx: ZoneContext, caseId: string): Promise<CaseSource> {
    const row = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        'SELECT id, case_ref, zone_id, source, status FROM cases WHERE id = $1',
        [caseId],
      );
      return r.rows[0] as
        | { id: string; case_ref: string; zone_id: string; source: string; status: string }
        | undefined;
    });
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      caseRef: row.case_ref,
      zoneId: row.zone_id,
      source: row.source ?? SOURCE_PORTAL,
      status: row.status,
    };
  }
}
