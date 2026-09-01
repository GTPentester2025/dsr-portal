-- Two things case delegation claimed and did not have.
--
-- 1. AN UPLOAD BELONGS TO A DELEGATION, NOT MERELY TO A CASE.
--
-- The public page's payload listed every `source = 'delegate'` attachment on
-- the case. The lifecycle is send to HR, close, send to Legal -- so Legal's
-- link listed the filenames HR chose, and HR's closed-but-still-resolvable
-- link went on listing Legal's, forever. A filename is free text typed by an
-- unauthenticated uploader who has been told in the approver's note who the
-- case is about, which makes this one group's prose delivered to another group
-- over a bearer link: exactly the disclosure section 5 of the design says this
-- link never makes. Scoping it needs a column saying which delegation an
-- upload arrived through.
--
-- Nullable, and rows already in the table keep NULL. They arrived before
-- uploads were scoped and there is no way to attribute them after the fact.
-- NULL reads as "belongs to no delegation", which is what makes them appear on
-- none of them rather than on all of them -- the safe direction, since the
-- failure being fixed is over-disclosure.
--
-- 2. THE WRITE-ROLE HALF OF THE RLS 0023 SAID IT WAS APPLYING.
--
-- 0023's comment promises "Zone isolation and write roles, exactly as 0013
-- does for every other zone-scoped table", and `case_groups` does carry
-- app_role_may_write. `case_delegations` and `case_group_members` carry the
-- zone check alone, so an auditor -- refused at the route by
-- @Requires('cases.work') -- was still permitted at the database. Nothing
-- exposes that today; the defence in depth 0013 exists to provide simply was
-- not there. The role array is the same one every case-work table carries,
-- because sending a case to a group and maintaining the list of who to send it
-- to are both `cases.work`, held by exactly these roles.

ALTER TABLE case_attachments
  ADD COLUMN IF NOT EXISTS delegation_id uuid REFERENCES case_delegations(id);
--> statement-breakpoint

-- Partial: only delegate uploads ever carry a value, and the query this
-- supports always has one to look for.
CREATE INDEX IF NOT EXISTS case_attachments_delegation_ix
  ON case_attachments (delegation_id)
  WHERE delegation_id IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN case_attachments.delegation_id IS
  'The delegation a file arrived through, for source = ''delegate'' rows. NULL everywhere else, including delegate uploads that predate this column: a delegation''s public payload lists only its own files.';
--> statement-breakpoint

-- Drop and recreate rather than CREATE OR REPLACE, the house pattern from
-- 0013: a policy that is not there yet must not make the migration fail.
DROP POLICY IF EXISTS case_delegations_zone ON case_delegations;
--> statement-breakpoint
CREATE POLICY case_delegations_zone ON case_delegations
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_group_members_zone ON case_group_members;
--> statement-breakpoint
CREATE POLICY case_group_members_zone ON case_group_members
  USING (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

-- A FOR ALL policy's WITH CHECK does not govern DELETE, which is decided by
-- USING alone -- so without this, editing a group's membership (which deletes
-- the removed rows) is open to any role the zone check lets through.
-- case_groups already has the matching policy; its members table did not.
DROP POLICY IF EXISTS case_group_members_delete_role ON case_group_members;
--> statement-breakpoint
CREATE POLICY case_group_members_delete_role ON case_group_members AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
