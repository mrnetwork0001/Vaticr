#!/usr/bin/env bash
#
# Stand up the Vaticr forecasting API. Run this ON the server, as root, from
# a checkout of the repository:
#
#   sudo bash scripts/vps-bootstrap.sh --check          # inspect only, change nothing
#   sudo bash scripts/vps-bootstrap.sh
#   sudo bash scripts/vps-bootstrap.sh api.your-domain.tld
#   sudo bash scripts/vps-bootstrap.sh api.your-domain.tld you@email.tld
#
# With a domain it configures nginx; with an email as well it requests a
# Let's Encrypt certificate. Idempotent - re-run it after every `git pull`.
#
# SAFE ON A SHARED BOX. This assumes the server is already running things
# that matter, so it:
#
#   - never removes or edits an existing nginx site, including `default`,
#     and never touches nginx.conf;
#   - refuses to install nginx if something else already holds port 80,
#     rather than fighting Apache or Caddy for the bind;
#   - tars /etc/nginx to /root before its first change;
#   - rolls its own site file back out if `nginx -t` fails, so a broken
#     config is never left behind for someone else's reload to hit;
#   - picks a free port if 8787 is taken;
#   - installs only python3-venv, and nginx/certbot only when you asked for
#     a domain. It never runs `apt-get upgrade`.
#
# Run it with --check first. That touches nothing and prints the plan.
#
# (To drive the same thing from a laptop instead, use deploy-vps.sh.)

set -euo pipefail

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; shift; fi

DOMAIN="${1:-}"
TLS_EMAIL="${2:-}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/vaticr
STATE_DIR=/var/lib/vaticr
PORT="${VATICR_PORT:-8787}"
NGINX_BACKUP=/root/nginx-before-vaticr-$(date +%Y%m%d-%H%M%S).tar.gz

[[ $EUID -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1" >&2; exit 1; }

listening_on() {   # who holds a port, if anyone
  ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $NF}' | head -1
}
port_free() { [[ -z "$(listening_on "$1")" ]]; }

# ------------------------------------------------------------------ survey
# Everything here is read-only. It decides what is safe to do before doing it.
say "Surveying the box"
. /etc/os-release && echo "  $PRETTY_NAME"
export DEBIAN_FRONTEND=noninteractive

# What already holds the web ports, and is it something we can share with?
WEB80="$(listening_on 80)"
WEB443="$(listening_on 443)"
NGINX_PRESENT=0; command -v nginx >/dev/null && NGINX_PRESENT=1
WEB_OK=1

if [[ -n "$WEB80" || -n "$WEB443" ]]; then
  echo "  port 80:  ${WEB80:-free}"
  echo "  port 443: ${WEB443:-free}"
  if [[ "$WEB80$WEB443" == *nginx* ]]; then
    echo "  nginx already serves this box - Vaticr will be added as one more site"
  else
    WEB_OK=0
    warn "something other than nginx holds the web ports"
    warn "Vaticr will NOT install nginx or touch that server. See the note at the end."
  fi
else
  echo "  ports 80 and 443 are free"
fi

# Our own port. Never take one that is in use by something else.
if ! port_free "$PORT"; then
  HOLDER="$(listening_on "$PORT")"
  if [[ "$HOLDER" == *uvicorn* || "$HOLDER" == *vaticr* ]]; then
    echo "  port $PORT: already ours, will be restarted"
  else
    for p in $(seq 8788 8799); do
      if port_free "$p"; then warn "port $PORT is taken by $HOLDER - using $p instead"; PORT="$p"; break; fi
    done
    port_free "$PORT" || die "no free port in 8787-8799"
  fi
else
  echo "  port $PORT is free"
fi

# Anything already installed under our names?
[[ -e /etc/systemd/system/vaticr-api.service ]] && echo "  an existing vaticr-api unit will be replaced"
[[ -d "$APP_DIR" ]] && echo "  an existing $APP_DIR will be updated in place"
[[ -f "$APP_DIR/.env" ]] && echo "  an existing $APP_DIR/.env will be kept as-is"

# Report what we would install, so nothing is a surprise.
WANT=()
command -v python3 >/dev/null || WANT+=(python3)
dpkg -s python3-venv >/dev/null 2>&1 || WANT+=(python3-venv)
command -v curl >/dev/null || WANT+=(curl)
command -v rsync >/dev/null || WANT+=(rsync)
if [[ -n "$DOMAIN" && $WEB_OK -eq 1 && $NGINX_PRESENT -eq 0 ]]; then WANT+=(nginx); fi
if [[ -n "$DOMAIN" && -n "$TLS_EMAIL" && $WEB_OK -eq 1 ]]; then WANT+=(certbot python3-certbot-nginx); fi
if ((${#WANT[@]})); then echo "  apt would install: ${WANT[*]}"; else echo "  nothing to install from apt"; fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "Check only - nothing was changed"
  echo "  Re-run without --check to apply."
  exit 0
fi

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
  # One targeted edit: if the survey moved us to a different port, the file
  # must not keep advertising the old one. Nothing else in it is touched.
  if grep -q '^VATICR_API_PORT=' "$APP_DIR/.env"; then
    sed -i "s/^VATICR_API_PORT=.*/VATICR_API_PORT=$PORT/" "$APP_DIR/.env"
  else
    echo "VATICR_API_PORT=$PORT" >> "$APP_DIR/.env"
  fi
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
if [[ -n "$DOMAIN" && $WEB_OK -eq 0 ]]; then
  say "Skipping nginx"
  warn "Port 80 belongs to: $WEB80"
  warn "Vaticr will not install a second web server or edit that one's config."
  warn "Point it at http://127.0.0.1:$PORT yourself with a vhost for $DOMAIN,"
  warn "or tell me what it is and I will write the block for it."
elif [[ -n "$DOMAIN" ]]; then
  say "Configuring nginx for $DOMAIN"
  command -v nginx >/dev/null || { apt-get update -qq; apt-get install -y -qq nginx; }

  # A copy of the working config before we add anything to it.
  tar czf "$NGINX_BACKUP" -C /etc nginx 2>/dev/null && echo "  backed up /etc/nginx to $NGINX_BACKUP"

  # Refuse to clobber someone else's site file of the same name.
  if [[ -e /etc/nginx/sites-available/vaticr-api ]] && ! grep -q "vaticr" /etc/nginx/sites-available/vaticr-api 2>/dev/null; then
    die "/etc/nginx/sites-available/vaticr-api exists and is not ours - refusing to overwrite"
  fi
  # Warn if another site already claims this hostname.
  if grep -rlE "server_name[^;]*[[:space:]]$DOMAIN[;[:space:]]" /etc/nginx/sites-enabled/ 2>/dev/null \
     | grep -qv vaticr-api; then
    warn "another enabled site already mentions $DOMAIN - check for a conflict"
  fi

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
  # `default` and every other existing site are left exactly as they are.
  ln -sf /etc/nginx/sites-available/vaticr-api /etc/nginx/sites-enabled/vaticr-api

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  nginx serving $DOMAIN on port 80, other sites untouched"
  else
    rm -f /etc/nginx/sites-enabled/vaticr-api
    echo "  rolled our site back out; re-testing the config as it was:"
    nginx -t || true
    die "nginx rejected the new site. Nothing of ours is enabled; your other sites are unaffected. Restore point: $NGINX_BACKUP"
  fi

  if [[ -n "$TLS_EMAIL" ]]; then
    say "Requesting a certificate (touches only the $DOMAIN block)"
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
