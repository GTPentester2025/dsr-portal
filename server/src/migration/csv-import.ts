/**
 * Reading a case export out of another DSR tool.
 *
 * Everything here is pure: bytes in, a proposal and a set of parsed rows out.
 * The service decides what to write; this file only decides what the file
 * says. That split is what makes the analyse step safe to run repeatedly and
 * the mapping reviewable before anything reaches the database.
 *
 * Hand-rolled rather than pulled from a dependency, for the same reason the
 * export side is: the rules that matter are quoting, encoding and dates, and
 * getting those wrong quietly is worse than not having the feature.
 */

import type { Component } from '../public/form-validation';

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Spreadsheets are saved as UTF-8 about as often as they are saved as the
 * Windows code page, and a file full of Portuguese and Spanish names shows the
 * difference immediately. UTF-8 is tried strictly first: any byte sequence
 * that is not valid UTF-8 means the file is almost certainly cp1252, which
 * cannot fail to decode.
 */
export function decodeUpload(buf: Buffer): { text: string; encoding: 'utf-8' | 'windows-1252' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: stripBom(text), encoding: 'utf-8' };
  } catch {
    return { text: stripBom(new TextDecoder('windows-1252').decode(buf)), encoding: 'windows-1252' };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedFile {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

/**
 * Pick the delimiter by counting candidates outside quoted runs on the header
 * line. Sniffing on the raw line would be fooled by a header that contains a
 * comma inside quotes, which the source export does have.
 */
function sniffDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** RFC 4180, plus the two things real files do: CRLF and embedded newlines. */
export function parseDelimited(text: string, delimiter?: string): ParsedFile {
  const firstBreak = text.search(/\r\n|\n|\r/);
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const d = delimiter ?? sniffDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // Swallow; the \n that follows ends the record. A lone \r ends it too.
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  // Trailing blank lines are not rows; a row of empty strings is not a case.
  const body = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return { headers, rows: body, delimiter: d };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Where a column can land. `case` columns become properties of the case
 * record; `field` columns become answers held against it; `ignore` columns are
 * read and discarded, which is a decision the operator makes explicitly rather
 * than something that happens by omission.
 */
export interface CaseTarget {
  id: string;
  label: string;
  /** How the raw cell is turned into a stored value. */
  type: 'text' | 'date' | 'boolean' | 'requestTypes' | 'progress' | 'email' | 'appealStatus';
  help?: string;
  /** Headers, normalised, that map here without the operator doing anything. */
  aliases: string[];
}

export const CASE_TARGETS: CaseTarget[] = [
  {
    id: 'externalId', label: 'Source case ID', type: 'text',
    help: 'Kept so the row can be traced back, and so re-importing cannot duplicate it.',
    aliases: ['dsr id', 'request id', 'case id', 'ticket id', 'id', 'reference'],
  },
  {
    id: 'externalRequestId', label: 'Source request UUID', type: 'text',
    aliases: ['dsr request id', 'request uuid', 'external request id'],
  },
  {
    id: 'requesterName', label: 'Subject name', type: 'text',
    aliases: ['subject name', 'data subject', 'name', 'full name', 'requester name'],
  },
  {
    id: 'requesterEmail', label: 'Requester email', type: 'email',
    help: 'Rows without one are imported against a placeholder address and counted separately.',
    aliases: ['email', 'email address', 'requester email', 'subject email', 'contact email'],
  },
  {
    id: 'requestTypes', label: 'Request type', type: 'requestTypes',
    help: 'Matched against the wording of the chosen form, so labels become the right codes.',
    aliases: ['type', 'request type', 'dsr type', 'tipo'],
  },
  {
    id: 'progress', label: 'Status / progress', type: 'progress',
    aliases: ['progress', 'status', 'state', 'stage'],
  },
  { id: 'createdAt', label: 'Created', type: 'date', aliases: ['created date', 'created', 'created at', 'submitted', 'date created'] },
  { id: 'dueAt', label: 'Deadline', type: 'date', aliases: ['deadline', 'due', 'due date', 'due at'] },
  { id: 'closedAt', label: 'Completed', type: 'date', aliases: ['date completed', 'completed', 'closed', 'closed at', 'completion date'] },
  {
    id: 'completedAfterDeadline', label: 'Completed after deadline', type: 'boolean',
    aliases: ['completed after deadline', 'late', 'overdue at completion', 'breached'],
  },
  { id: 'autoExtended', label: 'Auto extended', type: 'boolean', aliases: ['auto extended', 'auto-extended', 'extended automatically'] },
  {
    id: 'skipCompletionNotification', label: 'Skip completion notification', type: 'boolean',
    aliases: ['skip completion notification', 'suppress notification', 'no notification'],
  },
  {
    id: 'residency', label: 'Residency', type: 'text',
    help: 'Where the requester says they live, as distinct from which form they used.',
    aliases: ['residency', 'residence', 'jurisdiction', 'state of residence'],
  },
  {
    id: 'assigneeEmail', label: 'Owner (matched by email or name)', type: 'text',
    help: 'Matched against portal accounts. An unmatched owner leaves the case unassigned and is reported.',
    aliases: ['owner', 'assignee', 'assigned to', 'handler', 'owner email'],
  },
  { id: 'canBeAppealed', label: 'Can be appealed', type: 'boolean', aliases: ['can be appealed', 'appealable'] },
  { id: 'canAppealUntil', label: 'Can appeal until', type: 'date', aliases: ['can appeal until', 'appeal deadline', 'appeal window ends'] },
  { id: 'isAppeal', label: 'Is an appeal', type: 'boolean', aliases: ['is appeal', 'is an appeal', 'appeal'] },
  { id: 'appealStatus', label: 'Appeal status', type: 'appealStatus', aliases: ['appeal status'] },
];

const CASE_TARGET_BY_ID = new Map(CASE_TARGETS.map((t) => [t.id, t]));

/**
 * Headers that describe the tenant rather than the case. Recognised so they
 * are proposed as ignored instead of being offered as new custom fields —
 * importing an "Organisation Name" column that reads "SAZ" on every row adds
 * nothing the zone does not already say.
 */
const KNOWN_NOISE = new Set([
  'organisation name', 'organization name', 'org name', 'tenant', 'tenant name',
  'is appeal parent', 'appeal parent id',
]);

export function normaliseHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents so "solicitação" matches
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A stable, readable key for a column the form does not have a field for. */
export function slugKey(header: string): string {
  const slug = normaliseHeader(header).replace(/ /g, '_').slice(0, 60);
  return slug || 'unnamed_column';
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

export type DateOrder = 'dmy' | 'mdy' | 'iso';

/**
 * Decide whether the file writes 03-04-2026 as 3 April or 4 March.
 *
 * Guessing wrong silently shifts a deadline by months, so the answer is taken
 * from evidence — a first component above 12 can only be a day — and shown to
 * the operator to confirm. With no evidence either way the day-first reading
 * wins, which is what every non-US export in this system has used.
 */
export function detectDateOrder(samples: string[]): { order: DateOrder; confident: boolean } {
  let firstOver12 = 0;
  let secondOver12 = 0;
  let iso = 0;
  let seen = 0;
  for (const raw of samples) {
    const s = (raw ?? '').trim();
    if (!s) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      iso++;
      seen++;
      continue;
    }
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
    if (!m) continue;
    seen++;
    if (Number(m[1]) > 12) firstOver12++;
    if (Number(m[2]) > 12) secondOver12++;
  }
  if (seen > 0 && iso === seen) return { order: 'iso', confident: true };
  if (firstOver12 > 0 && secondOver12 === 0) return { order: 'dmy', confident: true };
  if (secondOver12 > 0 && firstOver12 === 0) return { order: 'mdy', confident: true };
  return { order: 'dmy', confident: false };
}

export function parseDate(raw: string, order: DateOrder): Date | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    return utc(+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0));
  }

  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(am|pm)?/i.exec(s);
  if (!m) return null;
  const a = +m[1];
  const b = +m[2];
  let year = +m[3];
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const day = order === 'mdy' ? b : a;
  const month = order === 'mdy' ? a : b;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let hour = +(m[4] ?? 0);
  const meridiem = m[7]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return utc(year, month, day, hour, +(m[5] ?? 0), +(m[6] ?? 0));
}

