-- Parity with the fields the previous DSR tool tracked, plus somewhere to put
-- the cases imported from it.
--
-- The gap analysis against a live export showed the intake forms already
-- collect every requester-facing answer, but the case record carried none of
-- the lifecycle facts around them: residency, whether the deadline was missed,
-- whether the extension was automatic, whether the outcome report had been
-- published and read, and the entire appeal window. Those are all things a
-- regulator asks about, so they belong on the case rather than being inferred
-- at report time.

ALTER TABLE cases
  -- Where the requester says they live. Distinct from the form's `country`
  -- field, which only says which form they filled in.
  ADD COLUMN IF NOT EXISTS residency text,
  -- Suppresses the closure notification for requesters handled out of band.
  ADD COLUMN IF NOT EXISTS skip_completion_notification boolean NOT NULL DEFAULT false,
  -- Stamped at closure rather than derived, so a later SLA edit cannot
  -- retroactively rewrite whether a case was late.
  ADD COLUMN IF NOT EXISTS completed_after_deadline boolean,
  -- True when the deadline moved without a human granting it.
  ADD COLUMN IF NOT EXISTS auto_extended boolean NOT NULL DEFAULT false,
  -- Outcome report delivery, which is not the same event as closing the case.
  ADD COLUMN IF NOT EXISTS report_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS report_accessed_at timestamptz,
  -- Appeal window.
  ADD COLUMN IF NOT EXISTS can_be_appealed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_appeal_until timestamptz,
  ADD COLUMN IF NOT EXISTS is_appeal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS appeal_of_case_id uuid REFERENCES cases(id),
  -- 'requested' | 'under_review' | 'upheld' | 'rejected'; null => no appeal.
  ADD COLUMN IF NOT EXISTS appeal_status text,
  -- Provenance. 'portal' for anything submitted here, 'import' for migrated
  -- rows, so a report can exclude backfill from response-time statistics.
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'portal',
  -- The identifiers the case had in the tool it came from, kept so a row can
  -- be traced back and so re-running an import cannot duplicate it.
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_request_id text,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz;
--> statement-breakpoint

-- Idempotent imports: the same source row can be uploaded twice without
-- creating a second case. Partial so portal cases, which have no external id,
-- are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS cases_external_id_ux
  ON cases (external_id)
  WHERE external_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS cases_source_ix ON cases (source);
--> statement-breakpoint

-- Backfill the flag for cases already closed, so the column is not simply
-- null for every historical row.
UPDATE cases
   SET completed_after_deadline = (closed_at > due_at)
 WHERE status = 'closed' AND closed_at IS NOT NULL AND due_at IS NOT NULL
   AND completed_after_deadline IS NULL;
--> statement-breakpoint

-- How long after closure a requester may appeal, per zone and request type.
-- Zero — the default — means appeals are not offered, which is what every
-- existing policy row silently was.
ALTER TABLE sla_policies
  ADD COLUMN IF NOT EXISTS appeal_window_days integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

-- One row per uploaded file. The parsed rows are held on the record between
-- the analyse step and the commit step so the operator reviews the mapping
-- without having to upload the file a second time, and so a committed import
-- can be explained afterwards from what was actually read.
CREATE TABLE IF NOT EXISTS case_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  source_tool text NOT NULL DEFAULT 'securiti',
  zone_id text NOT NULL REFERENCES zones(id),
  form_key text NOT NULL,
  form_version integer NOT NULL,
  -- 'analysed' | 'committed' | 'failed' | 'discarded'
  status text NOT NULL DEFAULT 'analysed',
  total_rows integer NOT NULL DEFAULT 0,
  imported integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  /* header -> target, as confirmed by the operator */
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  /* the parsed file, discarded once committed */
  payload jsonb,
  /* per-row problems, kept after commit */
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS case_imports_created_ix ON case_imports (created_at DESC);
--> statement-breakpoint

-- Same shape as every other zone-scoped table: visibility by zone, and
-- writing restricted to the roles that may administer one. An import creates
-- cases wholesale, so it is not something an approver or auditor may start.
ALTER TABLE case_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY case_imports_zone_role ON case_imports
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_zone_allows(zone_id)
    AND app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

CREATE POLICY case_imports_delete_role ON case_imports AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin','zone_manager']));
--> statement-breakpoint

-- Imported cases are historical records, not live correspondence: nothing in
-- the portal should email a requester about a case it never received.
COMMENT ON COLUMN cases.source IS
  'portal | import — imported cases are excluded from requester notifications';
