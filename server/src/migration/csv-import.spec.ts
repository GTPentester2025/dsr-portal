import {
  coerceRow,
  decodeUpload,
  detectDateOrder,
  indexForm,
  mapProgress,
  parseBoolean,
  parseDate,
  parseDelimited,
  proposeMapping,
  type FormIndex,
} from './csv-import';
import { collectInputs, type Component } from '../public/form-validation';

/**
 * The importer's job is to be boringly literal about a file somebody else
 * produced. These cover the places where being slightly wrong is silent: date
 * order, encoding, embedded delimiters, and a status column that means two
 * things at once.
 */

const SCHEMA = {
  components: [
    {
      key: 'ticket_type',
      type: 'dsrradio',
      label: 'Select type of request',
      input: true,
      values: [
        { label: 'Ter acesso aos meus dados pessoais', value: 'access' },
        { label: 'Solicitar a exclusão dos meus dados pessoais', value: 'erasure' },
      ],
    },
    { key: 'cpf_brazil', type: 'textfield', label: 'CPF', input: true },
    { key: 'phone', type: 'dsrphoneNumber', label: 'Phone', input: true },
    {
      key: 'i_am_a',
      type: 'select',
      label: 'I am a ...',
      input: true,
      data: { values: [{ label: 'Consumer', value: 'consumer' }] },
    },
  ] as Component[],
  i18n: {
    'pt-br': { CPF: 'CPF', Phone: 'Telefone' },
  },
};

function form(): FormIndex {
  return indexForm(SCHEMA, collectInputs);
}

describe('parseDelimited', () => {
  it('reads quoted fields containing the delimiter and newlines', () => {
    const file = parseDelimited('a,b\r\n1,"he said ""hi"", then left"\r\n2,"two\nlines"\r\n');
    expect(file.headers).toEqual(['a', 'b']);
    expect(file.rows).toEqual([
      ['1', 'he said "hi", then left'],
      ['2', 'two\nlines'],
    ]);
  });

  it('sniffs a semicolon file without being fooled by commas inside quotes', () => {
    const file = parseDelimited('id;"name, full"\r\n1;Ada\r\n');
    expect(file.delimiter).toBe(';');
    expect(file.headers).toEqual(['id', 'name, full']);
  });

  it('drops trailing blank lines rather than importing empty cases', () => {
    expect(parseDelimited('a,b\n1,2\n\n\n').rows).toEqual([['1', '2']]);
  });
});

describe('decodeUpload', () => {
  it('reads UTF-8', () => {
    const { text, encoding } = decodeUpload(Buffer.from('exclusão', 'utf-8'));
    expect(encoding).toBe('utf-8');
    expect(text).toBe('exclusão');
  });

  it('falls back to the Windows code page rather than producing replacement characters', () => {
    // 0xE3 is "ã" in cp1252 and an invalid lead byte in UTF-8.
    const { text, encoding } = decodeUpload(Buffer.from([0x65, 0x78, 0xe3, 0x6f]));
    expect(encoding).toBe('windows-1252');
    expect(text).toBe('exão');
  });

  it('strips a byte order mark', () => {
    expect(decodeUpload(Buffer.from('﻿DSR ID', 'utf-8')).text).toBe('DSR ID');
  });
});

describe('dates', () => {
  it('reads day-first when a day above 12 proves it', () => {
    expect(detectDateOrder(['22-07-2026 16:12', '06-08-2026 16:12'])).toEqual({
      order: 'dmy',
      confident: true,
    });
  });

  it('reads month-first when the evidence points the other way', () => {
    expect(detectDateOrder(['07-22-2026', '08-06-2026'])).toEqual({ order: 'mdy', confident: true });
  });

  it('says so when the file gives no evidence either way', () => {
    // Guessing silently here shifts every deadline by months.
    expect(detectDateOrder(['03-04-2026', '05-06-2026'])).toEqual({ order: 'dmy', confident: false });
  });

  it('parses the source format as UTC', () => {
    expect(parseDate('22-07-2026 16:12', 'dmy')?.toISOString()).toBe('2026-07-22T16:12:00.000Z');
    expect(parseDate('07-22-2026 16:12', 'mdy')?.toISOString()).toBe('2026-07-22T16:12:00.000Z');
    expect(parseDate('2026-07-22T16:12', 'iso')?.toISOString()).toBe('2026-07-22T16:12:00.000Z');
  });

  it('rejects an impossible date instead of rolling it over', () => {
    expect(parseDate('45-13-2026', 'dmy')).toBeNull();
    expect(parseDate('not a date', 'dmy')).toBeNull();
  });
});

