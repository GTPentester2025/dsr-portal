-- Put verification_tokens under the role matrix.
--
-- Migrations 0001 and 0013 placed fifteen tables under row-level security.
-- This one was never included, and neither was form_drafts -- so it has sat
-- outside the matrix while holding a data subject's email address in plain
-- text and the hash of the token that proves they own it.
--
-- A verification token is a capability. Whoever holds the raw token can prove
-- ownership of that address and submit a request as that data subject. Until
-- now any authenticated role could INSERT one, mark one consumed, or DELETE
-- one, because nothing was stopping them -- not a bug in a policy, the
-- absence of one.
--
-- Every write the portal makes here already runs as `system`:
-- VerificationService issues and consumes tokens inside db.system(), and
-- HousekeepingService purges expired ones the same way. So restricting writes
-- to that role permits everything the portal does today and refuses
-- everything else.

ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Reads stay open, deliberately, and this is the part to revisit.
--
-- There is no zone to scope them by: neither this table nor form_drafts
-- carries a zone column, and reaching one would mean joining form_key through
-- form_versions on every row evaluated.
--
-- The only authenticated reader is ReportService.build's "emails verified
-- today" count, which has run under the caller's own context since 0efab7e.
-- Locking reads to `system` would make that count silently return zero -- a
-- figure on a dashboard reporting health because the query was refused, which
-- is the exact failure this codebase has already fixed three times. Better an
-- honest cross-zone count than a quiet wrong one.
--
-- Scoping reads properly needs a zone column on this table and a backfill.
-- That is a schema change with a data migration behind it, not a policy edit.
CREATE POLICY verification_tokens_role ON verification_tokens
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system']));--> statement-breakpoint

-- A FOR ALL policy's WITH CHECK does not govern DELETE -- deletes are checked
-- against USING alone, which is `true` above. Without this companion any role
-- could delete a pending token and break a data subject's verification with
-- nothing recording that it happened. 0013 established the same pairing on all
-- fourteen tables it touched.
CREATE POLICY verification_tokens_delete_role ON verification_tokens AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system']));
