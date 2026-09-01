-- Permanently deleting a person, and knowing which mail did not go out.
--
-- Two separate needs that touch the same tables, so they arrive together.
--
-- 1. An administrator must be able to erase a user account outright rather
--    than only deactivating it — a departed employee, or an erasure request
--    from a member of staff. What must survive is the attribution: an audit
--    trail that cannot say who acted is not one, and neither is a case file
--    whose timeline cannot say who closed the request. Both currently join
--    `users` at read time, which is why a hard delete would blank them, so
--    both gain a name recorded on the row at the moment it is written.
--
-- 2. Failed sends need a brake and a record. A provider outage today produces
--    an unbounded stream of retries and an `email_log` row that names a
--    subject line but does not hold the message, so nobody can see what the
--    requester did not receive.

-- ---------------------------------------------------------------------------
-- 1. The audit trail keeps the name
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_name text,
  ADD COLUMN IF NOT EXISTS actor_email text;
--> statement-breakpoint

-- The table is append-only, enforced by a trigger. Backfilling existing rows
-- is a one-time schema operation, not an application write, so the guard comes
-- off for the duration of this statement and goes straight back on.
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
--> statement-breakpoint

UPDATE audit_log a
   SET actor_name = u.name, actor_email = u.email
  FROM users u
 WHERE u.id = a.actor_id AND a.actor_name IS NULL;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Nothing else may hold a user row hostage
-- ---------------------------------------------------------------------------

/*
 * Records that name a person keep a snapshot of who it was.
 *
 * A case timeline reading "status changed to closed" with nothing against it
 * is a worse record than one that says who closed it, and the case file is
 * what gets produced when the handling of a request is questioned — not just
 * the audit log. So the account is erased and the attribution is kept: the
 * name is copied onto the row at the time it is written, and the pointer back
 * to `users` is what goes away.
 */
ALTER TABLE case_status_history ADD COLUMN IF NOT EXISTS actor_name text;
--> statement-breakpoint
ALTER TABLE case_comments ADD COLUMN IF NOT EXISTS author_name text;
--> statement-breakpoint
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS uploaded_by_name text;
--> statement-breakpoint
ALTER TABLE case_imports ADD COLUMN IF NOT EXISTS uploaded_by_name text;
--> statement-breakpoint

UPDATE case_status_history h SET actor_name = u.name
  FROM users u WHERE u.id = h.actor_id AND h.actor_name IS NULL;
--> statement-breakpoint
UPDATE case_comments c SET author_name = u.name
  FROM users u WHERE u.id = c.author_id AND c.author_name IS NULL;
--> statement-breakpoint
UPDATE case_attachments a SET uploaded_by_name = u.name
  FROM users u WHERE u.id = a.uploaded_by AND a.uploaded_by_name IS NULL;
--> statement-breakpoint
UPDATE case_imports i SET uploaded_by_name = u.name
  FROM users u WHERE u.id = i.uploaded_by AND i.uploaded_by_name IS NULL;
--> statement-breakpoint

/*
 * Filled by trigger rather than by the application.
 *
 * Thirteen places insert a timeline row — workflow transitions, assignment,
 * the SLA sweep, attachments, intake, the importer, the deletion endpoint
 * itself — and a snapshot that any one of them can forget to set is a snapshot
 * that will be null on exactly the row somebody needs. The database is the one
 * place every writer passes through.
 */
CREATE OR REPLACE FUNCTION snapshot_actor_name() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_id IS NOT NULL AND NEW.actor_name IS NULL THEN
    SELECT name INTO NEW.actor_name FROM users WHERE id = NEW.actor_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION snapshot_author_name() RETURNS trigger AS $$
BEGIN
  IF NEW.author_id IS NOT NULL AND NEW.author_name IS NULL THEN
    SELECT name INTO NEW.author_name FROM users WHERE id = NEW.author_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION snapshot_uploader_name() RETURNS trigger AS $$
BEGIN
  IF NEW.uploaded_by IS NOT NULL AND NEW.uploaded_by_name IS NULL THEN
    SELECT name INTO NEW.uploaded_by_name FROM users WHERE id = NEW.uploaded_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS case_status_history_actor_name ON case_status_history;
--> statement-breakpoint
CREATE TRIGGER case_status_history_actor_name
  BEFORE INSERT ON case_status_history
  FOR EACH ROW EXECUTE FUNCTION snapshot_actor_name();
--> statement-breakpoint

DROP TRIGGER IF EXISTS case_comments_author_name ON case_comments;
--> statement-breakpoint
CREATE TRIGGER case_comments_author_name
  BEFORE INSERT ON case_comments
  FOR EACH ROW EXECUTE FUNCTION snapshot_author_name();
--> statement-breakpoint

DROP TRIGGER IF EXISTS case_attachments_uploader_name ON case_attachments;
--> statement-breakpoint
CREATE TRIGGER case_attachments_uploader_name
  BEFORE INSERT ON case_attachments
  FOR EACH ROW EXECUTE FUNCTION snapshot_uploader_name();
--> statement-breakpoint

