#!/usr/bin/env bash
#
# Stand up Vaticr on a single VPS: the Next.js web app, the Python
# forecasting API, and optionally the trading bot, behind nginx with TLS.
#
# Run ON the server, as root, from a checkout at /opt/vaticr:
#
#   sudo bash scripts/vps-bootstrap.sh --check --domain usevaticr.xyz
#   sudo bash scripts/vps-bootstrap.sh --domain usevaticr.xyz --email you@mail.com
#   sudo bash scripts/vps-bootstrap.sh --domain usevaticr.xyz --with-bot
#
# Options
#   --check          survey and print the plan; change nothing
#   --domain NAME    hostname to serve (www.NAME is included automatically)
#   --email ADDR     request a Let's Encrypt certificate for those names
#   --api-only       install just the Python brain, no web app
#   --with-bot       also install the trading bot, in DRY RUN
#
# Everything the browser reaches is the web app. The brain binds 127.0.0.1
# and is reached only by the web app's server-side proxy, so it is never
# exposed to the internet and needs no certificate of its own.
#
# ─────────────────────────────────────────────────────────────────────────
# SAFE ON A SHARED BOX. This assumes the server already runs things that
# matter, so it:
#
#   - never removes or edits an existing nginx site, including `default`,
#     and never touches nginx.conf;
#   - refuses to install nginx if something else already holds port 80,
#     rather than fighting Apache or Caddy for the bind;
#   - never replaces a system Node. If Node 20+ is not already present it
#     installs one privately under /opt/vaticr-node and uses it by absolute
#     path, so other Node services keep the runtime they have;
#   - tars /etc/nginx to /root before its first change;
#   - rolls its own site file back out if `nginx -t` fails, so a broken
#     config is never left for someone else's reload to hit;
#   - moves to a free port if 8787 or 3000 is taken;
#   - never runs `apt-get upgrade`.
#
# Run with --check first. That touches nothing.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

CHECK_ONLY=0; DOMAIN=""; TLS_EMAIL=""; API_ONLY=0; WITH_BOT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)    CHECK_ONLY=1; shift ;;
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --email)    TLS_EMAIL="${2:-}"; shift 2 ;;
    --api-only) API_ONLY=1; shift ;;
    --with-bot) WITH_BOT=1; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR=/var/lib/vaticr
NODE_DIR=/opt/vaticr-node
API_PORT="${VATICR_API_PORT:-8787}"
WEB_PORT="${VATICR_WEB_PORT:-3000}"
NODE_VER=20.18.1
NGINX_BACKUP=/root/nginx-before-vaticr-$(date +%Y%m%d-%H%M%S).tar.gz

