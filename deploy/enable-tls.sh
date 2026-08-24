#!/usr/bin/env bash
# Turn on HTTPS once a domain points at this server.
#
#   bash deploy/enable-tls.sh privacy.example.com admin@example.com
#
# Obtains a Let's Encrypt certificate, switches nginx to TLS, re-enables
# Secure cookies and restarts the API. Certificates renew automatically.
set -euo pipefail

DOMAIN="${1:?usage: enable-tls.sh <domain> <email>}"
EMAIL="${2:?usage: enable-tls.sh <domain> <email>}"
HOST="${HOST:-root@203.0.113.10}"
SSH_KEY="${SSH_KEY:-/tmp/dsr_key}"
SSH="ssh -o StrictHostKeyChecking=no -i $SSH_KEY $HOST"

echo "==> installing certbot"
$SSH "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null"

echo "==> pointing nginx at $DOMAIN"
$SSH "sed -i 's/server_name _;/server_name $DOMAIN;/' /etc/nginx/sites-available/dsr && nginx -t && systemctl reload nginx"

echo "==> requesting certificate"
$SSH "certbot --nginx -d '$DOMAIN' -m '$EMAIL' --agree-tos --no-eff-email --redirect --non-interactive"

echo "==> hardening: HSTS + Secure cookies"
$SSH "grep -q 'Strict-Transport-Security' /etc/nginx/sites-available/dsr || \
  sed -i '/server_tokens off;/a\\    add_header Strict-Transport-Security \"max-age=63072000; includeSubDomains; preload\" always;' /etc/nginx/sites-available/dsr"
$SSH "sed -i '/^COOKIE_SECURE=/d' /opt/dsr/server/.env && echo 'COOKIE_SECURE=true' >> /opt/dsr/server/.env"

echo "==> updating portal URLs"
$SSH "cd /opt/dsr/server && set -a && . ./.env && set +a && node -e \"
const pg=require('pg');(async()=>{
  const c=new pg.Client(process.env.DATABASE_URL); await c.connect();
  for (const [k,v] of [['PUBLIC_BASE_URL','https://$DOMAIN'],['INTERNAL_BASE_URL','https://$DOMAIN/admin']]) {
    await c.query(\\\"INSERT INTO app_settings (key,value,secret) VALUES (\\\$1,\\\$2,false) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()\\\", [k,v]);
  }
  await c.end(); console.log('portal URLs updated');
})()\""

$SSH "nginx -t && systemctl reload nginx && systemctl restart dsr-api"
echo "TLS_OK — https://$DOMAIN"
