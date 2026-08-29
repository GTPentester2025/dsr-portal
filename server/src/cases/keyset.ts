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
 * *start* time, so a transaction that begins early and writes late takes a
 * higher id than a shorter one that began after it, while carrying the earlier
 * created_at. Ordered by created_at that row sorts second, and `id < cursor`
 * -- the cursor being the higher id of the row before it -- steps over it.
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
    // The timestamp is cast rather than left for the planner to infer: pg sends
    // parameters untyped, and inference inside a row comparison is a detail
    // nobody should have to be sure of to trust an export.
    sql:
      ` AND (${columns[0]}, ${columns[1]})` +
      ` < ($${nextParamIndex}::timestamptz, $${nextParamIndex + 1})`,
    params: [cursor.createdAt, cursor.id],
  };
}

/**
 * The cursor carries `createdAt` as text, and it has to stay text. timestamptz
 * is stored to the microsecond; a JS Date holds milliseconds, so a value that
 * has been through `new Date()` is rounded down. A cursor of .123000 standing
 * for a row at .123456 drops every row in between -- the ones sorting
 * immediately after it under DESC -- at every batch boundary. Callers select
 * the key as `created_at::text` and pass that through untouched. The Date
 * branch below is a backstop for a caller that did not, and is lossy.
 *
 * Returns the last row of a batch, or null when the batch is empty and the
 * loop ends.
 */
export function nextCursor<T extends { createdAt: unknown; id: string }>(
  batch: T[],
): Cursor | null {
  const last = batch[batch.length - 1];
  if (!last) return null;
  const createdAt =
    last.createdAt instanceof Date ? last.createdAt.toISOString() : String(last.createdAt);
  return { createdAt, id: last.id };
}
