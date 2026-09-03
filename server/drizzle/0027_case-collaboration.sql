-- Working a queue, not just recording it.
--
-- priority: a flat queue treats a regulator's letter and a routine access
-- request identically; two levels ('normal' | 'high') is deliberately all
-- there is, because a five-level scale collapses into "everything is P2".
--
-- tags: cross-cutting labels ('vip', 'legal-review') that are not statuses --
-- a case is *in* one state but can be *about* several things at once.
--
-- snoozed_until: an operator's own "look again on Tuesday". Operational only:
-- it never touches the SLA clock, which belongs to the regulator, not the
-- operator's attention.
--
-- case_watchers: people who asked to be told when a case moves. Ownership
-- stays singular (assignee_id); watching is how a colleague keeps an eye on a
-- case they handed over or care about without owning it.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE cases ADD CONSTRAINT cases_priority_chk CHECK (priority IN ('normal', 'high'));
--> statement-breakpoint
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE cases ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
--> statement-breakpoint

-- Partial: nearly every case is 'normal', and the only query is "the high ones".
CREATE INDEX IF NOT EXISTS cases_priority_ix ON cases (priority) WHERE priority <> 'normal';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS case_watchers (
  case_id    uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);
--> statement-breakpoint

-- Zone isolation via the parent case, write roles as 0013 grants every other
-- case child. Delete is NOT restricted to administrators: unwatching your own
-- row is the point of the feature.
ALTER TABLE case_watchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_watchers_zone ON case_watchers
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint
CREATE POLICY case_watchers_delete_role ON case_watchers AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
