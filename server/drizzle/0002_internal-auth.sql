-- Break-glass local credentials (spec §9: SSO is primary; local accounts are
-- the emergency path with a strong password policy enforced in code).
ALTER TABLE users ADD COLUMN password_hash text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN is_break_glass boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE internal_sessions (
  id text PRIMARY KEY,                    -- 256-bit random, hashed? no: opaque random id
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  source_ip text
);
--> statement-breakpoint
CREATE INDEX internal_sessions_user_ix ON internal_sessions(user_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON internal_sessions TO dsr_app;
