import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { SettingsService } from '../settings/settings.service';

/**
 * A case as a document.
 *
 * The shape mirrors the screen — header, SLA, submitted details, files,
 * activity — so somebody comparing the two is never confused about whether they
 * are looking at the same thing. Built with PDFKit for the same reason as the
 * executive report: no browser on a one-vCPU box.
 */

const INK = '#17171a';
const MUTED = '#5f636b';
const FAINT = '#9b9ea6';
/* Black band, yellow rule — see the note in report-pdf.service.ts. */
const BRAND = '#d3a238';
const HEADER_BG = '#0a0a0a';
const ON_HEADER_MUTED = '#c9c7bd';
const LINE = '#e6e7eb';
const DANGER = '#c8322b';

const PAGE = { width: 595.28, height: 841.89 };
const M = 46;
const CONTENT = PAGE.width - M * 2;

type Doc = PDFKit.PDFDocument;

export interface CaseDocument {
  caseRef: string;
  zoneId: string;
  status: string;
  formKey: string;
  createdAt: string;
  dueAt: string | null;
  closedAt?: string | null;
  requesterEmail: string;
  requesterName: string | null;
  requestTypes: string[];
  country: string | null;
  pendingOn: string | null;
  pendingParty: string | null;
  approvers: string;
  outcomeCode?: string | null;
  closureNote?: string | null;
  fields: { key: string; value: unknown; encrypted: boolean }[];
  history: {
    fromStatus: string | null;
    toStatus: string;
    note: string | null;
    createdAt: string;
    actorName?: string | null;
  }[];
  emails: { subject: string; toAddrs: string[]; status: string; createdAt: string }[];
  attachments: { filename: string; size_bytes: number; source: string; created_at: string }[];
}

function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Same presentation rules as the screen, so the two never disagree. */
function present(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((v) => v && typeof v === 'object')) {
      return value
        .map((row) =>
          Object.entries(row as Record<string, unknown>)
            .map(([k, v]) => `${humanise(k)}: ${present(v)}`)
            .join(', '),
        )
        .join('\n');
    }
    return value.map((v) => present(v)).join(', ');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const values = Object.values(obj);
    if (values.length > 0 && values.every((v) => typeof v === 'boolean')) {
      const chosen = Object.entries(obj).filter(([, v]) => v).map(([k]) => humanise(k));
      return chosen.length ? chosen.join(', ') : 'None selected';
    }
    return Object.entries(obj).map(([k, v]) => `${humanise(k)}: ${present(v)}`).join('\n');
  }
  return String(value);
}

@Injectable()
export class CasePdfService {
  constructor(private readonly settings: SettingsService) {}

