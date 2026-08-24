-- Administrative password reset.
--
-- Passwords are argon2id hashes, so they cannot be read back and shown to an
-- administrator — the hash is one-way by design and storing anything reversible
-- would defeat the point. What a super administrator can do instead is issue a
-- one-time password, displayed once at the moment it is generated, which the
-- user must replace at next sign-in.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- Backfill so existing accounts are not all reported as "never set".
UPDATE users SET password_set_at = created_at
 WHERE password_set_at IS NULL AND password_hash IS NOT NULL;
