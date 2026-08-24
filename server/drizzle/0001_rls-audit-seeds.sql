-- ===========================================================================
-- Hard zone isolation (spec §9): row-level security enforced in the database,
-- not in controllers. The app sets per-request:
--   SET LOCAL app.current_role = 'admin' | 'zone_manager' | 'zone_agent' | 'auditor' | 'system'
--   SET LOCAL app.current_zone = 'EUR' | 'SAZ' | 'MAZ' | '*'
-- 'admin', 'auditor' and 'system' contexts use zone '*'.
-- The app connects as the non-superuser role dsr_app, so RLS is never
-- bypassed (table owners bypass RLS by default).
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_zone_allows(zone text) RETURNS boolean AS $$
  SELECT current_setting('app.current_zone', true) = '*'
      OR current_setting('app.current_zone', true) = zone;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr_app') THEN
    CREATE ROLE dsr_app LOGIN PASSWORD 'dsr_app';
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO dsr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dsr_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dsr_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dsr_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dsr_app;
--> statement-breakpoint

ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cases_zone_isolation ON cases
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id));
--> statement-breakpoint

-- Child tables inherit isolation through their parent case.
ALTER TABLE case_fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_fields_zone ON case_fields
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint
ALTER TABLE case_status_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_status_history_zone ON case_status_history
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint
ALTER TABLE case_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_comments_zone ON case_comments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint
ALTER TABLE case_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY case_attachments_zone ON case_attachments
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint
ALTER TABLE sla_clocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sla_clocks_zone ON sla_clocks
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY email_log_zone ON email_log
  USING (case_id IS NULL OR EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)))
  WITH CHECK (case_id IS NULL OR EXISTS (SELECT 1 FROM cases c WHERE c.id = case_id AND app_zone_allows(c.zone_id)));
--> statement-breakpoint

-- ===========================================================================
-- Append-only audit log: block UPDATE and DELETE at the database level.
-- ===========================================================================
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM dsr_app;
--> statement-breakpoint

-- ===========================================================================
-- Seeds: zones, statuses, transitions, default SLA policies.
-- Status wording per spec §7 (open question #2 noted; rename is config).
-- ===========================================================================
INSERT INTO zones (id, name) VALUES
  ('EUR', 'Europe'),
  ('SAZ', 'South America Zone'),
  ('MAZ', 'Middle Americas Zone')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO statuses (key, label, color, sort, active, system) VALUES
  ('new',              'New',              '#3b82f6', 10, true, true),
  ('open',             'Open',             '#06b6d4', 20, true, false),
  ('pending',          'Pending',          '#f59e0b', 30, true, false),
  ('pending_approver', 'Pending Approver', '#a855f7', 40, true, false),
  ('extended',         'Extended',         '#f97316', 50, true, true),
  ('overdue',          'Overdue',          '#ef4444', 60, true, true),
  ('closed',           'Closed',           '#6b7280', 70, true, true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO status_transitions (from_status, to_status) VALUES
  ('new', 'open'), ('new', 'closed'),
  ('open', 'pending'), ('open', 'pending_approver'), ('open', 'extended'), ('open', 'closed'),
  ('pending', 'open'), ('pending', 'pending_approver'), ('pending', 'extended'), ('pending', 'closed'),
  ('pending_approver', 'open'), ('pending_approver', 'pending'), ('pending_approver', 'closed'),
  ('extended', 'open'), ('extended', 'pending'), ('extended', 'closed'),
  ('overdue', 'open'), ('overdue', 'pending'), ('overdue', 'extended'), ('overdue', 'closed')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Default statutory clocks (calendar days). Legal must confirm per-zone
-- values (spec §14.3/§14.4); '*' is the per-zone fallback for all types.
INSERT INTO sla_policies (zone_id, request_type, target_days, business_days, timezone, pause_allowed, extension_allowed_days)
VALUES
  ('EUR', '*', 30, false, 'Europe/Brussels', true,  60),  -- GDPR: 1 month, +2 months extension
  ('SAZ', '*', 15, false, 'America/Sao_Paulo', false, 15), -- LGPD access: 15 days; confirm others
  ('MAZ', '*', 20, false, 'America/Mexico_City', true, 10) -- LFPDPPP: 20 days; confirm others
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO assignment_config (zone_id, strategy) VALUES
  ('EUR', 'round_robin'), ('SAZ', 'round_robin'), ('MAZ', 'round_robin')
ON CONFLICT DO NOTHING;