[[ $EUID -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }
ok()   { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

listening_on() { ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $NF}' | head -1; }
port_free()    { [[ -z "$(listening_on "$1")" ]]; }
pid_on_port()  { listening_on "$1" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

# Is the process holding this port one of ours? Ask the kernel which unit it
# belongs to rather than guessing from the process name: systemd runs the API
# as `python -m uvicorn` and the web app as `node`, so a name match recognises
# neither, and a re-run walks both services onto new ports every time.
port_is_ours() {
  local pid; pid="$(pid_on_port "$1")"
  [[ -n "$pid" ]] || return 1
  grep -qE 'vaticr-(api|web|bot)\.service' "/proc/$pid/cgroup" 2>/dev/null
}

pick_port() {  # $1 = wanted, $2 = ceiling, $3 = label. Echoes the chosen port.
  local want="$1" top="$2" label="$3" holder
  if port_free "$want" || port_is_ours "$want"; then echo "$want"; return; fi
  holder="$(listening_on "$want")"
  local p
  for ((p = want + 1; p <= top; p++)); do
    if port_free "$p" || port_is_ours "$p"; then
      warn "$label port $want is held by $holder - using $p" >&2; echo "$p"; return
    fi
  done
  die "no free $label port between $want and $top"
}

# ══════════════════════════════════════════════════════════════════ survey
# Read-only. Decides what is safe before anything is done.
say "Surveying the box"
. /etc/os-release && echo "  $PRETTY_NAME"
export DEBIAN_FRONTEND=noninteractive

command -v ss >/dev/null || { apt-get update -qq; apt-get install -y -qq iproute2; }

MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
echo "  memory: ${MEM_MB} MB RAM, ${SWAP_MB} MB swap"

# Python
if command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)'; then
  ok "$(python3 -V) meets the 3.11 minimum"
else
  die "Vaticr needs Python 3.11+; this box has $(python3 -V 2>&1). Upgrade the box or add deadsnakes."
fi

# Node: use the system one only if it is new enough, and never replace it.
NODE_BIN=""; NPM_BIN=""
if command -v node >/dev/null; then
  SYS_NODE="$(node -v)"
  if [[ "${SYS_NODE#v}" == 2[0-9].* || "${SYS_NODE#v}" == [3-9][0-9].* ]]; then
    NODE_BIN="$(command -v node)"; NPM_BIN="$(command -v npm)"
    ok "system Node $SYS_NODE will be used"
  else
    warn "system Node $SYS_NODE is too old, and other services may depend on it"
    warn "Node $NODE_VER will be installed privately under $NODE_DIR instead"
  fi
else
  echo "  no system Node; Node $NODE_VER will be installed under $NODE_DIR"
fi
[[ -x "$NODE_DIR/bin/node" ]] && { NODE_BIN="$NODE_DIR/bin/node"; NPM_BIN="$NODE_DIR/bin/npm"; ok "private Node already at $NODE_DIR"; }

# Which server owns the edge? Join it; never fight it for the bind.
WEB80="$(listening_on 80)"; WEB443="$(listening_on 443)"
EDGE=none
if [[ -n "$WEB80$WEB443" ]]; then
  echo "  port 80: ${WEB80:-free} · port 443: ${WEB443:-free}"
  case "$WEB80$WEB443" in
    *caddy*) EDGE=caddy; ok "Caddy is the edge; Vaticr will be added as one more site" ;;
    *nginx*) EDGE=nginx; ok "nginx is the edge; Vaticr will be added as one more site" ;;
    *)       EDGE=foreign
             warn "an unrecognised server holds the web ports"
             warn "no web server will be installed or reconfigured" ;;
  esac
else
  EDGE=nginx-new
  ok "ports 80 and 443 are free; nginx will be installed"
fi

# nginx may be installed but idle behind another edge. Never start it.
if [[ "$EDGE" == caddy ]] && command -v nginx >/dev/null && ! systemctl is-active --quiet nginx; then
  warn "nginx is installed but not running - leaving it stopped, Caddy owns the ports"
fi

API_PORT="$(pick_port "$API_PORT" 8799 API)"
[[ $API_ONLY -eq 0 ]] && WEB_PORT="$(pick_port "$WEB_PORT" 3010 web)"
ok "API on 127.0.0.1:$API_PORT$([[ $API_ONLY -eq 0 ]] && echo ", web on 127.0.0.1:$WEB_PORT")"

# A production Next build is the memory-hungry step on a small box.
if [[ $API_ONLY -eq 0 && $((MEM_MB + SWAP_MB)) -lt 1800 ]]; then
  warn "only $((MEM_MB + SWAP_MB)) MB of RAM+swap; the Next build may be killed"
  warn "this script will add a 2G swapfile at /swapfile if none exists"
fi

for u in vaticr-api vaticr-web vaticr-bot; do
  [[ -e "/etc/systemd/system/$u.service" ]] && echo "  existing $u unit will be replaced"
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "Check only - nothing was changed"
  echo "  Plan: API on $API_PORT$([[ $API_ONLY -eq 0 ]] && echo ", web on $WEB_PORT")"
  [[ -n "$DOMAIN" ]] && echo "  edge: $EDGE will serve $DOMAIN and www.$DOMAIN -> 127.0.0.1:$WEB_PORT"
  [[ "$EDGE" == caddy ]] && echo "  TLS: automatic, issued by Caddy - certbot not used"
  [[ "$EDGE" == foreign ]] && echo "  edge: SKIPPED, proxy it yourself"
  [[ $WITH_BOT -eq 1 ]] && echo "  bot: installed in DRY RUN"
  echo "  Re-run without --check to apply."
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════ swap
if [[ $API_ONLY -eq 0 && $((MEM_MB + SWAP_MB)) -lt 1800 && ! -e /swapfile ]]; then
  say "Adding a 2G swapfile so the build is not killed"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap -q /swapfile; swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap active"
fi