describe('booleans', () => {
  it('accepts what exports actually write', () => {
    expect(parseBoolean('TRUE')).toBe(true);
    expect(parseBoolean('sim')).toBe(true);
    expect(parseBoolean('FALSE')).toBe(false);
    expect(parseBoolean('não')).toBe(false);
  });

  it('returns null for anything it does not recognise, rather than guessing false', () => {
    expect(parseBoolean('maybe')).toBeNull();
    expect(parseBoolean('')).toBeNull();
  });
});

describe('progress', () => {
  it('separates delivery from closure', () => {
    expect(mapProgress('Report Accessed By Data Subject')).toEqual({
      status: 'closed',
      published: true,
      accessed: true,
    });
    expect(mapProgress('Report Published')).toEqual({
      status: 'closed',
      published: true,
      accessed: false,
    });
  });

  it('imports an overdue case as open and lets the SLA engine decide', () => {
    expect(mapProgress('Overdue')?.status).toBe('open');
  });

  it('reads "pending" out of a longer phrase rather than giving up on it', () => {
    expect(mapProgress('Blocked pending legal')?.status).toBe('pending');
  });

  it('does not match a status word buried inside another word', () => {
    // "Escalated" contains "late"; an unanchored pattern read this as overdue.
    expect(mapProgress('Escalated to the works council')).toBeNull();
  });

  it('returns null for wording it does not know, so the caller can warn', () => {
    expect(mapProgress('Referred to counsel')).toBeNull();
  });
});

describe('proposeMapping', () => {
  it('matches a heading to the form field with that label', () => {
    const file = parseDelimited('CPF,Phone\n049.465.431-71,(65) 90012-8267\n');
    const [cpf, phone] = proposeMapping(file, form());
    expect(cpf.target).toBe('field:cpf_brazil');
    expect(phone.target).toBe('field:phone');
    expect(phone.novel).toBe(false);
  });

  it('recognises the case-level columns by their heading', () => {
    const file = parseDelimited('DSR ID,Created Date,Progress\n100219,22-07-2026 16:12,Report Published\n');
    const targets = proposeMapping(file, form()).map((p) => p.target);
    expect(targets).toEqual(['case:externalId', 'case:createdAt', 'case:progress']);
  });

  it('proposes a new field for an unrecognised column rather than dropping it', () => {
    const file = parseDelimited('Ambev ID\n99848600000000\n');
    const [p] = proposeMapping(file, form());
    expect(p.target).toBe('field:ambev_id');
    expect(p.novel).toBe(true);
  });

  it('ignores columns that describe the tenant rather than the case', () => {
    const file = parseDelimited('Organisation Name\nSAZ\n');
    expect(proposeMapping(file, form())[0].target).toBe('ignore');
  });
});

describe('coerceRow', () => {
  const headers = ['DSR ID', 'Type', 'Progress', 'Created Date', 'CPF', 'Completed After Deadline'];
  const mapping = {
    'DSR ID': 'case:externalId',
    Type: 'case:requestTypes',
    Progress: 'case:progress',
    'Created Date': 'case:createdAt',
    CPF: 'field:cpf_brazil',
    'Completed After Deadline': 'case:completedAfterDeadline',
  };
  const opts = { dateOrder: 'dmy' as const, form: form(), mapping };

  it('turns a source row into case properties and answers', () => {
    const row = coerceRow(
      headers,
      ['100219', 'Ter acesso aos meus dados pessoais', 'Report Published', '22-07-2026 16:12', '049.465.431-71', 'FALSE'],
      2,
      opts,
    );
    expect(row.issues).toEqual([]);
    expect(row.caseProps).toMatchObject({
      externalId: '100219',
      requestTypes: ['access'],
      status: 'closed',
      completedAfterDeadline: false,
    });
    expect(row.reportPublished).toBe(true);
    expect(row.fields).toEqual({ cpf_brazil: '049.465.431-71' });
  });

  it('warns rather than fails on a request type this form does not offer', () => {
    const row = coerceRow(
      headers,
      ['1', 'Something else entirely', 'Report Published', '22-07-2026 16:12', '', ''],
      2,
      opts,
    );
    expect(row.caseProps.requestTypes).toBeUndefined();
    expect(row.issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', column: 'Type' }),
    );
  });

  it('treats a missing created date as an error, because a case cannot be aged without one', () => {
    const row = coerceRow(headers, ['1', '', 'Report Published', '', '', ''], 2, opts);
    expect(row.issues).toContainEqual(
      expect.objectContaining({ severity: 'error', message: 'No usable created date' }),
    );
  });

  it('stores a select answer as its code, not the wording it was shown as', () => {
    const row = coerceRow(
      ['I am a ...', 'Created Date'],
      ['Consumer', '22-07-2026 16:12'],
      2,
      { ...opts, mapping: { 'I am a ...': 'field:i_am_a', 'Created Date': 'case:createdAt' } },
    );
    expect(row.fields).toEqual({ i_am_a: 'consumer' });
  });
});
