import { Controller, Get, Ip, Param, ParseUUIDPipe, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import type { Response } from 'express';
import { toCsv, csvFilename } from './csv';
import { CasePdfService } from './case-pdf.service';
import type { AuthedRequest } from '../auth/auth.guard';
import { CasesService } from './cases.service';
import { AuditService } from '../audit/audit.service';

@Controller('internal/cases')
@UseGuards(AuthGuard)
export class CasesController {
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
   */
  @Get('export.csv')
  async exportCsv(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('zone') zone?: string,
    @Query('slaState') slaState?: string,
    @Query('requestType') requestType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const rows = await this.cases.exportRows(req.zoneCtx, {
      status, zone, slaState, requestType, from, to,
    });
    const csv = toCsv(rows, [
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
    ]);

    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'cases.exported',
      entityType: 'case',
      // An export copies personal data out of the system; record how much.
      after: { rows: rows.length, filters: { status, zone, slaState, requestType, from, to } },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('cases')}"`);
    return csv;
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
