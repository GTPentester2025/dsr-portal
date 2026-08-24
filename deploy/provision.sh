#!/usr/bin/env bash
# Provision Ubuntu host for the DSR portal: Node 22, PostgreSQL 16, nginx.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== swap (1 vCPU / 2GB box needs headroom) =="
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== base packages =="
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw postgresql postgresql-contrib nginx >/dev/null

echo "== node 22 =="
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi

echo "== app user + dirs =="
id -u dsr >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/dsr --shell /usr/sbin/nologin dsr
mkdir -p /opt/dsr/server /var/www/dsr/public-form /var/www/dsr/admin
chown -R dsr:dsr /opt/dsr

echo "== firewall =="
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "== versions =="
node -v; nginx -v 2>&1; psql --version; systemctl is-active postgresql
echo "PROVISION_OK"
