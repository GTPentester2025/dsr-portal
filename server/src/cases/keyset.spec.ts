import { cursorClause, nextCursor } from './keyset';

describe('cursorClause', () => {
  it('is empty for the first batch', () => {
    expect(cursorClause(null, 3)).toEqual({ sql: '', params: [] });
  });

  it('compares the pair, not just the timestamp', () => {
    const { sql, params } = cursorClause({ createdAt: '2026-01-01T00:00:00Z', id: 'abc' }, 3);
    // A row-wise comparison is what makes ties safe: ordering by created_at
    // alone would skip or repeat cases sharing a timestamp.
    expect(sql).toContain('(c.created_at, c.id) <');
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(params).toEqual(['2026-01-01T00:00:00Z', 'abc']);
  });

  it('pages another table on its own aliased pair', () => {
    // The audit log export orders by (a.created_at, a.id) and needs the same
    // predicate against its own alias.
    const { sql } = cursorClause({ createdAt: '2026-01-01T00:00:00Z', id: '42' }, 3, [
      'a.created_at',
      'a.id',
    ]);
    expect(sql).toContain('(a.created_at, a.id) < ($3, $4)');
  });
});

describe('nextCursor', () => {
  it('is null for an empty batch, so the loop ends', () => {
    expect(nextCursor([])).toBeNull();
  });

  it('takes the last row of the batch', () => {
    const batch = [
      { createdAt: '2026-01-02T00:00:00Z', id: 'a' },
      { createdAt: '2026-01-01T00:00:00Z', id: 'b' },
    ];
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00Z', id: 'b' });
  });

  it('distinguishes rows sharing a timestamp', () => {
    const batch = [
      { createdAt: '2026-01-01T00:00:00Z', id: 'b' },
      { createdAt: '2026-01-01T00:00:00Z', id: 'a' },
    ];
    // Same instant, different id: the cursor must carry the id or the next
    // batch re-reads 'b' or skips past 'a'.
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00Z', id: 'a' });
  });

  it('normalises a Date to an ISO string', () => {
    const batch = [{ createdAt: new Date('2026-01-01T00:00:00Z'), id: 'a' }];
    expect(nextCursor(batch)).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: 'a' });
  });
});
