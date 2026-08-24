-- Real attachment storage, and keeping what we actually sent.
--
-- case_attachments has existed since the first migration but nothing ever wrote
-- to it: uploads were captured as form metadata only, so a requester's evidence
-- was never retained. Files now live on disk under zone/case-reference, with
-- the row here as the index, so the archive is navigable without the database
-- and a case's whole paper trail sits in one directory.

ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS zone_id text;
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS case_ref text;
-- 'requester'  submitted with the form
-- 'response'   a reply we received and recorded
-- 'internal'   working document added by the team
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'requester';
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id);
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS note text;
-- Which message this is a reply to, when it is one.
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS in_reply_to uuid REFERENCES email_log(id);

CREATE INDEX IF NOT EXISTS case_attachments_zone_ix ON case_attachments (zone_id, case_ref);

-- Drafts carry attachments before a case exists; the row is re-pointed on
-- submission. Nullable because of that window.
ALTER TABLE case_attachments ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS draft_id uuid;
CREATE INDEX IF NOT EXISTS case_attachments_draft_ix ON case_attachments (draft_id);

-- What we sent, not just that we sent it. Without the body an operator cannot
-- see what a requester was actually told.
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS body_html text;

COMMENT ON TABLE case_attachments IS
  'Files held for a case. storage_key is <zone>/<case_ref>/<uuid>-<filename> under the uploads root.';
