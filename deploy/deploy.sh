#!/usr/bin/env bash
# Ship the built portal to the server.
#
# Run from the repo root:  bash deploy/deploy.sh
# Requires a secrets file (see SECRETS_FILE) and an SSH key at $SSH_KEY.
# Uses tar over ssh rather than rsync so it works from Windows/Git Bash too.
set -euo pipefail

# Target lives in deploy/.target.env (gitignored) so a published repo does not
# advertise the address of a live portal. Copy deploy/target.example.env.
TARGET_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.target.env"
# shellcheck disable=SC1090
[ -f "$TARGET_FILE" ] && . "$TARGET_FILE"
HOST="${HOST:-${DEPLOY_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "No ssh target. Set HOST=root@your-server or create deploy/.target.env" >&2
  exit 1
fi
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=no -i $SSH_KEY"
SSH="ssh $SSH_OPTS $HOST"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Each droplet has its own secrets file, and writing the wrong one is not a
# recoverable mistake: a mismatched CRYPTO_MASTER_KEY leaves every encrypted
# row in app_settings undecryptable. The guard below catches that, but the
# default should still name the box this script actually deploys to.
SECRETS_FILE="${SECRETS_FILE:-$ROOT/deploy/.secrets.blr.env}"
# shellcheck disable=SC1091
source "$SECRETS_FILE"

# CRYPTO_MASTER_KEY must decode to exactly 32 bytes. A hex string is the easy
# mistake: it looks like a key, ships fine, and the service then crash-loops on
# boot. Catch it here rather than in journalctl.
if [ "$(printf '%s' "${CRYPTO_MASTER_KEY:-}" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" != "32" ]; then
  echo "FATAL: CRYPTO_MASTER_KEY must be 32 bytes base64-encoded." >&2
  echo "       Generate one with: openssl rand -base64 32" >&2
  exit 1
fi

# The email configuration now lives in the .env file this script rewrites, so
# the secrets file has to carry it. An empty Graph credential is no longer just
# "mail is broken": assertEmailConfig exits the process at boot, systemd
# restarts it every 3s, and nginx is left proxying the public form and the
# admin console to a dead API. Fail here, on the operator's machine, before a
# single byte reaches the server.
#
# Note this reads the shell as well as the secrets file, the same way
# COOKIE_SECURE does. Set EMAIL_PROVIDER in the secrets file so it cannot be
# decided by whatever happens to be exported in the operator's shell.
EMAIL_PROVIDER="${EMAIL_PROVIDER:-graph}"
case "$EMAIL_PROVIDER" in
  graph) ;;
  console)
    echo "WARNING: deploying with EMAIL_PROVIDER=console. The API runs with" >&2
    echo "         NODE_ENV=production, where the console adapter refuses to" >&2
    echo "         send. No mail will reach a data subject." >&2
    ;;
  *)
    # Same legal set as EMAIL_PROVIDERS in server/src/email/email-config.ts.
    # Boot validation rejects anything else by name, so shipping it would mean
    # the same crash loop as a missing credential.
    echo "FATAL: EMAIL_PROVIDER is \"$EMAIL_PROVIDER\"; valid values are graph" >&2
    echo "       and console, exact and lower case. Fix it in $SECRETS_FILE." >&2
    exit 1
    ;;
esac
if [ "$EMAIL_PROVIDER" = "graph" ]; then
  missing=""
  for var in PRIVACY_MAILBOX GRAPH_TENANT_ID GRAPH_CLIENT_ID GRAPH_CLIENT_SECRET; do
    if [ -z "$(printf '%s' "${!var:-}" | tr -d '[:space:]')" ]; then missing="$missing $var"; fi
  done
  if [ -n "$missing" ]; then
    echo "FATAL: EMAIL_PROVIDER=graph, but these are empty:$missing" >&2
    echo "       They belong in $SECRETS_FILE, alongside DB_PASS and" >&2
    echo "       CRYPTO_MASTER_KEY. Without them the API exits at boot and" >&2
    echo "       systemd crash-loops it, taking the whole portal offline." >&2
    exit 1
  fi
