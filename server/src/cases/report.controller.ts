import { Controller, Get, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { ReportService } from './report.service';
import { ReportPdfService } from './report-pdf.service';
import { toCsv, csvFilename } from './csv';

/**
 * Manager reporting: the same figures the daily email carries, on demand.
 *
 * A zone manager always gets their own zone regardless of what they ask for —
 * the report is built from a zone-filtered query rather than filtered after the
 * fact, so there is no shape of request that returns another zone's numbers.
 */
@Controller('internal/reports')
@UseGuards(AuthGuard)
@Requires('reports.run')
export class ReportController {
  constructor(
    private readonly reports: ReportService,
    private readonly pdf: ReportPdfService,
  ) {}

  private scope(req: AuthedRequest, requested?: string): string | undefined {
    if (req.user.role === 'zone_manager') return req.user.zoneId ?? undefined;
    return requested || undefined;
  }

  @Get()
  summary(@Req() req: AuthedRequest, @Query('zone') zone?: string) {
    return this.reports.build(req.zoneCtx, this.scope(req, zone));
  }

  @Get('export.csv')
  async csv(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('zone') zone?: string,
  ) {
    const s = await this.reports.build(req.zoneCtx, this.scope(req, zone));

    // One flat metric-per-row sheet: it opens cleanly and pivots easily, which
    // a nested layout would not.
    const rows: { section: string; metric: string; value: string | number }[] = [
      { section: 'Today', metric: 'Received', value: s.today.received },
      { section: 'Today', metric: 'Closed', value: s.today.closed },
      { section: 'Today', metric: 'Emails verified', value: s.today.verified },
      { section: 'Overall', metric: 'Open', value: s.overall.open },
      { section: 'Overall', metric: 'Overdue', value: s.overall.overdue },
      { section: 'Overall', metric: 'Due within 3 days', value: s.overall.dueSoon },
      { section: 'Overall', metric: 'Closed', value: s.overall.closed },
      { section: 'Overall', metric: 'Total received', value: s.overall.total },
      { section: 'Overall', metric: 'Median days to close', value: s.overall.medianDaysToClose ?? '' },
      { section: 'Overall', metric: 'Closed within SLA (%)', value: s.overall.onTimeRate ?? '' },
      ...s.byStatus.map((r) => ({ section: 'By status', metric: r.status, value: r.n })),
      ...s.byZone.map((r) => ({ section: 'By zone', metric: r.zone_id, value: r.n })),
      ...s.byZone.map((r) => ({ section: 'By zone (overdue)', metric: r.zone_id, value: r.overdue })),
      ...s.dailyVolume.map((d) => ({ section: 'Arrivals per day', metric: d.day, value: d.n })),
      ...s.oldestOpen.map((c) => ({
        section: 'Longest open',
        metric: `${c.case_ref} (${c.zone_id}, ${c.status})`,
        value: `${c.days} days`,
      })),
    ];

    const csv = toCsv(rows, [
      { header: 'Section', value: (r) => r.section },
      { header: 'Metric', value: (r) => r.metric },
      { header: 'Value', value: (r) => r.value },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('report')}"`);
    return csv;
  }

  /** The executive report: findings first, then the numbers behind them. */
  @Get('export.pdf')
  async pdfExport(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('zone') zone?: string,
  ) {
    const stats = await this.reports.build(req.zoneCtx, this.scope(req, zone));
    const file = await this.pdf.render(stats);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="privacy-report-${new Date().toISOString().slice(0, 10)}.pdf"`,
    );
    return new StreamableFile(file);
  }

  /** Send the digest now rather than waiting for the morning run. */
  @Post('send')
  @Requires('system.operate')
  send() {
    return this.reports.dispatch();
  }
}