/**
 * Source exports carry wall-clock times with no zone. Reading them as UTC is
 * the only choice that round-trips: reading them in the server's local zone
 * would move every historical timestamp if the server were ever relocated.
 */
function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'sim', 'si', 'sí', 'verdadeiro', 'x']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'nao', 'não', 'falso']);

export function parseBoolean(raw: string): boolean | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

/**
 * Progress in the source tool is one column covering both where the case got
 * to and whether the answer reached the requester. The portal keeps those
 * apart, so one column produces a status and up to two delivery timestamps.
 */
export interface ProgressMapping {
  status: string;
  /** Delivery stamps, relative to the completion date on the same row. */
  published: boolean;
  accessed: boolean;
}

/*
 * Word boundaries throughout, and not as decoration: an unanchored `late`
 * matches inside "Escalated", which silently imported an escalated case as an
 * ordinary open one. Short common words are the ones that do this, so every
 * token here is anchored even where it currently looks unnecessary.
 */
const PROGRESS_MAP: { match: RegExp; result: ProgressMapping }[] = [
  { match: /accessed by data subject|report (read|viewed|accessed)/i, result: { status: 'closed', published: true, accessed: true } },
  { match: /report (published|delivered|sent)|response sent/i, result: { status: 'closed', published: true, accessed: false } },
  { match: /^(closed|complete|completed|fulfilled|resolved|done)$/i, result: { status: 'closed', published: false, accessed: false } },
  { match: /\b(reject\w*|refus\w*|denied|out of scope|withdraw\w*|cancel\w*)\b/i, result: { status: 'closed', published: false, accessed: false } },
  { match: /\b(pending approv\w*|awaiting approv\w*|approval)\b/i, result: { status: 'pending_approver', published: false, accessed: false } },
  { match: /\b(pending|awaiting|on hold|waiting)\b/i, result: { status: 'pending', published: false, accessed: false } },
  { match: /\bextend(ed|ing)?\b/i, result: { status: 'extended', published: false, accessed: false } },
  // Overdue is set by the SLA engine from the deadline, never asserted by a
  // file. Importing it as `open` lets the engine reach its own conclusion,
  // which will be the same one if the deadline really has passed.
  { match: /\b(overdue|breach\w*|late)\b/i, result: { status: 'open', published: false, accessed: false } },
  { match: /\b(in progress|in review|under review|processing|open|assigned|new|submitted|verification)\b/i, result: { status: 'open', published: false, accessed: false } },
];

