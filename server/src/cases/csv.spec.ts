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

  it('puts the BOM only at the start, never per row', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(csvRow(ROWS[0], COLUMNS)).not.toContain('﻿');
    expect(csvHeader(COLUMNS)).not.toContain('﻿');
  });
});
