-- Give verification_tokens a zone, so its reads can be scoped like everything
-- else's.
--
-- 0016 put this table under row-level security but had to leave reads open:
-- there was no zone column to scope them by, so a zone manager could read
-- every zone's pending verifications, and the "emails verified today" figure
-- on their dashboard counted the whole instance. This closes that.
--
-- Where the zone comes from: a token belongs to a draft, a draft names a
-- form_key, and IntakeService derives a case's zone from the *highest
-- version* row in form_versions for that key (see intake.service.ts, which
-- orders by version desc and takes the first). The backfill below uses that
-- same rule deliberately -- form_versions is unique on (form_key, version),
-- not on (form_key, zone_id), so a key could in principle carry rows in more
-- than one zone, and any other rule here would let a token disagree with the
-- case its draft eventually becomes.

ALTER TABLE verification_tokens ADD COLUMN IF NOT EXISTS zone_id text;--> statement-breakpoint

UPDATE verification_tokens t
   SET zone_id = fv.zone_id
  FROM form_drafts d
  JOIN LATERAL (
         SELECT zone_id
           FROM form_versions
          WHERE form_key = d.form_key
          ORDER BY version DESC
          LIMIT 1
       ) fv ON true
 WHERE t.draft_id = d.id
   AND t.zone_id IS NULL;--> statement-breakpoint

-- Left deliberately nullable, and deliberately not defaulted. A token whose
-- form_key has no form_versions row -- a form withdrawn between the link being
-- sent and this migration running -- gets NULL rather than a guess, and
-- app_zone_allows(NULL) is false, so such a row is visible to a zone-wide role
-- and hidden from a zone-pinned one. Failing closed for the scoped case is the
-- right way round for a table holding a data subject's address.
--
-- Note this does NOT follow the `OR zone_id IS NULL` shape that users and
-- sla_policies use. There, a NULL zone means "global, everyone may see it",
-- which is right for a role or a policy row. Here it would mean an unzoned
-- token is readable by every zone, which is the hole this migration exists to
-- close.
DROP POLICY IF EXISTS verification_tokens_role ON verification_tokens;--> statement-breakpoint

CREATE POLICY verification_tokens_role ON verification_tokens
  USING (app_zone_allows(zone_id))
  WITH CHECK (app_role_may_write(ARRAY['system']));--> statement-breakpoint

-- No index on zone_id, and that is not an oversight. app_zone_allows() is a
-- function call rather than an equality, so the planner cannot turn it into a
-- range scan -- the same reason 0015 indexed cases(created_at) alone instead
-- of (zone_id, created_at). The table is also purged daily by
-- HousekeepingService, so it stays small enough for a scan regardless.
--
-- The DELETE companion from 0016 is left exactly as it is: it is restrictive
-- and already system-only, and it does not reference zone_id.
COMMENT ON COLUMN verification_tokens.zone_id IS
  'Zone of the latest form_versions row for the draft''s form_key, matching how IntakeService derives a case''s zone. Nullable: a withdrawn form leaves NULL, which app_zone_allows() treats as visible only to zone-wide roles.';