fi

# Refuse to overwrite a live .env whose master key differs from the one about
# to be written. Compares fingerprints, never the keys themselves.
remote_fp=$($SSH "test -f /opt/dsr/server/.env && (set -a; . /opt/dsr/server/.env; set +a; printf '%s' \"\$CRYPTO_MASTER_KEY\" | md5sum | cut -c1-8)" 2>/dev/null || true)
local_fp=$(printf '%s' "$CRYPTO_MASTER_KEY" | md5sum | cut -c1-8)
if [ -n "$remote_fp" ] && [ "$remote_fp" != "$local_fp" ]; then
  echo "FATAL: $SECRETS_FILE does not belong to $HOST." >&2
  echo "       Its CRYPTO_MASTER_KEY ($local_fp) differs from the one already on" >&2
  echo "       the box ($remote_fp); deploying would orphan every encrypted setting." >&2
  echo "       Choose the right one with SECRETS_FILE=deploy/.secrets.<host>.env" >&2
  exit 1
fi

# push_dir <local-dir> <remote-dir> — mirrors a directory (replaces contents).
push_dir() {
  local src="$1" dest="$2"
  tar -czf - -C "$src" . | $SSH "rm -rf '$dest' && mkdir -p '$dest' && tar -xzf - -C '$dest'"
}

# push_file <local-file> <remote-path>
push_file() {
  $SSH "cat > '$2'" < "$1"
}

echo "==> building"
(cd "$ROOT/server" && npm run build >/dev/null)
(cd "$ROOT/apps/admin" && npm run build >/dev/null)
(cd "$ROOT/apps/public-form" && npm run build >/dev/null)

echo "==> syncing api"
push_dir "$ROOT/server/dist"    /opt/dsr/server/dist
push_dir "$ROOT/server/drizzle" /opt/dsr/server/drizzle
push_dir "$ROOT/server/scripts" /opt/dsr/server/scripts
push_file "$ROOT/server/package.json"      /opt/dsr/server/package.json
push_file "$ROOT/server/package-lock.json" /opt/dsr/server/package-lock.json

echo "==> syncing form schemas"
push_dir "$ROOT/form-schema" /opt/dsr/form-schema

echo "==> syncing web bundles"
push_dir "$ROOT/apps/public-form/dist" /var/www/dsr/public-form
push_dir "$ROOT/apps/admin/dist"       /var/www/dsr/admin

echo "==> writing service env"
# Keep one rollback copy on the box. The guard above makes a clobbered key
# unlikely, but a wrong COOKIE_SECURE or port is still easier to revert than
# to retype from the secrets file.
$SSH "test -f /opt/dsr/server/.env && cp /opt/dsr/server/.env /opt/dsr/server/.env.bak || true"
$SSH "cat > /opt/dsr/server/.env" <<ENV
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://dsr:${DB_PASS}@127.0.0.1:5432/dsr
DATABASE_URL_APP=postgres://dsr_app:${APP_PASS}@127.0.0.1:5432/dsr
CRYPTO_MASTER_KEY=${CRYPTO_MASTER_KEY}
# TLS is in place, so session cookies carry the Secure flag. Only set this to
# false for a deliberately plain-HTTP environment.
COOKIE_SECURE=${COOKIE_SECURE:-true}
# Email is environment-owned (no app_settings row can supply it), so these have
# to be rewritten here or the service refuses to start. Guarded above.
EMAIL_PROVIDER=${EMAIL_PROVIDER:-graph}
PRIVACY_MAILBOX=${PRIVACY_MAILBOX:-}
GRAPH_TENANT_ID=${GRAPH_TENANT_ID:-}
GRAPH_CLIENT_ID=${GRAPH_CLIENT_ID:-}
GRAPH_CLIENT_SECRET=${GRAPH_CLIENT_SECRET:-}
ENV
$SSH "chmod 600 /opt/dsr/server/.env"

echo "==> installing runtime dependencies"
$SSH "cd /opt/dsr/server && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1"

