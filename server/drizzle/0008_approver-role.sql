-- "Approver" replaces "zone agent", and per-case assignment goes away.
--
-- Every approver in a zone is responsible for every request in that zone, so
-- routing a case to one named person was ceremony that added a failure mode:
-- an unassigned case notified nobody. Notifications now go to all approvers in
-- the zone, with the zone's managers copied.
--
-- assignee_id is kept rather than dropped: closed cases record who handled them
-- and the audit trail references it. It is simply no longer set automatically.

UPDATE users SET role = 'approver' WHERE role = 'zone_agent';

-- Auto-assignment strategies no longer mean anything; leave the column so the
-- escalation contact beside it is untouched, but stop implying a choice.
UPDATE assignment_config SET strategy = 'manual' WHERE strategy <> 'manual';

COMMENT ON COLUMN users.role IS
  'super_admin | admin | zone_manager | approver | auditor';
COMMENT ON COLUMN cases.assignee_id IS
  'Optional. Records who took ownership; not used for routing since 0008.';
