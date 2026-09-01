-- Sending a case to people who do not use this portal.
--
-- Working a request often needs somebody outside the privacy team: HR to
-- confirm employment dates, Legal to check for a hold. That exchange happens
-- in Outlook today, so who was asked and what came back live in one person's
-- mailbox rather than in the case file.
--
-- A group is a standing list of those people. A delegation is one send to one
-- group, addressed by a single bearer token whose permitted action depends on
-- how far the delegation has got.

CREATE TABLE IF NOT EXISTS case_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id         text NOT NULL REFERENCES zones(id),
  name            text NOT NULL,
  /* Pre-filled when sending to this group, editable before it goes. */
  default_message text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_groups_zone_name_ux
  ON case_groups (zone_id, lower(name));
--> statement-breakpoint

-- No account, no password, no role: a display name and somewhere to write to.
CREATE TABLE IF NOT EXISTS case_group_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES case_groups(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_group_members_group_email_ux
  ON case_group_members (group_id, lower(email));
--> statement-breakpoint

/*
 * One row per send.
 *
 * `token_hash` only: the plaintext exists in the email and nowhere else, so a
 * database dump does not hand over working links. Same treatment
 * verification_tokens already gets.
 *
 * `stage` is what the token permits. 'sent' allows accepting, 'accepted'
 * allows uploading, 'closed' allows nothing -- so an action becomes impossible
 * the moment the stage it belonged to is past.
 */
CREATE TABLE IF NOT EXISTS case_delegations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                uuid NOT NULL REFERENCES cases(id),
  group_id               uuid NOT NULL REFERENCES case_groups(id),
  zone_id                text NOT NULL REFERENCES zones(id),
  token_hash             text NOT NULL,
  stage                  text NOT NULL DEFAULT 'sent',
  note                   text NOT NULL DEFAULT '',
  accepted_by_member_id  uuid REFERENCES case_group_members(id),
  accepted_at            timestamptz,
  closed_at              timestamptz,
  closed_by              uuid REFERENCES users(id),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_delegations_token_ux
  ON case_delegations (token_hash);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS case_delegations_case_ix
  ON case_delegations (case_id, created_at DESC);
--> statement-breakpoint

-- Only one delegation may be live on a case at a time. Two open links to the
-- same case is two groups each believing the other is not involved.
CREATE UNIQUE INDEX IF NOT EXISTS case_delegations_one_open_ux
  ON case_delegations (case_id)
  WHERE stage <> 'closed';
--> statement-breakpoint

-- Zone isolation and write roles, exactly as 0013 does for every other
-- zone-scoped table.
ALTER TABLE case_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_groups_zone_role ON case_groups
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint
CREATE POLICY case_groups_delete_role ON case_groups AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

ALTER TABLE case_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_group_members_zone ON case_group_members
  USING (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM case_groups g WHERE g.id = group_id AND app_zone_allows(g.zone_id)));
--> statement-breakpoint

ALTER TABLE case_delegations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_delegations_zone ON case_delegations
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id));
--> statement-breakpoint

-- Uploads arriving this way are marked so the case file says where each
-- document came from.
COMMENT ON COLUMN case_delegations.stage IS
  'sent | accepted | closed. Decides what the delegation token permits.';