echo "==> migrations + form import"
$SSH "cd /opt/dsr/server && set -a && . ./.env && set +a && node scripts/migrate.mjs"
$SSH "cd /opt/dsr/server && set -a && . ./.env && set +a && node scripts/import-forms.mjs | tail -1"
$SSH "chown -R dsr:dsr /opt/dsr && chown -R www-data:www-data /var/www/dsr"

# Attachment storage. Owned by the service user; 750 so nothing else on the box
# can read a requester's identity documents.
$SSH "mkdir -p /opt/dsr/uploads && chown dsr:dsr /opt/dsr/uploads && chmod 750 /opt/dsr/uploads"

echo "==> systemd + nginx"
push_file "$ROOT/deploy/dsr-api.service" /etc/systemd/system/dsr-api.service
push_file "$ROOT/deploy/nginx.conf"      /etc/nginx/sites-available/dsr
$SSH "ln -sf /etc/nginx/sites-available/dsr /etc/nginx/sites-enabled/dsr && rm -f /etc/nginx/sites-enabled/default"

# The repo config is HTTP-only; writing it removes the TLS blocks certbot
# added. Re-install the certificate so HTTPS survives every deployment.
CERT_NAME=$($SSH "ls /etc/letsencrypt/live 2>/dev/null | grep -v README | head -1" || true)
if [ -n "${CERT_NAME:-}" ]; then
  echo "==> re-applying TLS for $CERT_NAME"
  $SSH "sed -i 's/server_name _;/server_name $CERT_NAME;/' /etc/nginx/sites-available/dsr"
  $SSH "certbot install --nginx --cert-name '$CERT_NAME' --redirect --non-interactive >/dev/null 2>&1"
fi
# The public base URL is what goes into verification links. If it is missing the
# sender falls back to a loopback address and every link mailed out is dead, so
# restore it from the certificate name rather than let a wiped setting persist.
# Fed over stdin from a quoted heredoc: inline escaping of $1 inside a
# double-quoted ssh command is how this broke once already.
if [ -n "${CERT_NAME:-}" ]; then
  echo "==> ensuring portal URLs are set"
  $SSH "cat > /opt/dsr/server/ensure-urls.cjs" <<'NODE'
const pg = require('pg');
(async () => {
  const host = process.argv[2];
  const c = new pg.Client(process.env.DATABASE_URL);
  await c.connect();
  const rows = [
    ['PUBLIC_BASE_URL', `https://${host}`],
    ['INTERNAL_BASE_URL', `https://${host}/admin`],
  ];
  for (const [key, value] of rows) {
    const existing = await c.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    if (!existing.rows[0] || !existing.rows[0].value) {
      await c.query(
        'INSERT INTO app_settings (key, value, secret) VALUES ($1, $2, false) ' +
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
      console.log(`   restored ${key} = ${value}`);
    }
  }
  await c.end();
})();
NODE
  $SSH "cd /opt/dsr/server && set -a && . ./.env && set +a && node ensure-urls.cjs '$CERT_NAME' && rm -f /opt/dsr/server/ensure-urls.cjs"
fi

$SSH "nginx -t 2>&1 | tail -1"
$SSH "systemctl daemon-reload && systemctl enable --now dsr-api >/dev/null 2>&1; systemctl restart dsr-api && systemctl reload nginx"

echo "==> health"
# Poll rather than sleep-then-check once: on a single-vCPU box Nest can take
# well over four seconds to bind, and a one-shot probe reports a false failure
# on a deploy that actually succeeded.
ready=""
for _ in $(seq 1 20); do
  if $SSH "systemctl is-active --quiet dsr-api && curl -sf -o /dev/null http://127.0.0.1:3000/"; then
    ready=yes
    break
  fi
  sleep 3
done
if [ -z "$ready" ]; then
  echo "FATAL: the API did not come up within 60s. Last log lines:" >&2
  $SSH "journalctl -u dsr-api -n 25 --no-pager" >&2
  exit 1
fi
$SSH "curl -sf -o /dev/null -w 'api:%{http_code}\n' http://127.0.0.1:3000/"
echo "DEPLOY_OK"
