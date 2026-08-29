-- The case list orders every page by (created_at DESC, id DESC) and there has
-- never been an index on it. The id is not decoration: it breaks ties between
-- cases created in the same millisecond, and the CSV export pages through this
-- ordering with a row-value cursor -- (created_at, id) < (x, y) -- which the
-- planner can only satisfy from the index start if both columns are in it, in
-- this order and this direction. Leading-column-only would make every batch
-- after the first re-walk the rows already exported.
--
-- Note what is deliberately NOT here: an index on (zone_id, created_at).
-- Row-level security filters with app_zone_allows(zone_id), a function call
-- rather than an equality, so the planner cannot turn it into a range scan on
-- zone_id -- a zone-prefixed index would sit unused. Indexing the sort key
-- alone -- both of its columns and nothing else -- lets the planner walk it in
-- order, evaluate the RLS predicate per row, and stop when the page is full.
--
-- cases_zone_ix from 0000 is left in place. It is probably unused for the same
-- reason, but dropping an index on the strength of reasoning about a planner
-- nobody has run here is the worse trade.

CREATE INDEX IF NOT EXISTS cases_created_ix ON cases (created_at DESC, id DESC);
--> statement-breakpoint

-- The audit log export pages the same way, and 0000 indexed created_at alone.
-- Its id is a bigserial, but the ordering is still by created_at, so the cursor
-- is the same pair and wants the same index. audit_log_created_ix is left in
-- place: the audit list screen filters on created_at without the id.
CREATE INDEX IF NOT EXISTS audit_log_created_id_ix
  ON audit_log (created_at DESC, id DESC);
--> statement-breakpoint

-- The country lookup in the list query is a LATERAL keyed on both columns;
-- case_fields_case_ix from 0000 covers only case_id.
CREATE INDEX IF NOT EXISTS case_fields_case_key_ix ON case_fields (case_id, field_key);
--> statement-breakpoint

-- All three SLA filters pair due_at with exactly this predicate, so the partial
-- index is both smaller than a full one and a precise match for the query.
CREATE INDEX IF NOT EXISTS cases_due_open_ix ON cases (due_at) WHERE status <> 'closed';
