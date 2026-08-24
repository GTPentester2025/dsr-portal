-- SLA targets in minutes rather than whole days.
--
-- Days made every policy untestable: validating a change meant waiting for the
-- clock to actually run down. Minutes are the storage unit; the API and UI
-- present whichever of minutes/hours/days reads best.

ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS target_minutes integer;

UPDATE sla_policies
   SET target_minutes = target_days * 1440
 WHERE target_minutes IS NULL;

ALTER TABLE sla_policies ALTER COLUMN target_minutes SET NOT NULL;
ALTER TABLE sla_policies ADD CONSTRAINT sla_policies_target_minutes_positive
  CHECK (target_minutes > 0);

ALTER TABLE sla_policies DROP COLUMN IF EXISTS target_days;

-- Escalation delay, same reasoning: hours was the smallest unit available.
ALTER TABLE assignment_config ADD COLUMN IF NOT EXISTS escalation_after_minutes integer;

UPDATE assignment_config
   SET escalation_after_minutes = escalation_after_hours * 60
 WHERE escalation_after_minutes IS NULL;

ALTER TABLE assignment_config ALTER COLUMN escalation_after_minutes SET NOT NULL;
ALTER TABLE assignment_config ALTER COLUMN escalation_after_minutes SET DEFAULT 2880;

ALTER TABLE assignment_config DROP COLUMN IF EXISTS escalation_after_hours;
