import { Body, Controller, Delete, Get, Ip, Logger, Param, ParseUUIDPipe, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { Response } from 'express';
import { csvFilename, type CsvColumn } from './csv';
import { streamCsv } from './csv-stream';
import { CasePdfService } from './case-pdf.service';
import type { AuthedRequest } from '../auth/auth.guard';
import { CasesService, type CaseExportRow } from './cases.service';
import { CaseDeletionService } from './case-deletion.service';
import { AuditService } from '../audit/audit.service';

/**
 * Booleans read as TRUE/FALSE in the tool this export has to interoperate
 * with, and null means "not applicable" rather than "no" — a case that is
 * still open has no answer yet to whether it finished late.
 */
function yesNo(value: boolean | null | undefined): string {
  return value === null || value === undefined ? '' : value ? 'TRUE' : 'FALSE';
}

@Controller('internal/cases')
@UseGuards(AuthGuard)
export class CasesController {
  private readonly log = new Logger(CasesController.name);

  constructor(
    private readonly cases: CasesService,
    private readonly audit: AuditService,
    private readonly casePdf: CasePdfService,
    private readonly deletion: CaseDeletionService,
  ) {}

  /**
   * Destroy a case and everything belonging to it — fields, timeline,
   * comments, correspondence, delegations, its SLA clock, and the attachment
   * files on disk.
   *
   * The audit trail is untouched by design: `audit_log.entity_id` carries no
   * foreign key, so every entry about this case outlives it. The record that a
   * request existed and was deleted is exactly what an investigation needs,
   * and is the one thing this must not be able to remove.
   *
   * `cases.administer`, not `cases.work`: deciding an outcome and erasing the
   * evidence that a decision was made are different trusts.
   */
  @Delete(':id')
  @Requires('cases.administer')
  deleteCase(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
    @Ip() ip: string,
  ) {
    return this.deletion.purge(req.zoneCtx, id, {
      reason: body?.reason ?? '',
      actorId: req.user.id,
      ip,
    });
  }

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('zone') zone?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('slaState') slaState?: string,
    @Query('requestType') requestType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cases.list(req.zoneCtx, {
      status,
      zone,
      assigneeId,
      slaState,
      requestType,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /**
   * The current view as a spreadsheet. Takes the same filters as the list so
   * the download matches what is on screen; row-level security still applies,
   * so an approver exports only their own zone.
   *
   * Written to the response as it is read. The previous version built the
   * whole file in memory behind a 10,000-row cap, so a busy filter produced a
   * short file that looked complete -- the worst possible outcome for a
   * regulatory case log.
   */
  @Get('export.csv')
  async exportCsv(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('status') status?: string,
    @Query('zone') zone?: string,
    @Query('slaState') slaState?: string,
    @Query('requestType') requestType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filters = { status, zone, slaState, requestType, from, to };

    // Which answer columns the file needs, settled before the header goes out
    // — once the first byte is written the header cannot be revised. Both
    // queries run before streaming starts, so a failure here is still a 500
    // rather than a truncated download.
    //
    // The columns are driven by the data rather than hard-coded: each form
    // asks different questions, and a fixed header list is how this export
    // came to carry ten columns for a case that holds forty. Labels come from
    // the form schema so the file reads the way the form did.
    const { keys: presentKeys, formKeys } = await this.cases.exportFieldKeys(req.zoneCtx, filters);
    const labels = await this.cases.fieldLabels(formKeys);
    const present = new Set(presentKeys);
    // Form order first, then whatever is left — a field dropped from a later
    // schema version still has to appear rather than vanish from the record.
    const fieldKeys = [
      ...[...labels.keys()].filter((k) => present.has(k)),
      ...presentKeys.filter((k) => !labels.has(k)),
    ];

    const columns: CsvColumn<CaseExportRow>[] = [
      { header: 'Reference', value: (r) => r.caseRef },
      { header: 'Case ID', value: (r) => r.id },
      { header: 'Source', value: (r) => r.source },
      { header: 'Source ID', value: (r) => r.externalId },
      { header: 'Source request ID', value: (r) => r.externalRequestId },
      { header: 'Subject name', value: (r) => r.requesterName },
      { header: 'Requester email', value: (r) => r.requesterEmail },
      { header: 'Request types', value: (r) => r.requestTypes },
      { header: 'Status', value: (r) => r.status },
      { header: 'Progress', value: (r) => r.progress },
      { header: 'Source status', value: (r) => r.sourceStatus },
      { header: 'Created', value: (r) => r.createdAt },
      { header: 'Due', value: (r) => r.dueAt },
      { header: 'Completed', value: (r) => r.closedAt },
      { header: 'Completed after deadline', value: (r) => yesNo(r.completedAfterDeadline) },
      { header: 'Auto extended', value: (r) => yesNo(r.autoExtended) },
      { header: 'Skip completion notification', value: (r) => yesNo(r.skipCompletionNotification) },
      { header: 'Outcome', value: (r) => r.outcomeCode },
      { header: 'Zone', value: (r) => r.zoneId },
      { header: 'Country', value: (r) => r.country },
      { header: 'Residency', value: (r) => r.residency },
      { header: 'Owner', value: (r) => r.assigneeName },
      { header: 'Owner email', value: (r) => r.assigneeEmail },
      { header: 'Approvers', value: (r) => r.approvers },
      { header: 'Report published', value: (r) => r.reportPublishedAt },
      { header: 'Report accessed', value: (r) => r.reportAccessedAt },
      { header: 'Can be appealed', value: (r) => yesNo(r.canBeAppealed) },
      { header: 'Can appeal until', value: (r) => r.canAppealUntil },
      { header: 'Is appeal', value: (r) => yesNo(r.isAppeal) },
      { header: 'Appeal status', value: (r) => r.appealStatus },
      { header: 'Form', value: (r) => r.formKey },
      { header: 'Form version', value: (r) => r.formVersion },
      ...fieldKeys.map((key) => ({
        header: labels.get(key) ?? key,
        value: (r: CaseExportRow) => r.fields[key],
      })),
    ];

    // Every header before the first byte of the body: after that the status
    // line has gone out and nothing about it can be revised.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('cases')}"`);
    // nginx buffers proxied responses by default, which would swallow the
    // backpressure this streams on -- it reads as fast as we write and the
    // export accumulates in the proxy instead of the process. Set here rather
    // than in the site config so the two cannot drift apart; nginx strips the
    // header before the client sees it.
    res.setHeader('X-Accel-Buffering', 'no');

    const outcome = await streamCsv(
      res,
      columns,
      this.cases.streamExportRows(req.zoneCtx, filters),
      // Recorded before the file is closed off rather than after, so an export
      // that cannot be written to the audit trail fails the download instead
      // of handing over personal data with no record of who took it.
      (rows) =>
        this.audit.record({
          actorId: req.user.id,
          actorType: 'user',
          action: 'cases.exported',
          entityType: 'case',
          // An export copies personal data out of the system; record how much,
          // and that it carried the answers themselves and not only metadata.
          after: { rows, fieldColumns: fieldKeys.length, complete: true, filters },
        }),
    );

    if (outcome.error) {
      // The response carries a 200 from before the failure and streamCsv has
      // already marked and aborted the file. The server log is the only place
      // the reason survives.
      this.log.error(
        `cases export failed after ${outcome.rows} rows`,
        outcome.error instanceof Error ? outcome.error.stack : String(outcome.error),
      );
    }
    // The rows that did leave still left, so they are still recorded -- unless
    // the hook above already recorded them and the response failed afterwards,
    // in which case a second entry would only contradict the first.
    if (outcome.error && !outcome.recorded) {
      await this.audit
        .record({
          actorId: req.user.id,
          actorType: 'user',
          action: 'cases.exported',
          entityType: 'case',
          after: { rows: outcome.rows, complete: false, filters },
        })
        .catch((err) => this.log.error('could not record the failed export', err));
    }
  }

  /**
   * The whole case as a PDF, for filing or forwarding.
   *
   * Declared before the :id route so "export.pdf" is not swallowed as an id.
   */
  @Get(':id/export.pdf')
  async exportCasePdf(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const doc = await this.cases.buildDocument(req.zoneCtx, id);
    const file = await this.casePdf.render(doc);

    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'case.exported_pdf',
      entityType: 'case',
      entityId: id,
      zoneId: doc.zoneId,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.caseRef}.pdf"`);
    return new StreamableFile(file);
  }

  @Get(':id')
  async detail(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    const result = await this.cases.detail(req.zoneCtx, id);
    // Every case view lands in the audit trail (spec §9).
    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'case.view',
      entityType: 'case',
      entityId: id,
      zoneId: result.zoneId,
      sourceIp: ip,
    });
    return result;
  }
}
