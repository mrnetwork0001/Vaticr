#!/usr/bin/env bash
#
# Stand up the Vaticr forecasting API. Run this ON the server, as root, from
# a checkout of the repository:
#
#   sudo bash scripts/vps-bootstrap.sh
#   sudo bash scripts/vps-bootstrap.sh api.your-domain.tld
#   sudo bash scripts/vps-bootstrap.sh api.your-domain.tld you@email.tld
#
# With a domain it configures nginx; with an email as well it requests a
# Let's Encrypt certificate. Idempotent - re-run it after every `git pull`.
#
# (To drive the same thing from a laptop instead, use deploy-vps.sh.)

set -euo pipefail

DOMAIN="${1:-}"
TLS_EMAIL="${2:-}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/vaticr
STATE_DIR=/var/lib/vaticr
PORT=8787

[[ $EUID -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }

# ------------------------------------------------------------- dependencies
say "Checking the box"
. /etc/os-release && echo "  $PRETTY_NAME"
export DEBIAN_FRONTEND=noninteractive

command -v python3 >/dev/null || { apt-get update -qq; apt-get install -y -qq python3; }
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'; then
  echo "  ! Vaticr needs Python 3.11+; this box has $(python3 -V)." >&2
  echo "    On Ubuntu 20.04 or Debian 11, add deadsnakes or upgrade the box." >&2
  exit 1
fi
echo "  $(python3 -V)"
dpkg -s python3-venv >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq python3-venv; }
command -v rsync >/dev/null || apt-get install -y -qq rsync
command -v curl  >/dev/null || apt-get install -y -qq curl

# -------------------------------------------------------------------- files
say "Installing to $APP_DIR"
id vaticr >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" vaticr
mkdir -p "$APP_DIR" "$STATE_DIR"

# Only the forecasting layer is served. The checkout stays wherever it is.
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$SRC/agents/" "$APP_DIR/agents/"
cp "$SRC/requirements.txt" "$APP_DIR/requirements.txt"
echo "  agents/ and requirements.txt in place"

[[ -x "$APP_DIR/.venv/bin/python" ]] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
echo "  dependencies installed"

# Written once. A redeploy never overwrites your edits.
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<ENVFILE
NETWORK=testnet
VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
VATICR_API_HOST=127.0.0.1
VATICR_API_PORT=$PORT
VATICR_STATE_DIR=$STATE_DIR
ENVFILE
  echo "  wrote $APP_DIR/.env"
else
  echo "  kept the existing $APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"
chown -R vaticr:vaticr "$APP_DIR" "$STATE_DIR"

# ------------------------------------------------------------------ service
say "Installing the service"
cat > /etc/systemd/system/vaticr-api.service <<UNIT
[Unit]
Description=Vaticr forecasting API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vaticr
Group=vaticr
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/.venv/bin/python -m uvicorn agents.server:app --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=5

# It reads public feeds and appends one state file. It needs nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable -q vaticr-api
systemctl restart vaticr-api
sleep 3

if ! systemctl is-active --quiet vaticr-api; then
  echo "  ! the service did not start:" >&2
  journalctl -u vaticr-api -n 30 --no-pager >&2
  exit 1
fi
echo "  vaticr-api active"

# -------------------------------------------------------------------- nginx
if [[ -n "$DOMAIN" ]]; then
  say "Configuring nginx for $DOMAIN"
  command -v nginx >/dev/null || { apt-get update -qq; apt-get install -y -qq nginx; }
  cat > /etc/nginx/sites-available/vaticr-api <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;   # /audit recomputes settlements; give it room
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/vaticr-api /etc/nginx/sites-enabled/vaticr-api
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "  nginx serving $DOMAIN on port 80"

  if [[ -n "$TLS_EMAIL" ]]; then
    say "Requesting a certificate"
    apt-get install -y -qq certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$TLS_EMAIL" --redirect
  fi
fi

# ------------------------------------------------------------------- verify
say "Verifying"
curl -fsS --max-time 25 "localhost:$PORT/health" >/dev/null \
  && echo "  /health: ok" \
  || { echo "  /health: FAILED"; journalctl -u vaticr-api -n 30 --no-pager; exit 1; }

if [[ -n "$DOMAIN" ]]; then
  SCHEME=http; [[ -n "$TLS_EMAIL" ]] && SCHEME=https
  API_URL="$SCHEME://$DOMAIN"
else
  API_URL="http://127.0.0.1:$PORT   (loopback only - give a domain to expose it)"
fi

say "Done"
echo "  Set this in Vercel, for Production and Preview:"
echo
echo "      VATICR_API_URL=$API_URL"
echo
echo "  Logs:    journalctl -u vaticr-api -f"
echo "  Restart: systemctl restart vaticr-api"
