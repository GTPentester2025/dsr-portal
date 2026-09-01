import { toCsv, csvHeader, csvRow, CSV_BOM, type CsvColumn } from './csv';

interface Row { name: string; note: string }
const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Note', value: (r) => r.note },
];
const ROWS: Row[] = [
  { name: 'Ada', note: 'plain' },
  { name: 'Bob', note: 'has, comma' },
  { name: 'Cy', note: '=HYPERLINK("http://evil")' },
];

describe('csv streaming pieces', () => {
  it('streams byte-identically to the buffered form', () => {
    const streamed =
      CSV_BOM + [csvHeader(COLUMNS), ...ROWS.map((r) => csvRow(r, COLUMNS))].join('\r\n') + '\r\n';
    expect(streamed).toBe(toCsv(ROWS, COLUMNS));
  });

  it('still neutralises a formula in a streamed row', () => {
    const line = csvRow(ROWS[2], COLUMNS);
    expect(line).toContain(`'=HYPERLINK`);
    expect(line).not.toMatch(/(^|,)"?=HYPERLINK/);
  });

  it('still quotes a value containing a comma', () => {
    expect(csvRow(ROWS[1], COLUMNS)).toContain('"has, comma"');
  });

  it('emits a header without a trailing newline', () => {
    expect(csvHeader(COLUMNS)).toBe('Name,Note');
  });

  it('produces exactly these bytes', () => {
    // Written out by hand rather than assembled from the same helpers under
    // test: every other case here compares one composition of cell() against
    // another, so a bug inside cell() or neutralise() would satisfy both
    // sides. The BOM is spelled as an escape below so that it is visible; the
    // leading ' on the last field is the formula-injection guard, and the
    // doubled quotes are RFC 4180 escaping.
    expect(toCsv(ROWS, COLUMNS)).toBe(
      '\uFEFF' +
        'Name,Note\r\n' +
        'Ada,plain\r\n' +
        'Bob,"has, comma"\r\n' +
        'Cy,"\'=HYPERLINK(""http://evil"")"\r\n',
    );
  });

  it('puts the BOM only at the start, never per row', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(csvRow(ROWS[0], COLUMNS)).not.toContain('﻿');
    expect(csvHeader(COLUMNS)).not.toContain('﻿');
  });
});

/**
 * Excel is not a neutral reader: as well as executing a leading `=`, it
 * rewrites long digit strings as floats. Both are silent, and both destroy the
 * record rather than displaying it oddly.
 */
describe('long identifiers', () => {
  const value = (v: unknown) =>
    toCsv([{ v } as { v: unknown }], [{ header: 'v', value: (r) => r.v }]);

  it('pins a long identifier to text so it is not rewritten as a float', () => {
    // The export this was measured against turned this exact kind of value
    // into 9.98486E+13, losing the account it identified.
    expect(value('99848600000000')).toBe(CSV_BOM + `v\r\n'99848600000000\r\n`);
  });

  it('leaves a short number alone -- a quantity is still a quantity', () => {
    expect(value('100219')).toBe(CSV_BOM + 'v\r\n100219\r\n');
  });

  it('does not touch a long string that is not all digits', () => {
    expect(value('9984-8600-0000-00')).toBe(CSV_BOM + 'v\r\n9984-8600-0000-00\r\n');
  });

  it('joins a multi-valued answer rather than dumping JSON', () => {
    expect(value(['access', 'erasure'])).toBe(CSV_BOM + 'v\r\naccess; erasure\r\n');
  });

  it('renders an empty cell for a value the case does not have yet', () => {
    expect(value(null)).toBe(CSV_BOM + 'v\r\n\r\n');
  });
});
