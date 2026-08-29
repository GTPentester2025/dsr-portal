-- The case list orders every page by created_at and there has never been an
-- index on it. audit_log got the equivalent in 0000; cases did not.
--
-- Note what is deliberately NOT here: an index on (zone_id, created_at).
-- Row-level security filters with app_zone_allows(zone_id), a function call
-- rather than an equality, so the planner cannot turn it into a range scan on
-- zone_id -- a zone-prefixed index would sit unused. Indexing the sort key
-- alone lets the planner walk created_at in order, evaluate the RLS predicate
-- per row, and stop when the page is full.
--
-- cases_zone_ix from 0000 is left in place. It is probably unused for the same
-- reason, but dropping an index on the strength of reasoning about a planner
-- nobody has run here is the worse trade.

CREATE INDEX IF NOT EXISTS cases_created_ix ON cases (created_at DESC);
--> statement-breakpoint

-- The country lookup in the list query is a LATERAL keyed on both columns;
-- case_fields_case_ix from 0000 covers only case_id.
CREATE INDEX IF NOT EXISTS case_fields_case_key_ix ON case_fields (case_id, field_key);
--> statement-breakpoint

-- All three SLA filters pair due_at with exactly this predicate, so the partial
-- index is both smaller than a full one and a precise match for the query.
CREATE INDEX IF NOT EXISTS cases_due_open_ix ON cases (due_at) WHERE status <> 'closed';
