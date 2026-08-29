-- Role authorization, in the database rather than only in a decorator.
--
-- app.current_role has been set on every transaction since 0001 and no policy
-- has ever read it. This migration makes it load-bearing: writes are now
-- checked against the role that opened the transaction, so an application bug
-- cannot let an auditor write a case.
--
-- ESCAPE HATCH. If a predicate here is wrong and operators are locked out,
-- one statement restores the previous behaviour without a rollback:
--
--   CREATE OR REPLACE FUNCTION app_role_may_write(text[]) RETURNS boolean
--     AS $$ SELECT true $$ LANGUAGE sql STABLE;
--
-- Role enforcement then falls back to the application layer, which is where it
-- lived before this migration. Restore the real function afterwards.

CREATE OR REPLACE FUNCTION app_role_may_write(allowed text[]) RETURNS boolean AS $$
  SELECT current_setting('app.current_role', true) = ANY(allowed);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ---------------------------------------------------------------- case data --
-- Everyone who works cases may write them; the auditor may not.

DROP POLICY IF EXISTS cases_zone_isolation ON cases;
--> statement-breakpoint
CREATE POLICY cases_zone_isolation ON cases
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_fields_zone ON case_fields;
--> statement-breakpoint
CREATE POLICY case_fields_zone ON case_fields
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_status_history_zone ON case_status_history;
--> statement-breakpoint
CREATE POLICY case_status_history_zone ON case_status_history
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_comments_zone ON case_comments;
--> statement-breakpoint
CREATE POLICY case_comments_zone ON case_comments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS case_attachments_zone ON case_attachments;
--> statement-breakpoint
CREATE POLICY case_attachments_zone ON case_attachments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS sla_clocks_zone ON sla_clocks;
--> statement-breakpoint
CREATE POLICY sla_clocks_zone ON sla_clocks
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

DROP POLICY IF EXISTS email_log_zone ON email_log;
--> statement-breakpoint
CREATE POLICY email_log_zone ON email_log
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id))
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager','approver']));
--> statement-breakpoint

-- ------------------------------------------------------ administrative data --
-- Zone-scoped configuration. An approver may read it and may not write it.
--
-- Note on users with no zone: app_zone_allows(NULL) is NULL, which fails the
-- check, so admins, auditors and super admins are writable only from a
-- zone = '*' context. That is the intended rule -- a zone manager pinned to
-- EUR must not be able to edit a global account -- and it is enforced here
-- rather than only in the controller.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_zone_role ON users
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

-- form_versions, sla_policies, templates and assignment_config are all
-- zone-scoped per the matrix: WITH CHECK must re-verify the zone, not only
-- the role, or a zone manager could write another zone's config through a
-- role-only check. templates.zone_id is nullable by design (null => global,
-- see server/src/db/schema.ts) and the admin UI offers that choice, so the
-- OR zone_id IS NULL branch is required there; it is a no-op on the other
-- three tables, whose zone_id is NOT NULL.

ALTER TABLE form_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY form_versions_zone_role ON form_versions
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK ((app_zone_allows(zone_id) OR zone_id IS NULL)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE sla_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sla_policies_zone_role ON sla_policies
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK ((app_zone_allows(zone_id) OR zone_id IS NULL)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY templates_zone_role ON templates
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK ((app_zone_allows(zone_id) OR zone_id IS NULL)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

ALTER TABLE assignment_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assignment_config_zone_role ON assignment_config
  USING (app_zone_allows(zone_id) OR zone_id IS NULL)
  WITH CHECK ((app_zone_allows(zone_id) OR zone_id IS NULL)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

-- ------------------------------------------------------------ global config --
-- No zone column, so reads are unrestricted and only the write is role-gated.
-- app_settings reads must stay open: SettingsService.refresh() loads the cache
-- at boot, before any user context exists.

ALTER TABLE system_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_templates_role ON system_templates
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin']));
--> statement-breakpoint

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_settings_role ON app_settings
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin']));
