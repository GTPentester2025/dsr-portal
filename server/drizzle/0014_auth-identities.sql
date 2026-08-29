-- Where an external identity provider records that one of its accounts is one
-- of ours. Nothing writes this yet: the sign-in strategy that will is a later
-- sub-project. The table exists now so that work has somewhere to attach, and
-- so it arrives under the same role matrix as everything else rather than
-- being retrofitted afterwards.
--
-- `subject` is the provider's stable identifier for the account -- the `sub`
-- claim, not an email address, which changes when someone marries or moves
-- team. UNIQUE (provider, subject) is what stops two portal users claiming the
-- same external identity.
--
-- Deliberately absent: claims, tokens, cached group membership. Those are
-- provider state that is stale the moment it is stored, and a local copy
-- invites being treated as authoritative by code that should have asked the
-- provider. This system holds identity documents; the less it keeps about
-- people, the smaller the thing that can leak.

CREATE TABLE IF NOT EXISTS auth_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  provider      text NOT NULL,
  subject       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_ux
  ON auth_identities (provider, subject);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS auth_identities_user_ix ON auth_identities (user_id);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_identities TO dsr_app;
--> statement-breakpoint

-- Same shape as app_settings in 0013: no zone column, so reads are open and
-- only the write is role-gated. Links are written by the sign-in path under
-- system() and unlinked by a super admin; no other role has business here.
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY auth_identities_role ON auth_identities
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin']));
--> statement-breakpoint

-- A FOR ALL policy's WITH CHECK does not govern DELETE, which is checked
-- against USING alone -- so without this an auditor could delete identity
-- links. Same construction as the fourteen restrictive policies in 0013.
CREATE POLICY auth_identities_delete_role ON auth_identities AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin']));
