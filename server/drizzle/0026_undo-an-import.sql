-- Undoing an import.
--
-- An upload creates cases wholesale, and the mistakes it makes are wholesale
-- too: the wrong file, the wrong zone, a date order that turned every arrival
-- date into nonsense. Until now the only remedy was deleting several thousand
-- cases one at a time, which nobody does — so the wrong import stays.
--
-- Undo needs two things this schema did not have: a record of which cases came
-- from which upload, and a way to tell an upload whose cases can be found from
-- one whose cases cannot.

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------

-- Which upload created this case. Null for every case raised through the
-- public form, and for imported cases that predate this column.
--
-- ON DELETE SET NULL rather than CASCADE, deliberately. `case_imports` rows are
-- never deleted — an import is explained by its record long after its cases are
-- gone — but if one ever were, losing the provenance link is recoverable and
-- silently destroying thousands of cases is not.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES case_imports(id) ON DELETE SET NULL;
--> statement-breakpoint

COMMENT ON COLUMN cases.import_id IS
  'The upload that created this case, for undo. Set once, at creation; a later '
  'upload that updates the case does not take ownership of it.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS cases_import_ix ON cases (import_id) WHERE import_id IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What an undo may touch
-- ---------------------------------------------------------------------------

ALTER TABLE case_imports
  ADD COLUMN IF NOT EXISTS undoable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS undone_at timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS undone_by_name text;
--> statement-breakpoint

/*
 * Imports committed before provenance existed cannot be undone.
 *
 * Their cases carry no `import_id`, so an undo would match nothing, delete
 * nothing, and report success — the worst available outcome, because the
 * operator would believe the import was reversed and stop looking. Marked
 * explicitly so the refusal can say why rather than showing an empty result.
 */
UPDATE case_imports SET undoable = false WHERE status = 'committed';
--> statement-breakpoint

COMMENT ON COLUMN case_imports.undoable IS
  'False when this upload predates cases.import_id, so the cases it created '
  'cannot be identified. Undo is refused rather than silently doing nothing.';
--> statement-breakpoint

COMMENT ON COLUMN case_imports.status IS
  'analysed | committed | discarded | failed | undone';
--> statement-breakpoint

-- Same name-snapshot rule the rest of this schema uses: who undid an import
-- has to outlive their account, because the audit trail is what the record is
-- for. `users_forget_name` (0020) fills this on insert; undo sets it directly.
COMMENT ON COLUMN case_imports.undone_by_name IS
  'Name as it was at the time, so the record survives the account being deleted.';
