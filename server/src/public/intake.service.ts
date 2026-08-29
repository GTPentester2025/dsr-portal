import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.module';
import {
  caseFields,
  caseStatusHistory,
  cases,
  emailLog,
  formVersions,
  slaClocks,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';
import { validateSubmission, type FormSchemaDoc } from './form-validation';
import { VerificationService } from './verification.service';
import { AssignmentService } from '../cases/assignment.service';
import { StorageService } from '../cases/storage.service';

/** Direct identifiers stored envelope-encrypted (spec §9). */
const ENCRYPTED_FIELD_KEYS = new Set([
  'email', 'first_name', 'last_name', 'name', 'full_name', 'phone',
  'phone_number', 'telephone', 'id_number', 'document_number', 'dni',
  'address', 'address1', 'address2',
]);

@Injectable()
export class IntakeService {
  private readonly log = new Logger(IntakeService.name);

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly verification: VerificationService,
    private readonly assignment: AssignmentService,
    private readonly storage: StorageService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async submit(args: {
    draftId: string;
    sessionId: string;
    formKey: string;
    values: Record<string, unknown>;
    ip: string;
    /** Language the form was completed in, used for the reply. */
    language?: string;
  }): Promise<{ caseRef: string }> {
    // 1. Load the current stored schema version for this form.
    const formVersion = await this.db.system((db) =>
      db.query.formVersions.findFirst({
        where: eq(formVersions.formKey, args.formKey),
        orderBy: desc(formVersions.version),
      }),
    );
    if (!formVersion) throw new BadRequestException('Unknown form');
    const schema = formVersion.schema as unknown as FormSchemaDoc & {
      emailVerification?: { enabled: boolean };
    };

    // 2. Server-side validation and canonicalisation of every field.
    const { values, issues } = validateSubmission(
      { key: args.formKey, zone: formVersion.zoneId, components: schema.components },
      args.values,
    );
    if (issues.length) {
      throw new BadRequestException({ message: 'Validation failed', issues });
    }

    // 3. The submitted email must match the verified session email.
    const submittedEmail = String(values['email'] ?? '').trim().toLowerCase();
    if (!submittedEmail) throw new BadRequestException('Email is required');
    const verified = await this.verification.requireVerified(
      args.draftId,
      args.sessionId,
      submittedEmail,
    );
    if (!verified) {
      throw new BadRequestException(
        'Email address has not been verified for this session',
      );
    }

    // 4. Persist atomically: sequence, case, fields, history, SLA clock.
    const zone = formVersion.zoneId;
    const year = new Date().getFullYear();
    const requestTypes = this.extractRequestTypes(values);

    const { caseRef, caseId, dueAt } = await this.db.system(async (db, client) => {
      const seqRes = await client.query(
        `INSERT INTO case_sequences (zone_id, year, last_seq) VALUES ($1, $2, 1)
         ON CONFLICT (zone_id, year) DO UPDATE SET last_seq = case_sequences.last_seq + 1
         RETURNING last_seq`,
        [zone, year],
      );
      const seq = Number(seqRes.rows[0].last_seq);
      const ref = `DSR-${zone}-${year}-${String(seq).padStart(5, '0')}`;

      // Pick the policy for this request type, falling back to the zone's '*'
      // row. Matching on zone alone would return an arbitrary row, which made
      // every per-request-type policy in the SLA matrix silently inert.
      const policyRes = await client.query(
        `SELECT id, target_minutes
           FROM sla_policies
          WHERE zone_id = $1
            AND (request_type = ANY($2::text[]) OR request_type = '*')
          ORDER BY (request_type = '*') ASC
          LIMIT 1`,
        [zone, requestTypes.length ? requestTypes : ['*']],
      );
      const policy = policyRes.rows[0] ?? null;
      const targetMinutes = Number(policy?.target_minutes ?? 30 * 1440);
      const due = new Date(Date.now() + targetMinutes * 60_000);

      const [caseRow] = await db
        .insert(cases)
        .values({
          caseRef: ref,
          zoneId: zone,
          formKey: args.formKey,
          formVersion: formVersion.version,
          requestTypes,
          requesterEmailEnc: this.crypto.encrypt(submittedEmail),
          requesterEmailHmac: this.crypto.lookupHmac(submittedEmail),
          requesterNameEnc: this.buildNameEnc(values),
          status: 'new',
          dueAt: due,
        })
        .returning({ id: cases.id });

      const fieldRows = Object.entries(values).map(([fieldKey, value]) => {
        const encrypted = ENCRYPTED_FIELD_KEYS.has(fieldKey) && typeof value === 'string';
        return {
          caseId: caseRow.id,
          fieldKey,
          valueJson: encrypted ? null : value,
          valueEnc: encrypted ? this.crypto.encrypt(value as string) : null,
          encrypted,
        };
      });
      if (fieldRows.length) await db.insert(caseFields).values(fieldRows);

      await db.insert(caseStatusHistory).values({
        caseId: caseRow.id,
        toStatus: 'new',
        note: 'Submitted via public form',
      });

      if (policy) {
        await db.insert(slaClocks).values({
          caseId: caseRow.id,
          policyId: policy.id,
          startedAt: new Date(),
          dueAt: due,
          originalDueAt: due,
        });
      }
      return { caseRef: ref, caseId: caseRow.id, dueAt: due };
    });

    await this.audit.record({
      actorType: 'public',
      action: 'case.created',
      entityType: 'case',
      entityId: caseId,
      zoneId: zone,
      after: { caseRef, formKey: args.formKey, requestTypes },
      sourceIp: args.ip,
    });

    // 5. Adopt the draft's files: re-point the rows and move them from the
    //    holding directory into <zone>/<case-ref>, so a case's evidence lives
    //    with the case rather than under an id nobody can read.
    try {
      await this.adoptAttachments(args.draftId, caseId, zone, caseRef);
    } catch (err) {
      // A submission must not fail because a file could not be moved; the row
      // still points at the original location either way.
      this.log.error(`attachment adoption failed for ${caseRef}: ${(err as Error).message}`);
    }

    // 6. Acknowledgement email — failure logged, never blocks the submission.
    await this.sendAck(caseId, submittedEmail, caseRef, zone, dueAt, args.language ?? 'en');

    // 7. Tell the zone. Every approver owns every case in their zone, and the
    //    zone's managers are copied on the same message, so nothing depends on
    //    a case having been routed to a particular person.
    try {
      await this.assignment.notifyZone(caseId);
    } catch (err) {
      this.log.error(`zone notification failed for ${caseRef}: ${(err as Error).message}`);
    }

    // 8. Route it. This was never called, so the assignment strategy each zone
    //    had configured never ran and every case stayed `new` until it aged
    //    into `overdue`. Under the `manual` strategy — or with nobody
    //    assignable — this still moves the case into the queue as `open`.
    try {
      await this.assignment.autoAssign(caseId);
    } catch (err) {
      this.log.error(`auto-assignment failed for ${caseRef}: ${(err as Error).message}`);
    }

    return { caseRef };
  }

  /**
   * Move a draft's uploads under the new case reference.
   *
   * The database row is updated first: if the copy then fails, the record still
   * points at a file that exists, which is the safer of the two failure modes.
   */
  private async adoptAttachments(
    draftId: string,
    caseId: string,
    zoneId: string,
    caseRef: string,
  ): Promise<void> {
    const rows = await this.db.system(async (_db, client) => {
      const r = await client.query(
        'SELECT id, storage_key, filename FROM case_attachments WHERE draft_id = $1',
        [draftId],
      );
      return r.rows as { id: string; storage_key: string; filename: string }[];
    });
    if (rows.length === 0) return;

    for (const row of rows) {
      const moved = await this.storage.relocate(row.storage_key, zoneId, caseRef);
      await this.db.system(async (_db, client) => {
        await client.query(
          `UPDATE case_attachments
              SET case_id = $2, zone_id = $3, case_ref = $4, storage_key = $5, draft_id = NULL
            WHERE id = $1`,
          [row.id, caseId, zoneId, caseRef, moved],
        );
      });
    }
    this.log.log(`${caseRef}: adopted ${rows.length} attachment(s)`);
  }

  private extractRequestTypes(values: Record<string, unknown>): string[] {
    const raw = values['ticket_type'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.keys(raw as Record<string, boolean>);
    }
    if (typeof raw === 'string' && raw) return [raw];
    return [];
  }

  private buildNameEnc(values: Record<string, unknown>): string | null {
    const name = [values['first_name'], values['last_name']]
      .filter((v) => typeof v === 'string' && v)
      .join(' ');
    return name ? this.crypto.encrypt(name) : null;
  }

  private async sendAck(
    caseId: string,
    to: string,
    caseRef: string,
    zone: string,
    dueAt: Date,
    language: string,
  ): Promise<void> {
    const slaStatement = `Under the applicable data protection law for your region, we aim to respond by ${dueAt.toISOString().slice(0, 10)}.`;
    try {
      const result = await this.email.sendTransactional(to, 'submission-ack', {
        case_ref: caseRef,
        sla_statement: slaStatement,
      }, { language });
      await this.logEmail(caseId, to, caseRef, 'sent', result.providerMessageId, null, result);
    } catch (err) {
      this.log.error(`ack email failed for ${caseRef}: ${(err as Error).message}`);
      await this.logEmail(caseId, to, caseRef, 'failed', null, (err as Error).message);
    }
  }

  private async logEmail(
    caseId: string,
    to: string,
    caseRef: string,
    status: 'sent' | 'failed',
    providerMessageId: string | null,
    error: string | null,
    /** What the provider actually rendered, so the case Activity can replay
        the acknowledgement rather than only naming it. */
    sent?: { subject?: string; html?: string },
  ): Promise<void> {
    await this.db.system((db) =>
      db.insert(emailLog).values({
        caseId,
        provider: this.email.activeName(),
        fromAddr: 'transactional',
        toAddrs: [to],
        subject: sent?.subject ?? `Your privacy request ${caseRef} has been received`,
        bodyHtml: sent?.html,
        templateId: 'submission-ack',
        status,
        providerMessageId,
        error,
      }),
    );
  }
}
