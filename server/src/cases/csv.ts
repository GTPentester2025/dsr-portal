/**
 * CSV serialisation for the export buttons.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: the rules that
 * matter here are quoting and injection, both of which are a few lines.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/**
 * Excel and Sheets treat a leading =, +, - or @ as the start of a formula, so a
 * requester who types `=HYPERLINK(...)` into a form field would have it execute
 * when a colleague opens the export. Prefixing a single quote neutralises that
 * while still displaying the original text.
 */
function neutralise(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.join('; ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const safe = neutralise(raw);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(','));
  // CRLF and a UTF-8 BOM: without the BOM Excel mangles non-ASCII names, which
  // this data is full of.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

/** RFC 5987 filename, timestamped so repeated downloads do not overwrite. */
export function csvFilename(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.csv`;
}
