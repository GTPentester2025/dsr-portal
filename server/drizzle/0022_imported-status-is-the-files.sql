-- The status of an imported case is whatever the file said it was.
--
-- Two things were quietly overriding that.
--
-- The SLA sweep rewrites `cases.status` to 'overdue' for any open case past
-- its deadline. An imported backlog is entirely made of those, so a case
-- uploaded as `open` or `pending` became `overdue` within sixty seconds —
-- a change to a record that no upload asked for, and the opposite of "these
-- change only by a later upload". The clock is a live-work instrument and an
-- imported case is not being worked here, so its clock is stopped at import
-- and the sweep never considers it.
--
-- And the mapping itself flattened anything it did not recognise to `open`,
-- losing what the source system actually called it.

-- The verbatim progress value from the file, kept alongside the status it was
-- mapped to. A compliance record should be able to show what the system of
-- record said, not only this portal's nearest equivalent.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS source_status text;
--> statement-breakpoint

COMMENT ON COLUMN cases.source_status IS
  'For imported cases: the progress value exactly as the source export wrote '
  'it, before mapping onto this portal''s statuses.';
--> statement-breakpoint

/*
 * Stop the clock on every imported case, not only the closed ones.
 *
 * A running clock is what draws the sweep in: it breaches the clock, then
 * rewrites the case status. Stopping it is the honest state anyway — the
 * deadline on an imported case was met or missed by another system, and this
 * one is not counting down to anything.
 *
 * `due_at` is untouched, so the deadline the case actually had is still on the
 * record and still reportable; it is the countdown that stops, not the fact.
 */
UPDATE sla_clocks sc
   SET state = 'stopped'
  FROM cases c
 WHERE sc.case_id = c.id
   AND c.source = 'import'
   AND sc.state <> 'stopped';
--> statement-breakpoint

-- Undo the drift already caused: any imported case the sweep pushed to
-- 'overdue' goes back to what it was uploaded as, where the timeline can still
-- say. Cases imported before this are the only ones affected, and the entry
-- the sweep wrote is left in place rather than rewritten — it happened.
UPDATE cases c
   SET status = h.from_status, updated_at = now()
  FROM (
    SELECT DISTINCT ON (case_id) case_id, from_status
      FROM case_status_history
     WHERE to_status = 'overdue' AND note = 'SLA breached (system)'
       AND from_status IS NOT NULL
     ORDER BY case_id, id DESC
  ) h
 WHERE c.id = h.case_id
   AND c.source = 'import'
   AND c.status = 'overdue';
