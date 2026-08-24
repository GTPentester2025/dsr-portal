import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { SettingsService } from '../settings/settings.service';
import type { ReportStats } from './report.service';
import type { Insight } from './insights';

/**
 * The executive report.
 *
 * Built with PDFKit rather than a headless browser: the server is a single
 * vCPU with 2 GB, where Chromium is a poor tenant, and drawing vectors directly
 * gives sharper charts than rasterising a web page anyway.
 *
 * The layout answers, in order: is anything on fire, how are we trending, and
 * where is the work. Findings lead, because a reader who stops after page one
 * should still have the point.
 */

const INK = '#17171a';
const MUTED = '#5f636b';
const FAINT = '#9b9ea6';
/* The brand yellow is a fill, not a ground for white type — the cover band is
   black with a yellow rule under it, the way the corporate site stacks them. */
const BRAND = '#d3a238';
const HEADER_BG = '#0a0a0a';
const ON_HEADER = '#ffffff';
const ON_HEADER_MUTED = '#c9c7bd';
const ON_HEADER_FAINT = '#9d9b93';
const LINE = '#e6e7eb';
const DANGER = '#c8322b';
const WARNING = '#b4740f';
const POSITIVE = '#1d7a3d';

const TONE_COLOR: Record<string, string> = {
  critical: DANGER,
  warning: WARNING,
  positive: POSITIVE,
  neutral: '#d3a238',
};

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait
const M = 48; // margin
const CONTENT = PAGE.width - M * 2;

type Doc = PDFKit.PDFDocument;

@Injectable()
export class ReportPdfService {
  /** Findings deferred from the summary page to the detail page. */
  private overflow: Insight[] = [];

  constructor(private readonly settings: SettingsService) {}

  async render(stats: ReportStats): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      // Required for switchToPage in footer(): page numbers are only known
      // once every page exists.
      bufferPages: true,
      // Uncompressed only when explicitly asked, so the output can be inspected.
      compress: process.env.PDF_DEBUG !== 'true',
      margins: { top: M, bottom: M, left: M, right: M },
      info: {
        Title: `Privacy request report — ${stats.zone}`,
        Author: this.settings.get<string>('ORG_NAME', 'Privacy Team'),
        Subject: 'Data subject request operations',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // Page one: the summary.
    this.header(doc, stats);
    this.headline(doc, stats);
    this.findings(doc, stats.insights);
    this.trend(doc, stats);

    // Page two: the supporting detail, only when there is any.
    if (stats.byRequestType.length > 0 || stats.byZone.length > 0 || stats.oldestOpen.length > 0) {
      doc.addPage();
      doc.y = M;
      this.breakdowns(doc, stats);
      this.attention(doc, stats);
    }

    this.footer(doc);

    doc.flushPages();
    doc.end();
    return done;
  }

  // ---------------------------------------------------------------- header
  private header(doc: Doc, s: ReportStats): void {
    const org = this.settings.get<string>('ORG_NAME', 'Privacy operations');

    doc.rect(0, 0, PAGE.width, 96).fill(HEADER_BG);
    doc.rect(0, 96, PAGE.width, 5).fill(BRAND);
    doc
      .fillColor(ON_HEADER)
      .font('Helvetica-Bold')
      .fontSize(19)
      .text('Privacy Request Report', M, 30, { width: CONTENT });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(ON_HEADER_MUTED)
      .text(`${org}  ·  ${s.zone}`, M, 56, { width: CONTENT });

    const generated = new Date(s.generatedAt);
    doc
      .fontSize(9)
      .fillColor(ON_HEADER_FAINT)
      .text(
        generated.toISOString().slice(0, 10) + '  ·  reporting period: last 14 days',
        M,
        72,
        { width: CONTENT },
      );

    doc.y = 124;
  }

  // -------------------------------------------------------------- headline
  private headline(doc: Doc, s: ReportStats): void {
    const cards = [
      { label: 'OPEN', value: s.overall.open, tone: 'neutral' },
      { label: 'OVERDUE', value: s.overall.overdue, tone: s.overall.overdue > 0 ? 'critical' : 'positive' },
      { label: 'DUE ≤48H', value: s.comparison.breachingSoon, tone: s.comparison.breachingSoon > 0 ? 'warning' : 'positive' },
      {
        label: 'ON TIME',
        value: s.overall.onTimeRate === null ? '—' : `${s.overall.onTimeRate}%`,
        tone: s.overall.onTimeRate !== null && s.overall.onTimeRate < 90 ? 'warning' : 'positive',
      },
    ];

    const gap = 10;
    const w = (CONTENT - gap * 3) / 4;
    const top = doc.y;

    cards.forEach((c, i) => {
      const x = M + i * (w + gap);
      doc.roundedRect(x, top, w, 62, 6).lineWidth(1).strokeColor(LINE).stroke();
      // A thin coloured rule rather than a filled card: colour carries meaning
      // here, and four saturated blocks would flatten that signal.
      doc.rect(x, top, w, 3).fill(TONE_COLOR[c.tone]);
      doc
        .fillColor(FAINT)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text(c.label, x + 10, top + 14, { width: w - 20, characterSpacing: 0.6 });
      doc
        .fillColor(c.tone === 'critical' ? DANGER : INK)
        .font('Helvetica-Bold')
        .fontSize(22)
        .text(String(c.value), x + 10, top + 28, { width: w - 20 });
    });

    doc.y = top + 62 + 22;
  }