export function mapProgress(raw: string): ProgressMapping | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  for (const entry of PROGRESS_MAP) if (entry.match.test(s)) return entry.result;
  return null;
}

const APPEAL_MAP: Record<string, string> = {
  requested: 'requested', submitted: 'requested', new: 'requested',
  'under review': 'under_review', 'in review': 'under_review', reviewing: 'under_review',
  upheld: 'upheld', granted: 'upheld', accepted: 'upheld', approved: 'upheld',
  rejected: 'rejected', denied: 'rejected', refused: 'rejected',
};

export function mapAppealStatus(raw: string): string | null {
  const s = normaliseHeader(raw);
  return s ? (APPEAL_MAP[s] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Form-aware mapping
// ---------------------------------------------------------------------------

export interface FormIndex {
  /** Normalised label (and translations) -> field key. */
  labelToKey: Map<string, string>;
  /** Field key -> label, in form order. */
  keyToLabel: Map<string, string>;
  /** Normalised option label -> value, for the request-type radio. */
  requestTypeLabels: Map<string, string>;
  /** Valid request-type values. */
  requestTypeValues: Set<string>;
  /** Per-field option label -> value, so select answers store their code. */
  optionLabels: Map<string, Map<string, string>>;
}

interface SchemaDoc {
  components?: Component[];
  i18n?: Record<string, Record<string, string>>;
}

/**
 * Build the lookup that lets a column headed "CPF" find the field keyed
 * `cpf_brazil`, and a cell reading "Ter acesso aos meus dados pessoais" find
 * the request type `access`.
 *
 * Translations are folded in because the export is produced in whichever
 * language the form was published in, which need not be the one the schema
 * lists first.
 */
export function indexForm(
  schema: SchemaDoc,
  collect: (components: Component[]) => Map<string, Component>,
): FormIndex {
  const labelToKey = new Map<string, string>();
  const keyToLabel = new Map<string, string>();
  const optionLabels = new Map<string, Map<string, string>>();
  const requestTypeLabels = new Map<string, string>();
  const requestTypeValues = new Set<string>();

  // Reverse the translation tables once: source phrase -> every rendering of
  // it, so a translated header still resolves to the untranslated key.
  const translationsOf = new Map<string, Set<string>>();
  for (const table of Object.values(schema.i18n ?? {})) {
    for (const [source, translated] of Object.entries(table ?? {})) {
      if (typeof translated !== 'string') continue;
      const set = translationsOf.get(source) ?? new Set<string>();
      set.add(translated);
      translationsOf.set(source, set);
    }
  }
  const renderings = (text: string): string[] => [text, ...(translationsOf.get(text) ?? [])];

  for (const [key, c] of collect(schema.components ?? [])) {
    const label = c.label?.trim() || key;
    keyToLabel.set(key, label);
    for (const rendering of renderings(label)) {
      const n = normaliseHeader(rendering);
      if (n && !labelToKey.has(n)) labelToKey.set(n, key);
    }
    // The key itself is a legitimate header: an export produced by this portal
    // and re-imported elsewhere carries labels, but a hand-built file may not.
    const nk = normaliseHeader(key);
    if (nk && !labelToKey.has(nk)) labelToKey.set(nk, key);

    const options = (c.data?.values ?? c.values ?? []) as { label?: string; value: string }[];
    if (options.length) {
      const map = new Map<string, string>();
      for (const o of options) {
        for (const rendering of renderings(o.label ?? o.value)) {
          const n = normaliseHeader(rendering);
          if (n) map.set(n, o.value);
        }
        map.set(normaliseHeader(o.value), o.value);
      }
      optionLabels.set(key, map);
      if (key === 'ticket_type') {
        for (const [k, v] of map) requestTypeLabels.set(k, v);
        for (const o of options) requestTypeValues.add(o.value);
      }
    }
  }

  return { labelToKey, keyToLabel, requestTypeLabels, requestTypeValues, optionLabels };
}

export interface ColumnProposal {
  header: string;
  /** 'case:<id>' | 'field:<key>' | 'ignore' */
  target: string;
  /** Why this was proposed, shown next to the row. */
  reason: string;
  /** True when the field key does not exist on the chosen form. */
  novel: boolean;
  /** Up to three non-empty values, so the operator can sanity-check. */
  samples: string[];
}

/**
 * Propose a target for every column.
 *
 * Nothing is dropped by omission: a column that matches nothing is proposed as
 * a new custom field and flagged, so the choice to discard it is one somebody
 * makes rather than one the parser makes for them.
 */
export function proposeMapping(file: ParsedFile, form: FormIndex): ColumnProposal[] {
  const used = new Set<string>();
  return file.headers.map((header, i) => {
    const n = normaliseHeader(header);
    const samples = file.rows
      .map((r) => (r[i] ?? '').trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!header.trim()) {
      return { header, target: 'ignore', reason: 'Column has no heading', novel: false, samples };
    }
    if (KNOWN_NOISE.has(n)) {
      return { header, target: 'ignore', reason: 'Describes the tenant, not the case', novel: false, samples };
    }

    // A form field of the same name wins over a case property: if the form
    // asks for the email, that answer belongs with the other answers too.
    const fieldKey = form.labelToKey.get(n);
    const caseTarget = CASE_TARGETS.find((t) => t.aliases.includes(n));

    if (caseTarget && !used.has(caseTarget.id)) {
      used.add(caseTarget.id);
      return {
        header,
        target: `case:${caseTarget.id}`,
        reason: fieldKey ? `Case property (also a form field: ${fieldKey})` : 'Recognised case property',
        novel: false,
        samples,
      };
    }
    if (fieldKey) {
      return { header, target: `field:${fieldKey}`, reason: `Matches form field ${fieldKey}`, novel: false, samples };
    }
    return {
      header,
      target: `field:${slugKey(header)}`,
      reason: 'No matching form field — will be stored under a new key',
      novel: true,
      samples,
    };
  });
}

// ---------------------------------------------------------------------------
// Row coercion
// ---------------------------------------------------------------------------

export interface RowIssue {
  row: number;
  column?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface CoercedRow {
  index: number;
  caseProps: Record<string, unknown>;
  fields: Record<string, unknown>;
  /** Delivery stamps derived from the progress column. */
  reportPublished: boolean;
  reportAccessed: boolean;
  issues: RowIssue[];
}

export interface CoerceOptions {
  dateOrder: DateOrder;
  form: FormIndex;
  /** header -> target, as confirmed by the operator. */
  mapping: Record<string, string>;
}

/**
 * Turn one file row into the shape the writer wants, collecting every problem
 * rather than stopping at the first. A row with warnings still imports; a row
 * with errors does not, and the operator is told which and why.
 */
export function coerceRow(
  headers: string[],
  cells: string[],
  index: number,
  opts: CoerceOptions,
): CoercedRow {
  const out: CoercedRow = {
    index,
    caseProps: {},
    fields: {},
    reportPublished: false,
    reportAccessed: false,
    issues: [],
  };

  headers.forEach((header, i) => {
    const target = opts.mapping[header] ?? 'ignore';
    if (target === 'ignore') return;
    const raw = (cells[i] ?? '').trim();
    if (!raw) return;

    if (target.startsWith('field:')) {
      const key = target.slice(6);
      // A select answer is stored as its code, not its wording, so it renders
      // and filters the same as one submitted through the form.
      const options = opts.form.optionLabels.get(key);
      const code = options?.get(normaliseHeader(raw));
      out.fields[key] = code ?? raw;
      return;
    }

    const id = target.slice(5);
    const spec = CASE_TARGET_BY_ID.get(id);
    if (!spec) {
      out.issues.push({ row: index, column: header, message: `Unknown target ${target}`, severity: 'error' });
      return;
    }

    switch (spec.type) {
      case 'text':
        out.caseProps[id] = raw;
        break;
      case 'email': {
        const email = raw.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          out.issues.push({ row: index, column: header, message: `Not a valid email: ${raw}`, severity: 'warning' });
          break;
        }
        out.caseProps[id] = email;
        break;
      }
      case 'date': {
        const date = parseDate(raw, opts.dateOrder);
        if (!date) {
          out.issues.push({ row: index, column: header, message: `Unreadable date: ${raw}`, severity: 'warning' });
          break;
        }
        out.caseProps[id] = date.toISOString();
        break;
      }
      case 'boolean': {
        const value = parseBoolean(raw);
        if (value === null) {
          out.issues.push({ row: index, column: header, message: `Not a yes/no value: ${raw}`, severity: 'warning' });
          break;
        }
        out.caseProps[id] = value;
        break;
      }
      case 'requestTypes': {
        // Several types in one cell is normal; the separator varies.
        const parts = raw.split(/[;|]|\s*,\s(?=[A-ZÀ-Ý])/).map((p) => p.trim()).filter(Boolean);
        const codes: string[] = [];
        for (const part of parts.length ? parts : [raw]) {
          const n = normaliseHeader(part);
          const code = opts.form.requestTypeLabels.get(n) ?? (opts.form.requestTypeValues.has(part) ? part : null);
          if (code) codes.push(code);
          else {
            out.issues.push({
              row: index,
              column: header,
              message: `Request type not offered by this form: ${part}`,
              severity: 'warning',
            });
          }
        }
        if (codes.length) out.caseProps.requestTypes = [...new Set(codes)];
        break;
      }
      case 'progress': {
        const mapped = mapProgress(raw);
        if (!mapped) {
          out.issues.push({
            row: index,
            column: header,
            message: `Unrecognised status "${raw}" — imported as open`,
            severity: 'warning',
          });
          out.caseProps.status = 'open';
          break;
        }
        out.caseProps.status = mapped.status;
        out.reportPublished = mapped.published;
        out.reportAccessed = mapped.accessed;
        break;
      }
      case 'appealStatus': {
        const value = mapAppealStatus(raw);
        if (!value) {
          out.issues.push({ row: index, column: header, message: `Unrecognised appeal status: ${raw}`, severity: 'warning' });
          break;
        }
        out.caseProps.appealStatus = value;
        break;
      }
    }
  });

  // A case with no arrival time cannot be aged, reported on, or placed in a
  // queue in the right order, so this is the one column that is not optional.
  if (!out.caseProps.createdAt) {
    out.issues.push({ row: index, message: 'No usable created date', severity: 'error' });
  }
  return out;
}
