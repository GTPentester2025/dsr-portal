#!/usr/bin/env bash
# Install the nightly backup job on the server. Idempotent.
#
#   bash deploy/install-backups.sh
set -euo pipefail

HOST="${HOST:-root@134.209.146.74}"
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