DROP TRIGGER IF EXISTS case_imports_uploader_name ON case_imports;
--> statement-breakpoint
CREATE TRIGGER case_imports_uploader_name
  BEFORE INSERT ON case_imports
  FOR EACH ROW EXECUTE FUNCTION snapshot_uploader_name();
--> statement-breakpoint

-- A comment can outlive its author.
ALTER TABLE case_comments ALTER COLUMN author_id DROP NOT NULL;
--> statement-breakpoint

/*
 * Re-point every foreign key that names a user so deleting one is possible at
 * all. Done by discovering the constraints rather than naming them: they were
 * created across five migrations by two different tools, and a hard-coded name
 * that does not exist would make this file fail on exactly the deployments
 * that need it most.
 *
 * `internal_sessions` cascades — a deleted account must not keep a live
 * session. Everything else nulls, because the record is about a case and has
 * to survive the person.
 */
DO $$
DECLARE
  target record;
  fk record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('cases',              'assignee_id',     'SET NULL'),
      ('case_status_history','actor_id',        'SET NULL'),
      ('case_comments',      'author_id',       'SET NULL'),
      ('case_attachments',   'uploaded_by',     'SET NULL'),
      ('templates',          'updated_by',      'SET NULL'),
      ('app_settings',       'updated_by',      'SET NULL'),
      ('case_imports',       'uploaded_by',     'SET NULL'),
      ('system_templates',   'updated_by',      'SET NULL'),
      -- A login binding and a session are both ways in to an account that no
      -- longer exists, so both go with it rather than being nulled.
      ('auth_identities',    'user_id',         'CASCADE'),
      ('internal_sessions',  'user_id',         'CASCADE')
    ) AS t(tbl, col, action)
  LOOP
    IF to_regclass('public.' || target.tbl) IS NULL THEN
      CONTINUE;
    END IF;

    FOR fk IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_class frel ON frel.oid = con.confrelid
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f'
         AND rel.relname = target.tbl
         AND frel.relname = 'users'
         AND att.attname = target.col
         AND array_length(con.conkey, 1) = 1
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, fk.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = target.tbl || '_' || target.col || '_users_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE %s',
        target.tbl,
        target.tbl || '_' || target.col || '_users_fk',
        target.col,
        target.action
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Round-robin remembers the last person it assigned to. That pointer has no
-- foreign key, so it would quietly outlive the account and skip a rotation.
CREATE OR REPLACE FUNCTION clear_rr_cursor_for_deleted_user() RETURNS trigger AS $$
BEGIN
  UPDATE assignment_config SET rr_cursor = NULL WHERE rr_cursor = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS users_clear_rr_cursor ON users;
--> statement-breakpoint

CREATE TRIGGER users_clear_rr_cursor
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION clear_rr_cursor_for_deleted_user();
--> statement-breakpoint

-- Deleting a user is a privileged, irreversible act; the app role may do it,
-- but only through the endpoint that checks the role first. The RESTRICTIVE
-- users_delete_role policy from 0013 still applies on top of this: the grant
-- makes deletion possible, the policy decides whose.
GRANT DELETE ON users TO dsr_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Failed sends: a brake, and the message itself
-- ---------------------------------------------------------------------------

/*
 * One row per thing that can be throttled: the provider as a whole, and each
 * recipient address. A provider outage should stop the portal hammering it;
 * one address that hard-bounces should stop being retried without taking every
 * other recipient down with it.
 */
CREATE TABLE IF NOT EXISTS email_send_health (
  scope text PRIMARY KEY,                 -- 'provider' | 'to:<address>'
  consecutive_failures integer NOT NULL DEFAULT 0,
  total_failures integer NOT NULL DEFAULT 0,
  last_error text,
  last_failed_at timestamptz,
  last_succeeded_at timestamptz,
  blocked_until timestamptz
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS email_send_health_blocked_ix
  ON email_send_health (blocked_until)
  WHERE blocked_until IS NOT NULL;
--> statement-breakpoint

-- Deliberately not zone-scoped: a scope here is a provider or an address, and
-- an address is not owned by a zone. Readable by anyone who can reach the
-- console, writable only by the roles that administer mail — the send path
-- itself runs as `system`.
ALTER TABLE email_send_health ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY email_send_health_role ON email_send_health
  USING (true)
  WITH CHECK (app_role_may_write(ARRAY['system','super_admin','admin']));
--> statement-breakpoint

CREATE POLICY email_send_health_delete_role ON email_send_health AS RESTRICTIVE FOR DELETE
  USING (app_role_may_write(ARRAY['system','super_admin','admin']));
--> statement-breakpoint

-- The log has to hold what was attempted, not just that something was. Without
-- the rendered body a failed send leaves nobody able to answer "what did the
-- requester not receive?", which is the first question asked about one.
ALTER TABLE email_log
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  -- 'provider' | 'throttled' | 'render' — why it did not go, not just that it
  -- did not. A throttled message was never handed to the provider at all.
  ADD COLUMN IF NOT EXISTS failure_kind text,
  ADD COLUMN IF NOT EXISTS template_variables jsonb,
  ADD COLUMN IF NOT EXISTS blocked_until timestamptz;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS email_log_status_ix ON email_log (status, created_at DESC);
