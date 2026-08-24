#!/usr/bin/env bash
# Issue a real Let's Encrypt certificate for a host that has no domain.
#
# Public CAs do not issue certificates for bare IP addresses, so we use the
# sslip.io wildcard DNS service: 203-0-113-10.sslip.io resolves to the IP
# itself. That yields a genuinely trusted certificate with no browser warning.
set -euo pipefail

IP="${IP:-203.0.113.10}"
HOSTNAME="${HOSTNAME_OVERRIDE:-${IP//./-}.sslip.io}"
EMAIL="${EMAIL:-admin@${HOSTNAME}}"
SSH_KEY="${SSH_KEY:-/tmp/dsr_key}"
SSH="ssh -o StrictHostKeyChecking=no -i $SSH_KEY root@$IP"

echo "==> certificate host: $HOSTNAME"

echo "==> installing certbot"
$SSH "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1"

echo "==> naming the vhost"
$SSH "sed -i 's/server_name _;/server_name $HOSTNAME;/' /etc/nginx/sites-available/dsr && nginx -t >/dev/null 2>&1 && systemctl reload nginx"

echo "==> requesting the certificate"
$SSH "certbot --nginx -d '$HOSTNAME' -m '$EMAIL' --agree-tos --no-eff-email --redirect --non-interactive" 2>&1 | tail -6

echo "==> HSTS + Secure cookies"
$SSH "grep -q 'Strict-Transport-Security' /etc/nginx/sites-available/dsr || \
  sed -i '/server_tokens off;/a\    add_header Strict-Transport-Security \"max-age=63072000; includeSubDomains\" always;' /etc/nginx/sites-available/dsr"
$SSH "sed -i '/^COOKIE_SECURE=/d' /opt/dsr/server/.env && echo 'COOKIE_SECURE=true' >> /opt/dsr/server/.env"

echo "==> pointing the portal at https"
# The node snippet is fed over stdin from a quoted heredoc so the outer shell
# never touches its $1 placeholders; only HOSTNAME is substituted, by sed.
$SSH "cat > /opt/dsr/server/set-urls.cjs" <<'NODE'
const pg = require('pg');
(async () => {
  const c = new pg.Client(process.env.DATABASE_URL);
  await c.connect();
  const host = process.argv[2];
  const rows = [
    ['PUBLIC_BASE_URL', `https://${host}`],
    ['INTERNAL_BASE_URL', `https://${host}/admin`],
  ];
  for (const [k, v] of rows) {
    await c.query(
      'INSERT INTO app_settings (key,value,secret) VALUES ($1,$2,false) ' +
      'ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()',
      [k, v],
    );
  }
  await c.end();
  console.log(`   portal URLs now point at https://${host}`);
})();
NODE
$SSH "cd /opt/dsr/server && set -a && . ./.env && set +a && node set-urls.cjs '$HOSTNAME' && rm -f /opt/dsr/server/set-urls.cjs"

$SSH "nginx -t >/dev/null 2>&1 && systemctl reload nginx && systemctl restart dsr-api"
sleep 3

echo "==> verification"
$SSH "certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' | sed 's/^/   /'"
echo -n "   https reachable: "; curl -s -o /dev/null -w "%{http_code}\n" "https://$HOSTNAME/"
echo -n "   http redirects:  "; curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "http://$HOSTNAME/"
echo -n "   renewal timer:   "; $SSH "systemctl is-active certbot.timer 2>/dev/null || systemctl is-enabled snap.certbot.renew.timer 2>/dev/null || echo 'check manually'"
echo "TLS_OK  https://$HOSTNAME"