  async render(c: CaseDocument): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      margins: { top: M, bottom: M, left: M, right: M },
      info: { Title: `${c.caseRef} — privacy request`, Subject: 'Data subject request' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));

    this.header(doc, c);
    this.summary(doc, c);
    this.details(doc, c);
    this.files(doc, c);
    this.activity(doc, c);
    this.footer(doc, c);

    doc.flushPages();
    doc.end();
    return done;
  }

  private header(doc: Doc, c: CaseDocument): void {
    doc.rect(0, 0, PAGE.width, 78).fill(HEADER_BG);
    doc.rect(0, 78, PAGE.width, 4).fill(BRAND);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(c.caseRef, M, 24);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(ON_HEADER_MUTED)
      .text(
        `${this.settings.get<string>('ORG_NAME', 'Privacy operations')}  ·  ${c.zoneId}  ·  ${c.status}`,
        M,
        48,
      );
    doc.y = 100;
  }

  private summary(doc: Doc, c: CaseDocument): void {
    const overdue = c.dueAt ? new Date(c.dueAt) < new Date() && c.status !== 'closed' : false;
    this.table(doc, [
      ['Requester', c.requesterName ? `${c.requesterName} (${c.requesterEmail})` : c.requesterEmail],
      ['Request type', c.requestTypes.length ? c.requestTypes.map(humanise).join(', ') : '—'],
      ['Country', c.country ?? '—'],
      ['Received', new Date(c.createdAt).toLocaleString()],
      ['Response due', c.dueAt ? new Date(c.dueAt).toLocaleString() + (overdue ? '  (overdue)' : '') : '—'],
      ['Pending on', c.pendingOn ? `${c.pendingOn}${c.pendingParty === 'internal' ? ' (internal)' : ''}` : '—'],
      ['Approvers', c.approvers || '—'],
      ['Form', c.formKey],
      ...(c.closedAt ? ([['Closed', new Date(c.closedAt).toLocaleString()]] as [string, string][]) : []),
      ...(c.outcomeCode ? ([['Outcome', humanise(c.outcomeCode)]] as [string, string][]) : []),
      ...(c.closureNote ? ([['Closure note', c.closureNote]] as [string, string][]) : []),
    ], overdue);
    doc.y += 8;
  }

  private details(doc: Doc, c: CaseDocument): void {
    this.section(doc, 'Submitted details');
    if (c.fields.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(FAINT).text('No fields recorded.', M, doc.y);
      doc.y += 14;
      return;
    }
    this.table(
      doc,
      c.fields.map((f) => [humanise(f.key) + (f.encrypted ? ' *' : ''), present(f.value)]),
    );
    if (c.fields.some((f) => f.encrypted)) {
      doc.font('Helvetica').fontSize(7.5).fillColor(FAINT)
        .text('*  held encrypted at rest', M, doc.y + 2);
      doc.y += 12;
    }
    doc.y += 6;
  }

  private files(doc: Doc, c: CaseDocument): void {
    if (c.attachments.length === 0) return;
    this.section(doc, 'Files');
    this.table(
      doc,
      c.attachments.map((a) => [
        a.filename,
        `${humanise(a.source)} · ${Math.max(1, Math.round(a.size_bytes / 1024))} KB · ${new Date(a.created_at).toLocaleDateString()}`,
      ]),
    );
    doc.y += 6;
  }

  private activity(doc: Doc, c: CaseDocument): void {
    this.section(doc, 'Activity');
    const items = [
      ...c.history.map((h) => ({
        at: new Date(h.createdAt).getTime(),
        who: h.actorName ?? 'System',
        what:
          h.fromStatus && h.fromStatus !== h.toStatus
            ? `${humanise(h.fromStatus)} → ${humanise(h.toStatus)}`
            : humanise(h.toStatus),
        note: h.note ?? '',
      })),
      ...c.emails.map((e) => ({
        at: new Date(e.createdAt).getTime(),
        who: 'Privacy team',
        what: `Email ${e.status}`,
        note: `${e.subject} → ${e.toAddrs.join(', ')}`,
      })),
    ].sort((a, b) => a.at - b.at);

    for (const item of items) {
      if (doc.y > PAGE.height - 90) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
        .text(item.what, M, doc.y, { width: CONTENT * 0.55, continued: false });
      const line = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor(FAINT).text(
        `${item.who} · ${new Date(item.at).toLocaleString()}`,
        M + CONTENT * 0.55,
        line,
        { width: CONTENT * 0.45, align: 'right' },
      );
      if (item.note) {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED)
          .text(item.note, M, doc.y + 1, { width: CONTENT });
      }
      doc.y += 6;
      doc.moveTo(M, doc.y).lineTo(M + CONTENT, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 6;
    }
  }

  /** Two-column label/value table; the workhorse of the whole document. */
  private table(doc: Doc, rows: [string, string][], flagFirst = false): void {
    const labelW = CONTENT * 0.28;
    const valueW = CONTENT - labelW - 10;

    for (const [label, value] of rows) {
      const height = Math.max(
        doc.font('Helvetica').fontSize(9).heightOfString(label, { width: labelW }),
        doc.font('Helvetica').fontSize(9).heightOfString(value || '—', { width: valueW }),
      );
      if (doc.y + height > PAGE.height - M - 20) doc.addPage();

      const top = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, M, top, { width: labelW });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(flagFirst && /overdue/.test(value) ? DANGER : INK)
        .text(value || '—', M + labelW + 10, top, { width: valueW });

      doc.y = top + height + 5;
      doc.moveTo(M, doc.y - 2).lineTo(M + CONTENT, doc.y - 2).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 2;
    }
  }

  private section(doc: Doc, title: string): void {
    if (doc.y > PAGE.height - 120) doc.addPage();
    doc.y += 6;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(title, M, doc.y);
    doc.y += 3;
    doc.moveTo(M, doc.y).lineTo(M + CONTENT, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
    doc.y += 8;
  }

  private footer(doc: Doc, c: CaseDocument): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing below the bottom margin would make PDFKit add a page.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor(FAINT).text(
        `${c.caseRef} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · contains personal data`,
        M,
        PAGE.height - 28,
        { width: CONTENT * 0.8 },
      );
      doc.text(`${i - range.start + 1} of ${range.count}`, M + CONTENT * 0.8, PAGE.height - 28, {
        width: CONTENT * 0.2,
        align: 'right',
      });
      doc.page.margins.bottom = keep;
    }
  }
}
