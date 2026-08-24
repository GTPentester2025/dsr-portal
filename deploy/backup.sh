#!/usr/bin/env bash
# Nightly backup of everything needed to rebuild this portal.
#
# Installed on the server by deploy/install-backups.sh and run by cron.
#
# Three things are backed up together, and all three are required — a database
# dump on its own is NOT a usable backup of this system:
#
#   1. the database          — cases, audit trail, settings
#   2. /opt/dsr/uploads      — identity documents live on disk, not in the DB
#   3. the CRYPTO_MASTER_KEY — every requester name, email and identity field
#                              is encrypted with it. Restore the dump without
#                              the key and the PII is gone for good.
#
# The archive is therefore as sensitive as the live system: mode 600, in a
# directory only root can enter.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/opt/dsr/backups}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# --- database -----------------------------------------------------------------
# Custom format so a single table can be restored without replaying everything.
# Written through a root redirect: the postgres user cannot enter root's
# private temp directory, so -f would fail on permissions.
sudo -u postgres pg_dump -Fc -d dsr > "$WORK/dsr.dump"

# A dump that cannot be read is not a backup. Prove the archive is intact now,
# while somebody is around to notice, rather than during an incident.
# --list only reads the file, so it needs no database connection.
if ! pg_restore --list "$WORK/dsr.dump" > /dev/null 2>&1; then
  echo "FATAL: pg_dump produced an unreadable archive" >&2
  exit 1
fi

# --- attachments --------------------------------------------------------------
if [ -d /opt/dsr/uploads ]; then
  tar -czf "$WORK/uploads.tar.gz" -C /opt/dsr uploads
else
  : > "$WORK/uploads.tar.gz"
fi

# --- key material and service config -----------------------------------------
# Without CRYPTO_MASTER_KEY the dump decrypts to nothing.
if [ -f /opt/dsr/server/.env ]; then
  cp /opt/dsr/server/.env "$WORK/service.env"
fi

# --- single archive -----------------------------------------------------------
OUT="$BACKUP_DIR/dsr-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"

# --- retention ----------------------------------------------------------------
find "$BACKUP_DIR" -name 'dsr-*.tar.gz' -type f -mtime +"$KEEP_DAYS" -delete

SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(find "$BACKUP_DIR" -name 'dsr-*.tar.gz' -type f | wc -l)
echo "backup ok: $OUT ($SIZE); $COUNT kept, pruning after ${KEEP_DAYS}d"
