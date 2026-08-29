/**
 * Cursor helpers for paging an export in batches.
 *
 * The cursor is the pair (created_at, id), not created_at alone. Two cases
 * created in the same millisecond are not rare in a system fed by a public
 * form, and a timestamp-only cursor either re-reads one of them in the next
 * batch or steps past it -- a duplicated or missing row in a regulatory export.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

/**
 * The predicate continuing from `cursor`, or nothing for the first batch.
 * `nextParamIndex` is the first free $n in the caller's parameter list.
 *
 * `columns` names the ordering pair for callers whose table is aliased
 * differently -- the audit log pages on (a.created_at, a.id). It still has to
 * be the *pair*: a single-column id cursor is only safe when id order and
 * created_at order agree, and they do not have to. now() is the transaction
 * start time, so a long transaction can insert a row with a lower id and an
 * earlier created_at than a short one that started later, and `id < cursor`
 * would then step over it.
 *
 * The comparison is `<` because both columns are ordered DESC. A row-value
 * comparison is a single lexicographic test in the same direction as the
 * ORDER BY, which is what makes it exact; mixing directions between the two
 * columns, or comparing them independently, would not be.
 */
export function cursorClause(
  cursor: Cursor | null,
  nextParamIndex: number,
  columns: readonly [string, string] = ['c.created_at', 'c.id'],
): { sql: string; params: unknown[] } {
  if (!cursor) return { sql: '', params: [] };
  return {
    sql: ` AND (${columns[0]}, ${columns[1]}) < ($${nextParamIndex}, $${nextParamIndex + 1})`,
    params: [cursor.createdAt, cursor.id],
  };
}

/** The last row of a batch, or null when the batch is empty and the loop ends. */
export function nextCursor<T extends { createdAt: unknown; id: string }>(
  batch: T[],
): Cursor | null {
  const last = batch[batch.length - 1];
  if (!last) return null;
  const createdAt =
    last.createdAt instanceof Date ? last.createdAt.toISOString() : String(last.createdAt);
  return { createdAt, id: last.id };
}