# ═══════════════════════════════════════════════════════════ dependencies
say "Installing what is missing"
NEED=()
dpkg -s python3-venv >/dev/null 2>&1 || NEED+=(python3-venv)
command -v curl >/dev/null || NEED+=(curl)
command -v rsync >/dev/null || NEED+=(rsync)
command -v git >/dev/null || NEED+=(git)
if ((${#NEED[@]})); then apt-get update -qq; apt-get install -y -qq "${NEED[@]}"; ok "apt: ${NEED[*]}"; else ok "apt: nothing needed"; fi

if [[ $API_ONLY -eq 0 && -z "$NODE_BIN" ]]; then
  say "Installing Node $NODE_VER privately (system Node untouched)"
  ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) die "unsupported arch $ARCH" ;; esac
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-$NARCH.tar.xz" \
    | tar -xJ -C "$NODE_DIR" --strip-components=1
  NODE_BIN="$NODE_DIR/bin/node"; NPM_BIN="$NODE_DIR/bin/npm"
  ok "$("$NODE_BIN" -v) at $NODE_DIR"
fi

id vaticr >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP" vaticr
mkdir -p "$STATE_DIR"

# ══════════════════════════════════════════════════════════════════ brain
say "Building the forecasting API"
[[ -x "$APP/.venv/bin/python" ]] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
ok "python dependencies installed"

# Written once; a redeploy never overwrites edits. Only the ports are synced.
if [[ ! -f "$APP/.env" ]]; then
  cat > "$APP/.env" <<ENVFILE
NETWORK=testnet
VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
VATICR_API_HOST=127.0.0.1
VATICR_API_PORT=$API_PORT
VATICR_STATE_DIR=$STATE_DIR
DRY_RUN=true
ENVFILE
  ok "wrote $APP/.env"
else
  sed -i "s|^VATICR_API_PORT=.*|VATICR_API_PORT=$API_PORT|" "$APP/.env" 2>/dev/null || true
  grep -q '^VATICR_STATE_DIR=' "$APP/.env" || echo "VATICR_STATE_DIR=$STATE_DIR" >> "$APP/.env"
  ok "kept the existing $APP/.env"
fi
chmod 600 "$APP/.env"

cat > /etc/systemd/system/vaticr-api.service <<UNIT
[Unit]
Description=Vaticr forecasting API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vaticr
Group=vaticr
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=$APP/.venv/bin/python -m uvicorn agents.server:app --host 127.0.0.1 --port $API_PORT
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT

# ════════════════════════════════════════════════════════════════════ web
if [[ $API_ONLY -eq 0 ]]; then
  say "Building the web app (this is the slow step)"
  SITE_URL="http://localhost:$WEB_PORT"
  [[ -n "$DOMAIN" ]] && SITE_URL="https://$DOMAIN"

  # NEXT_PUBLIC_* values are compiled into the browser bundle, so this file
  # has to exist BEFORE the build, not just at runtime.
  cat > "$APP/.env.production" <<WEBENV
NEXT_PUBLIC_SITE_URL=$SITE_URL
NEXT_PUBLIC_VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
NEXT_PUBLIC_SOMNIA_RPC_URL=https://api.infra.testnet.somnia.network
NEXT_PUBLIC_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql
VATICR_REGISTRY=0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A
WEBENV
  ok "wrote $APP/.env.production (site $SITE_URL)"

  cd "$APP"
  "$NPM_BIN" install --no-audit --no-fund
  "$NPM_BIN" run build
  ok "next build complete"

  cat > /etc/systemd/system/vaticr-web.service <<UNIT
[Unit]
Description=Vaticr web app
After=network-online.target vaticr-api.service
Wants=network-online.target

[Service]
Type=simple
User=vaticr
Group=vaticr
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=PORT=$WEB_PORT
Environment=HOSTNAME=127.0.0.1
Environment=VATICR_API_URL=http://127.0.0.1:$API_PORT
ExecStart=$NODE_BIN $APP/node_modules/.bin/next start -p $WEB_PORT -H 127.0.0.1
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
fi

# ════════════════════════════════════════════════════════════════════ bot
if [[ $WITH_BOT -eq 1 ]]; then
  say "Installing the trading bot, in DRY RUN"
  grep -q '^DRY_RUN=' "$APP/.env" || echo "DRY_RUN=true" >> "$APP/.env"
  grep -q '^VATICR_API_URL=' "$APP/.env" || echo "VATICR_API_URL=http://127.0.0.1:$API_PORT" >> "$APP/.env"

  cat > /etc/systemd/system/vaticr-bot.service <<UNIT
[Unit]
Description=Vaticr trading bot
After=network-online.target vaticr-api.service
Wants=network-online.target

[Service]
Type=simple
User=vaticr
Group=vaticr
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
ExecStart=$NPM_BIN run bot:only
Restart=always
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  if grep -qE '^PRIVATE_KEY=0x[0-9a-fA-F]{64}$' "$APP/.env"; then
    ok "a well-formed PRIVATE_KEY is present"
  else
    warn "no valid PRIVATE_KEY in $APP/.env - the bot cannot sign until you add one"
  fi
  if grep -q '^DRY_RUN=true' "$APP/.env"; then
    ok "DRY_RUN=true - it logs orders and sends nothing"
  else
    warn "DRY_RUN is not true - this bot can place real orders"
  fi
fi

# Ownership, deliberately narrow. Chowning the whole checkout to the service
# user makes git refuse it as "dubious ownership" for root, which breaks the
# documented `git pull` redeploy. The service only needs to READ the tree,
# which world-readable permissions already allow; it writes just three places.
chown -R vaticr:vaticr "$STATE_DIR"
chown vaticr:vaticr "$APP/.env" 2>/dev/null || true
chown vaticr:vaticr "$APP/.env.production" 2>/dev/null || true
[[ -d "$APP/.next" ]] && chown -R vaticr:vaticr "$APP/.next"

# Repair a checkout an earlier version chowned wholesale, so git works again.
if [[ -d "$APP/.git" && "$(stat -c %U "$APP/.git")" != root ]]; then
  chown -R root:root "$APP/.git"
  find "$APP" -maxdepth 1 -mindepth 1 \
    ! -name .next ! -name .env ! -name .env.production ! -name .git \
    -exec chown -R root:root {} + 2>/dev/null || true
  ok "returned the checkout to root so git pull works"
fi

# ════════════════════════════════════════════════════════════════ services
say "Starting services"
systemctl daemon-reload
systemctl enable -q vaticr-api && systemctl restart vaticr-api
sleep 3
systemctl is-active --quiet vaticr-api || { journalctl -u vaticr-api -n 30 --no-pager >&2; die "vaticr-api did not start"; }
ok "vaticr-api active on 127.0.0.1:$API_PORT"

if [[ $API_ONLY -eq 0 ]]; then
  systemctl enable -q vaticr-web && systemctl restart vaticr-web
  sleep 4
  systemctl is-active --quiet vaticr-web || { journalctl -u vaticr-web -n 30 --no-pager >&2; die "vaticr-web did not start"; }
  ok "vaticr-web active on 127.0.0.1:$WEB_PORT"
fi

# ══════════════════════════════════════════════════════════════════ nginx
if [[ -n "$DOMAIN" && "$EDGE" == foreign ]]; then
  say "Leaving the edge alone"
  warn "port 80 belongs to: $WEB80"
  warn "Vaticr will not install a second web server or edit that one's config."
  warn "Proxy $DOMAIN to http://127.0.0.1:$WEB_PORT from it yourself."

elif [[ -n "$DOMAIN" && "$EDGE" == caddy ]]; then
  # ── Caddy ──────────────────────────────────────────────────────────────
  # Caddy provisions its own certificates, so there is no certbot step and
  # no renewal to arrange. Our site goes in its own file, imported by the
  # main Caddyfile, so no existing block is ever edited.
  say "Adding a Caddy site for $DOMAIN"
  CADDYFILE=/etc/caddy/Caddyfile
  [[ -f "$CADDYFILE" ]] || die "Caddy is running but $CADDYFILE is missing - tell me where its config lives"

  CADDY_BACKUP=/root/Caddyfile-before-vaticr-$(date +%Y%m%d-%H%M%S)
  cp -a "$CADDYFILE" "$CADDY_BACKUP"; ok "backed up $CADDYFILE to $CADDY_BACKUP"

  # Our own site file is not a conflict with itself, so it is excluded.
  if grep -qE "^[[:space:]]*[^#]*$DOMAIN" "$CADDYFILE" 2>/dev/null || \
     grep -rlE "^[[:space:]]*[^#]*$DOMAIN" /etc/caddy/conf.d/ 2>/dev/null | grep -qv "vaticr.caddy"; then
    warn "$DOMAIN already appears in another Caddy site - check for a conflict"
  fi

  mkdir -p /etc/caddy/conf.d
  cat > /etc/caddy/conf.d/vaticr.caddy <<CADDY
# Vaticr. The web app listens on loopback only; this is its way in.
$DOMAIN, www.$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$WEB_PORT {
		# /audit recomputes every settlement from the oracle feed.
		transport http {
			read_timeout 90s
		}
	}
}
CADDY

  # Import the directory once, appended at the end so no existing block moves.
  if ! grep -qE '^\s*import\s+/etc/caddy/conf\.d/' "$CADDYFILE"; then
    printf '\n# added by Vaticr - per-site files, so this file need not be edited again\nimport /etc/caddy/conf.d/*.caddy\n' >> "$CADDYFILE"
    ok "added one import line to $CADDYFILE"
  else
    ok "$CADDYFILE already imports conf.d"
  fi

  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    ok "Caddy serving $DOMAIN, every other site untouched"
    ok "TLS will be issued automatically once DNS resolves here"
  else
    rm -f /etc/caddy/conf.d/vaticr.caddy
    cp -a "$CADDY_BACKUP" "$CADDYFILE"
    echo "  rolled our changes back out; validating the config as it was:"
    caddy validate --config "$CADDYFILE" --adapter caddyfile || true
    die "Caddy rejected the new site. Nothing of ours remains; your other sites are unaffected."
  fi

elif [[ -n "$DOMAIN" ]]; then
  # Reached only when nginx is the edge, or nothing is.
  say "Configuring nginx for $DOMAIN"
  command -v nginx >/dev/null || { apt-get update -qq; apt-get install -y -qq nginx; }
  tar czf "$NGINX_BACKUP" -C /etc nginx 2>/dev/null && ok "backed up /etc/nginx to $NGINX_BACKUP"

  if [[ -e /etc/nginx/sites-available/vaticr ]] && ! grep -q vaticr /etc/nginx/sites-available/vaticr 2>/dev/null; then
    die "/etc/nginx/sites-available/vaticr exists and is not ours - refusing to overwrite"
  fi
  if grep -rlE "server_name[^;]*[[:space:]]$DOMAIN[;[:space:]]" /etc/nginx/sites-enabled/ 2>/dev/null | grep -qv vaticr; then
    warn "another enabled site already mentions $DOMAIN - check for a conflict"
  fi

  cat > /etc/nginx/sites-available/vaticr <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 90s;   # /audit recomputes settlements; give it room
    }
}
NGINX
  # `default` and every other existing site are left exactly as they are.
  ln -sf /etc/nginx/sites-available/vaticr /etc/nginx/sites-enabled/vaticr

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "nginx serving $DOMAIN, other sites untouched"
  else
    rm -f /etc/nginx/sites-enabled/vaticr
    echo "  rolled our site back out; the config as it was:"
    nginx -t || true
    die "nginx rejected the new site. Nothing of ours is enabled; your other sites are unaffected. Restore point: $NGINX_BACKUP"
  fi

  if [[ -n "$TLS_EMAIL" ]]; then
    say "Requesting a certificate (touches only the $DOMAIN block)"
    apt-get install -y -qq certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
      --non-interactive --agree-tos -m "$TLS_EMAIL" --redirect \
      || warn "certbot failed - the site still works over http. Check DNS has propagated, then re-run just this: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
  fi
fi

# ═════════════════════════════════════════════════════════════════ verify
say "Verifying"
curl -fsS --max-time 25 "127.0.0.1:$API_PORT/health" >/dev/null && ok "api /health" || die "api /health failed"
if [[ $API_ONLY -eq 0 ]]; then
  curl -fsS --max-time 25 -o /dev/null "127.0.0.1:$WEB_PORT/" && ok "web /" || die "web / failed"
  curl -fsS --max-time 40 -o /dev/null "127.0.0.1:$WEB_PORT/api/vaticr/health" \
    && ok "web reaches the brain through its proxy" \
    || warn "the web app could not reach the brain - check VATICR_API_URL in the unit"
fi

say "Done"
[[ -n "$DOMAIN" ]] && echo "  https://$DOMAIN"
echo
echo "  Logs:    journalctl -u vaticr-web -f     (or -u vaticr-api, -u vaticr-bot)"
echo "  Restart: systemctl restart vaticr-web"
echo "  Redeploy after a git pull: sudo bash scripts/vps-bootstrap.sh --domain ${DOMAIN:-YOURDOMAIN}"
