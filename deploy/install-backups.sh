#!/usr/bin/env bash
# Install the nightly backup job on the server. Idempotent.
#
#   bash deploy/install-backups.sh
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
SSH="ssh -o StrictHostKeyChecking=no -i $SSH_KEY $HOST"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> installing backup script"
$SSH "cat > /usr/local/bin/dsr-backup" < "$ROOT/deploy/backup.sh"
$SSH "chmod 700 /usr/local/bin/dsr-backup"

echo "==> scheduling nightly at 02:30 UTC"
$SSH "cat > /etc/cron.d/dsr-backup" <<'CRON'
# Nightly backup of the DSR portal. Output goes to syslog; check with
#   journalctl -t dsr-backup --since today
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
30 2 * * * root /usr/local/bin/dsr-backup 2>&1 | logger -t dsr-backup
CRON
$SSH "chmod 644 /etc/cron.d/dsr-backup"

echo "==> running once now to prove it works"
$SSH "/usr/local/bin/dsr-backup"

echo "==> what is on disk"
$SSH "ls -lh /opt/dsr/backups | tail -5"
