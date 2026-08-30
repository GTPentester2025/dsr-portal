-- Put form_drafts under the role matrix, and more tightly than 0016 could.
--
-- form_drafts is the other table 0001 and 0013 left outside row-level
-- security. It holds `verified_email` -- a data subject's address, in plain
-- text, before their request has become a case -- plus the session that
-- claims it. Any authenticated role could read every draft, alter one, or
-- delete one. As with verification_tokens, that was the absence of a policy
-- rather than a weak one.
--
-- All six call sites run as `system`: VerificationService creates, reads and
-- verifies drafts inside db.system() at five of them, and
-- PublicUploadsController resolves a draft the same way before accepting an
-- attachment. Nothing authenticated touches this table.

ALTER TABLE form_drafts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Note this is stricter than 0016's policy on verification_tokens, and
-- deliberately so rather than by copying it.
--
-- There, reads had to stay open: ReportService.build counts verified emails
-- under the caller's own context, and locking reads to `system` would have
-- made that figure silently return zero -- a dashboard reporting health
-- because its query was refused.
--
-- Here there is no such reader. No authenticated code path selects from
-- form_drafts at all, so `USING` can require `system` too, which closes
-- reads as well as writes. A future admin screen over drafts would see an
-- empty list rather than a permission error; if one is ever built, this
-- policy is what it must be widened against, and the widening should carry a
-- zone column rather than simply opening reads to everyone.
CREATE POLICY form_drafts_role ON form_drafts
  USING (app_role_may_write(ARRAY['system']))
  WITH CHECK (app_role_may_write(ARRAY['system']));--> statement-breakpoint

-- A FOR ALL policy's WITH CHECK does not govern DELETE -- deletes are checked
-- against USING alone. That is already `system`-only above, so this companion
-- is belt and braces rather than load-bearing; it is here so the pairing 0013
-- established on all fourteen of its tables reads the same way on this one,
-- and so that widening USING later cannot silently widen DELETE with it.
CREATE POLICY form_drafts_delete_role ON form_drafts AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system']));
