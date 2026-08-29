import { Controller, Get, Ip, Logger, Param, ParseUUIDPipe, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import type { Response } from 'express';
import { csvFilename, type CsvColumn } from './csv';
import { streamCsv } from './csv-stream';
import { CasePdfService } from './case-pdf.service';
import type { AuthedRequest } from '../auth/auth.guard';
import { CasesService, type CaseListRow } from './cases.service';
import { AuditService } from '../audit/audit.service';

@Controller('internal/cases')
@UseGuards(AuthGuard)
export class CasesController {
  private readonly log = new Logger(CasesController.name);

  constructor(
    private readonly cases: CasesService,
    private readonly audit: AuditService,
    private readonly casePdf: CasePdfService,
  ) {}

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
    const columns: CsvColumn<CaseListRow>[] = [
      { header: 'Reference', value: (r) => r.caseRef },
      { header: 'Created', value: (r) => r.createdAt },
      { header: 'Zone', value: (r) => r.zoneId },
      { header: 'Country', value: (r) => r.country },
      { header: 'Request types', value: (r) => r.requestTypes },
      { header: 'Status', value: (r) => r.status },
      { header: 'Due', value: (r) => r.dueAt },
      { header: 'Requester email', value: (r) => r.requesterEmail },
      { header: 'Approvers', value: (r) => r.approvers },
      { header: 'Form', value: (r) => r.formKey },
    ];

    // Both headers before the first byte of the body: after that the status
    // line has gone out and nothing about it can be revised.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('cases')}"`);

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
          // An export copies personal data out of the system; record how much.
          after: { rows, complete: true, filters },
        }),
    );

    if (outcome.error) {
      // The response carries a 200 from before the failure and streamCsv has
      // already marked and aborted the file. The rows that did leave still
      // happened, so they are still recorded; the server log is the only place
      // the reason survives.
      this.log.error(
        `cases export failed after ${outcome.rows} rows`,
        outcome.error instanceof Error ? outcome.error.stack : String(outcome.error),
      );
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
