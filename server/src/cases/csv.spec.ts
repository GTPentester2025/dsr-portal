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
