#!/usr/bin/env bash
#
# Deploy the Vaticr forecasting API to a VPS, from this machine.
#
#   ./scripts/deploy-vps.sh root@203.0.113.10
#   ./scripts/deploy-vps.sh root@203.0.113.10 api.example.com
#   ./scripts/deploy-vps.sh root@203.0.113.10 api.example.com you@example.com
#
# The third argument turns on Let's Encrypt for the domain in the second.
#
# Files are pushed over SSH rather than pulled with `git clone`, because the
# repository is private - cloning on the server would mean leaving a GitHub
# credential there, which this avoids entirely. Re-run it any time to
# redeploy; every step is idempotent.

set -euo pipefail

TARGET="${1:-}"
DOMAIN="${2:-}"
TLS_EMAIL="${3:-}"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 user@host [api.domain.tld] [you@email.tld]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/vaticr
STATE_DIR=/var/lib/vaticr
PORT=8787

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- preflight
say "Checking SSH to $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo "  connected: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME")"' || {
  echo "Cannot reach $TARGET over SSH with key auth." >&2
  echo "Fix that first: ssh-copy-id $TARGET" >&2
  exit 1
}

# ------------------------------------------------------------------ payload
# Only what the API needs to run. No keys, no .env, no node_modules, no venv.
say "Uploading the forecasting layer"
ssh "$TARGET" "mkdir -p $APP_DIR"
rsync -az --delete \
  --exclude '__pycache__' --exclude '*.pyc' \
  "$REPO_ROOT/agents/" "$TARGET:$APP_DIR/agents/"
rsync -az "$REPO_ROOT/requirements.txt" "$TARGET:$APP_DIR/requirements.txt"
echo "  agents/ and requirements.txt in place"

# ------------------------------------------------------------------- remote
say "Provisioning $APP_DIR on the server"
ssh "$TARGET" "APP_DIR='$APP_DIR' STATE_DIR='$STATE_DIR' PORT='$PORT' DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v python3 >/dev/null; then apt-get update -qq && apt-get install -y -qq python3; fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || {
  echo "  ! Python 3.11+ required; this box has $(python3 -V)" >&2; exit 1; }
dpkg -s python3-venv >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq python3-venv; }
command -v rsync >/dev/null || apt-get install -y -qq rsync

id vaticr >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" vaticr
mkdir -p "$STATE_DIR"
chown -R vaticr:vaticr "$STATE_DIR"

# venv, refreshed in place
if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then python3 -m venv "$APP_DIR/.venv"; fi
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
echo "  dependencies installed"

# .env is written once and never overwritten, so hand edits survive a redeploy
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
chown -R vaticr:vaticr "$APP_DIR"

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

# The service reads public feeds and writes one state directory. Nothing else.
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
echo "  vaticr-api restarted"

# nginx, only when a domain was given
if [[ -n "${DOMAIN:-}" ]]; then
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
  echo "  nginx serving $DOMAIN"
fi
REMOTE

# --------------------------------------------------------------------- TLS
if [[ -n "$DOMAIN" && -n "$TLS_EMAIL" ]]; then
  say "Requesting a certificate for $DOMAIN"
  ssh "$TARGET" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx && \
    certbot --nginx -d '$DOMAIN' --non-interactive --agree-tos -m '$TLS_EMAIL' --redirect"
fi

# ------------------------------------------------------------------- verify
say "Verifying"
ssh "$TARGET" "systemctl is-active vaticr-api | sed 's/^/  service: /'"
ssh "$TARGET" "curl -fsS --max-time 20 localhost:$PORT/health >/dev/null && echo '  /health: ok' || { echo '  /health: FAILED'; journalctl -u vaticr-api -n 25 --no-pager; exit 1; }"

if [[ -n "$DOMAIN" ]]; then
  SCHEME=http; [[ -n "$TLS_EMAIL" ]] && SCHEME=https
  API_URL="$SCHEME://$DOMAIN"
else
  HOST_ONLY="${TARGET##*@}"
  API_URL="http://$HOST_ONLY:$PORT"
  say "No domain given, so nginx was skipped"
  echo "  To reach the API from Vercel you must open port $PORT to the internet"
  echo "  and bind uvicorn publicly. Re-run with a domain instead - it is one"
  echo "  DNS record, and it gets you TLS."
fi

say "Done"
echo "  Set this in Vercel, for Production and Preview:"
echo
echo "      VATICR_API_URL=$API_URL"
echo
echo "  Then redeploy the Vercel project so it picks the variable up."
echo "  Logs:    ssh $TARGET journalctl -u vaticr-api -f"
echo "  Restart: ssh $TARGET systemctl restart vaticr-api"
