-- Editable system templates, and categories for reply templates.
--
-- The seven transactional templates (verification, acknowledgement, assignment,
-- reminders, escalations) were compiled into the bundle, so changing a word
-- meant a redeploy. Overrides live here; an absent row means "use the built-in".

CREATE TABLE IF NOT EXISTS system_templates (
  key         text PRIMARY KEY,
  subject     text NOT NULL,
  html        text NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Reply templates gain a category so a growing library stays navigable, and a
-- follow-up template is not lost among outcome letters.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'outcome';

-- Existing rows: the seeded set is mostly outcomes, with a few that are not.
UPDATE templates SET category = 'acknowledgement'
 WHERE category = 'outcome' AND name IN ('Acknowledgement of request');

UPDATE templates SET category = 'follow-up'
 WHERE category = 'outcome' AND name IN (
   'Identity verification required',
   'Request for clarification',
   'Extension of the response period'
 );

CREATE INDEX IF NOT EXISTS templates_category_idx ON templates (category, active);
