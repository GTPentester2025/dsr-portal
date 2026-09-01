-- Editing a group's membership must not break a delegation that has already
-- been accepted.
--
-- groups.service.ts update() used to replace a group's member list wholesale:
-- delete every row, reinsert the new list. `case_delegations
-- .accepted_by_member_id` references case_group_members(id) with the default
-- ON DELETE NO ACTION, so once any member of a group has accepted a
-- delegation, that delete-and-reinsert hits the foreign key on *any* later
-- edit to the group -- adding a person, fixing a typo -- even one that never
-- touches the accepting member, because they get deleted and reinserted under
-- a fresh id along with everyone else. The service is fixed alongside this
-- migration to diff the member list instead of replacing it, so an unrelated
-- edit no longer touches that row at all. This migration covers the case
-- where the member genuinely is removed: that must still be possible, so the
-- constraint needs somewhere to go instead of blocking the delete.
--
-- Two changes, the same shape 0020 used to let a user account be erased
-- without breaking the records that named it:
--
-- 1. accepted_by_member_id becomes ON DELETE SET NULL, so removing a member
--    who has accepted a delegation deletes the member, not the delegation.
-- 2. accepted_by_name snapshots who accepted, the same way audit_log
--    .actor_name and case_status_history.actor_name snapshot a name so the
--    record outlives the row it pointed at. Losing the pointer without this
--    would lose the attribution entirely.
--
-- The constraint is discovered from the catalogue rather than named outright,
-- for the same reason 0020 gives: it may not carry the name Drizzle would
-- have chosen, and a hard-coded name that does not exist would make this
-- file fail on exactly the deployments that need it most.

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class frel ON frel.oid = con.confrelid
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND rel.relname = 'case_delegations'
       AND frel.relname = 'case_group_members'
       AND att.attname = 'accepted_by_member_id'
       AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE case_delegations DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'case_delegations_accepted_by_member_id_fk'
  ) THEN
    EXECUTE
      'ALTER TABLE case_delegations '
      || 'ADD CONSTRAINT case_delegations_accepted_by_member_id_fk '
      || 'FOREIGN KEY (accepted_by_member_id) REFERENCES case_group_members(id) ON DELETE SET NULL';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE case_delegations ADD COLUMN IF NOT EXISTS accepted_by_name text;
--> statement-breakpoint

COMMENT ON COLUMN case_delegations.accepted_by_name IS
  'Snapshot of the accepting member''s name, taken when they accept. Survives accepted_by_member_id being nulled by a later member removal.';
