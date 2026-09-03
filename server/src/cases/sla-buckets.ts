/**
 * The four SLA buckets, as SQL, in exactly one place.
 *
 * The dashboard cards, the case list's drill-down filter and the CSV export
 * must agree on what "at risk" means — a card that says 12 and a list that
 * shows 11 is worse than no drill-down at all. Both sides previously carried
 * their own copy of these predicates; this module is the copy.
 *
 * `alias` is the table alias the predicate is written against (`c` everywhere
 * today). AT_RISK_DAYS is the shared threshold; if it ever becomes a setting,
 * it changes here and nowhere else.
 */
export const AT_RISK_DAYS = 3;

const window = `interval '${AT_RISK_DAYS} days'`;

export function slaBucketSql(alias: string): Record<'closed' | 'overdue' | 'at_risk' | 'on_track', string> {
  return {
    closed: `${alias}.status = 'closed'`,
    overdue: `${alias}.status <> 'closed' AND ${alias}.due_at < now()`,
    at_risk: `${alias}.status <> 'closed' AND ${alias}.due_at BETWEEN now() AND now() + ${window}`,
    on_track: `${alias}.status <> 'closed' AND ${alias}.due_at > now() + ${window}`,
  };
}
