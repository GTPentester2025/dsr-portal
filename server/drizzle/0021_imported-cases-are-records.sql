-- Imported cases are records, and a later upload is how they change.
--
-- A case brought in from another tool is a record of something that already
-- happened somewhere else: received, worked and answered by a different
-- system, possibly years ago. The portal keeps it findable, exportable and
-- auditable, and does not work it — no status changes, no assignment, no SLA
-- clock, and above all nothing ever sent to the person who raised it.
--
-- That leaves one way for such a case to change, which is the way it arrived:
-- uploading a newer export. This migration makes that possible and makes the
-- boundary explicit in the database rather than only in the application.

-- An answer is one row per case per field. That was already true in practice —
-- intake writes each key once — but only as a convention, and a re-import now
-- upserts answers, which needs it to be a guarantee. Any duplicates from
-- before are collapsed to the most recent, since the last write is what the
-- most recent upload asserted.
DELETE FROM case_fields a
 USING case_fields b
 WHERE a.case_id = b.case_id
   AND a.field_key = b.field_key
   AND a.id < b.id;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS case_fields_case_key_ux
  ON case_fields (case_id, field_key);
--> statement-breakpoint

-- The redundant non-unique index the above supersedes.
DROP INDEX IF EXISTS case_fields_case_key_ix;
--> statement-breakpoint

-- An upload now reports four outcomes, not three: rows that created a case,
-- rows that updated one already here, rows that changed nothing, and rows that
-- failed.
ALTER TABLE case_imports
  ADD COLUMN IF NOT EXISTS updated integer NOT NULL DEFAULT 0;
--> statement-breakpoint

/*
 * `source` decides what a case permits, so it must not drift.
 *
 * The application refuses the workflow on an imported case at the route and
 * again in the send path, but neither survives a hand-written UPDATE at the
 * console — and this column is exactly what somebody would reach for to
 * "unlock" a case. It is set once, when the row is created, and after that the
 * only way to change it is to say so deliberately in SQL by dropping this
 * trigger first.
 */
CREATE OR REPLACE FUNCTION case_source_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION
      'cases.source cannot be changed (% -> %): it decides whether a case may be worked and written to',
      OLD.source, NEW.source;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS cases_source_immutable ON cases;
--> statement-breakpoint

CREATE TRIGGER cases_source_immutable
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION case_source_is_immutable();
--> statement-breakpoint

COMMENT ON COLUMN cases.source IS
  'portal | import. Immutable. An imported case is a record: it is never '
  'written to, never worked, and changes only by a later upload.';
