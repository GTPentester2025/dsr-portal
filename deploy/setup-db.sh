#!/usr/bin/env bash
# Create the portal database, the owner role, and the restricted app role that
# RLS relies on. Idempotent.
set -euo pipefail

DB_PASS="${DB_PASS:?DB_PASS required}"
APP_PASS="${APP_PASS:?APP_PASS required}"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr') THEN
    CREATE ROLE dsr LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE dsr PASSWORD '${DB_PASS}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr_app') THEN
    CREATE ROLE dsr_app LOGIN PASSWORD '${APP_PASS}';
  ELSE
    ALTER ROLE dsr_app PASSWORD '${APP_PASS}';
  END IF;
END
\$\$;
SQL

# createdb is not transactional, so guard it separately.
if ! sudo -u postgres psql -lqt | cut -d\| -f1 | grep -qw dsr; then
  sudo -u postgres createdb -O dsr -E UTF8 -T template0 dsr
  echo "database created"
else
  echo "database already present"
fi

sudo -u postgres psql -d dsr -v ON_ERROR_STOP=1 <<'SQL'
GRANT ALL ON SCHEMA public TO dsr;
ALTER SCHEMA public OWNER TO dsr;
SQL

echo "DB_SETUP_OK"
