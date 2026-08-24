-- `new` is an intake state, not a resting state.
--
-- A case only left `new` when auto-assignment found somebody. With a zone set
-- to the `manual` strategy — or with no assignable approver — the case stayed
-- `new` until it aged straight into `overdue`, which is how 21 live cases came
-- to sit in `new` with 5 already breached.
--
-- Intake now moves every verified case into `open` whether or not it could be
-- assigned, so `new` never persists. This migration brings the existing rows
-- into line and records why, so the timeline explains the jump.

INSERT INTO status_transitions (from_status, to_status) VALUES
  ('new', 'pending')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO case_status_history (case_id, from_status, to_status, note)
SELECT id, 'new', 'open',
       'Moved to the work queue: new is an intake state and is no longer held'
  FROM cases
 WHERE status = 'new';
--> statement-breakpoint

-- Unassigned work is waiting on the zone team, not on the requester.
UPDATE cases
   SET status = 'open',
       pending_party = COALESCE(pending_party, 'internal'),
       pending_on = COALESCE(pending_on, zone_id || ' team'),
       pending_since = COALESCE(pending_since, now()),
       updated_at = now()
 WHERE status = 'new';
