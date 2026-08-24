-- Translated system emails.
--
-- Requesters submit in their own language, so answering in English undermines
-- the point of the localised forms. The language column turns the override
-- table into a per-language store; an absent row falls back to English, so a
-- partially translated deployment still sends.

ALTER TABLE system_templates DROP CONSTRAINT IF EXISTS system_templates_pkey;
ALTER TABLE system_templates ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE system_templates ADD CONSTRAINT system_templates_pkey PRIMARY KEY (key, language);

ALTER TABLE templates ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
CREATE INDEX IF NOT EXISTS templates_language_idx ON templates (language, category);

-- Which language a requester gets written to in. Captured at submission so a
-- later change to the form default does not alter old cases.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