  // -------------------------------------------------------------- findings
  private findings(doc: Doc, insights: Insight[]): void {
    this.sectionTitle(doc, 'What needs attention');

    const top = insights.slice(0, 3);
    // Anything that did not fit the summary is carried to page two rather than
    // dropped — a finding that exists but is never shown is worse than none.
    this.overflow = insights.slice(3, 7);
    if (top.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED)
        .text('Nothing requires action. No open requests and no missed deadlines.', M, doc.y);
      doc.y += 18;
      return;
    }

    for (const insight of top) {
      const color = TONE_COLOR[insight.tone];
      const startY = doc.y;

      // Measure first so the accent rule matches the block it belongs to.
      const headlineH = doc.font('Helvetica-Bold').fontSize(10)
        .heightOfString(insight.headline, { width: CONTENT - 16 });
      const detailH = doc.font('Helvetica').fontSize(8.5)
        .heightOfString(insight.detail, { width: CONTENT - 16, lineGap: 1 });
      const blockH = headlineH + detailH + 9;

      doc.rect(M, startY, 2.5, blockH).fill(color);
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(insight.headline, M + 12, startY + 1, { width: CONTENT - 16 });
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(8.5)
        .text(insight.detail, M + 12, startY + headlineH + 3, {
          width: CONTENT - 16,
          lineGap: 1,
        });

      doc.y = startY + blockH + 7;
    }
    doc.y += 6;
  }

  // ------------------------------------------------------------------ trend
  private trend(doc: Doc, s: ReportStats): void {
    this.sectionTitle(doc, 'Requests received, last 14 days');

    const data = s.dailyVolume;
    const top = doc.y;
    const h = 96;
    const peak = Math.max(1, ...data.map((d) => d.n));
    const barGap = 4;
    const barW = Math.max(6, (CONTENT - barGap * (data.length - 1)) / data.length);

    // Baseline and a mid gridline: two references are enough to read a bar
    // chart, more would compete with the data.
    doc.moveTo(M, top + h).lineTo(M + CONTENT, top + h).lineWidth(0.8).strokeColor(LINE).stroke();
    doc.moveTo(M, top + h / 2).lineTo(M + CONTENT, top + h / 2).lineWidth(0.5).strokeColor('#f2f3f6').stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(FAINT)
      .text(String(peak), M + CONTENT - 16, top - 2, { width: 16, align: 'right' });

    data.forEach((d, i) => {
      const x = M + i * (barW + barGap);
      const barH = Math.round((d.n / peak) * (h - 8));
      if (barH > 0) {
        doc.rect(x, top + h - barH, barW, barH).fill(BRAND);
      } else {
        // A zero day still gets a mark, otherwise the axis reads as a gap.
        doc.rect(x, top + h - 1.5, barW, 1.5).fill(LINE);
      }
      if (d.n > 0) {
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED)
          .text(String(d.n), x, top + h - barH - 9, { width: barW, align: 'center' });
      }
      // Every other label, so they never collide.
      if (i % 2 === 0) {
        doc.font('Helvetica').fontSize(6).fillColor(FAINT)
          .text(d.day.slice(5), x - 2, top + h + 5, { width: barW + 4, align: 'center' });
      }
    });

    doc.y = top + h + 20;

    const c = s.comparison;
    const delta = c.receivedLastWeek === 0 ? null
      : Math.round(((c.receivedThisWeek - c.receivedLastWeek) / c.receivedLastWeek) * 100);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
      `${c.receivedThisWeek} received in the last 7 days against ${c.receivedLastWeek} the week before` +
        (delta === null ? '.' : `, a change of ${delta > 0 ? '+' : ''}${delta}%.`) +
        `  ${c.closedThisWeek} closed in the same period.`,
      M,
      doc.y,
      { width: CONTENT },
    );
    doc.y += 20;
  }

  // ------------------------------------------------------------ breakdowns
  private breakdowns(doc: Doc, s: ReportStats): void {
    const colW = (CONTENT - 24) / 2;
    const top = doc.y;

    if (this.overflow.length > 0) {
      this.sectionTitle(doc, 'Also worth noting');
      for (const insight of this.overflow) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(TONE_COLOR[insight.tone])
          .text('•', M, doc.y, { width: 10, lineBreak: false });
        doc.fillColor(INK).text(insight.headline, M + 12, doc.y, { width: CONTENT - 12 });
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text(insight.detail, M + 12, doc.y + 2, { width: CONTENT - 12, lineGap: 1 });
        doc.y += 8;
      }
      doc.y += 8;
    }

    this.sectionTitle(doc, 'Where the work is');
    const listTop = doc.y;

    this.miniBars(doc, M, listTop, colW, 'By request type',
      s.byRequestType.slice(0, 5).map((r) => ({ label: r.request_type, n: Number(r.n) })));

    this.miniBars(doc, M + colW + 24, listTop, colW, 'By zone',
      s.byZone.map((r) => ({ label: r.zone_id, n: Number(r.n) })));

    const rows = Math.max(
      Math.min(5, s.byRequestType.length),
      s.byZone.length,
    );
    doc.y = listTop + 22 + rows * 17 + 14;
    void top;
  }

  private miniBars(
    doc: Doc,
    x: number,
    y: number,
    w: number,
    title: string,
    data: { label: string; n: number }[],
  ): void {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(FAINT)
      .text(title.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });

    if (data.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(FAINT).text('No data', x, y + 16, { width: w });
      return;
    }

    const peak = Math.max(1, ...data.map((d) => d.n));
    data.forEach((d, i) => {
      const rowY = y + 20 + i * 17;
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
        .text(d.label, x, rowY, { width: w * 0.42, ellipsis: true, lineBreak: false });
      const barX = x + w * 0.45;
      const barMax = w * 0.42;
      doc.rect(barX, rowY + 2, barMax, 5).fill('#f2f3f6');
      doc.rect(barX, rowY + 2, Math.max(2, (d.n / peak) * barMax), 5).fill(BRAND);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
        .text(String(d.n), x + w * 0.9, rowY, { width: w * 0.1, align: 'right' });
    });
  }

  // -------------------------------------------------------------- attention
  private attention(doc: Doc, s: ReportStats): void {
    if (s.oldestOpen.length === 0) return;

    this.sectionTitle(doc, 'Longest open requests');

    const cols = [
      { label: 'REFERENCE', w: CONTENT * 0.34 },
      { label: 'ZONE', w: CONTENT * 0.14 },
      { label: 'STATUS', w: CONTENT * 0.26 },
      { label: 'AGE', w: CONTENT * 0.26 },
    ];

    let y = doc.y;
    let x = M;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(FAINT);
    cols.forEach((c) => {
      doc.text(c.label, x, y, { width: c.w, characterSpacing: 0.5 });
      x += c.w;
    });
    y += 12;
    doc.moveTo(M, y).lineTo(M + CONTENT, y).lineWidth(0.8).strokeColor(LINE).stroke();
    y += 6;

    for (const c of s.oldestOpen.slice(0, 8)) {
      x = M;
      const stale = c.days > 30;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
        .text(c.case_ref, x, y, { width: cols[0].w, lineBreak: false });
      x += cols[0].w;
      doc.font('Helvetica').fillColor(MUTED)
        .text(c.zone_id, x, y, { width: cols[1].w, lineBreak: false });
      x += cols[1].w;
      doc.text(c.status, x, y, { width: cols[2].w, lineBreak: false });
      x += cols[2].w;
      doc.font(stale ? 'Helvetica-Bold' : 'Helvetica').fillColor(stale ? DANGER : MUTED)
        .text(`${c.days} days`, x, y, { width: cols[3].w, lineBreak: false });
      y += 15;
    }
    doc.y = y + 10;
  }

  // ----------------------------------------------------------------- chrome
  private sectionTitle(doc: Doc, text: string): void {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(text, M, doc.y, { width: CONTENT });
    doc.y += 4;
    doc.moveTo(M, doc.y).lineTo(M + CONTENT, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
    doc.y += 10;
  }

  private footer(doc: Doc): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The footer sits below the bottom margin. PDFKit treats any write past
      // that margin as an overflow and starts a new page, which silently
      // inflated the page count — so drop the margin for the write itself.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text(
        'Generated automatically by the DSR portal. Figures are live at the time of generation.',
        M,
        PAGE.height - 32,
        { width: CONTENT * 0.8 },
      );
      doc.text(`${i - range.start + 1} of ${range.count}`, M + CONTENT * 0.8, PAGE.height - 32, {
        width: CONTENT * 0.2,
        align: 'right',
      });
      doc.page.margins.bottom = keep;
    }
  }
}
