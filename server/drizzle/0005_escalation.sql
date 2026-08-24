-- Escalation bookkeeping.
--
-- sla_policies.escalation_threshold and assignment_config.escalation_email
-- have been stored since the first migration but nothing ever read them, so
-- no escalation was sent. These columns record what has already fired, which
-- is what makes the sweep idempotent.

-- Threshold escalation: the case is running out of time.
ALTER TABLE sla_clocks ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Staleness escalation: nobody picked the case up.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS unassigned_escalated_at timestamptz;

-- The sweep filters on these every minute.
CREATE INDEX IF NOT EXISTS sla_clocks_escalation_idx
  ON sla_clocks (state) WHERE escalated_at IS NULL;

CREATE INDEX IF NOT EXISTS cases_unassigned_idx
  ON cases (status, created_at) WHERE assignee_id IS NULL;
