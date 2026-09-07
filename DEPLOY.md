# Deploying Vaticr

Two processes, deployed separately:

| Piece | What it is | Where it goes |
|---|---|---|
| **Web** | Next.js 14 app - landing page, dashboard, wallet | Vercel |
| **Brain** | FastAPI service - forecasts, audit, calibration, headlines | VPS |
| **Bot** | The trading loop (optional, but it is what makes the dashboard live) | Same VPS |

The browser never talks to the brain directly. The Next server proxies
`/api/vaticr/*` to it ([`app/api/vaticr/[...path]/route.ts`](app/api/vaticr/[...path]/route.ts)),
so there is **no CORS to configure** and the API URL never reaches the client.

---

## 1. The VPS

Ubuntu 22.04+, one small instance is enough.

```bash
sudo apt update && sudo apt install -y python3-venv python3-pip nginx git
git clone https://github.com/mrnetwork0001/Vaticr.git /opt/vaticr
cd /opt/vaticr

python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

cp .env.example .env
```

Edit `/opt/vaticr/.env`. The brain needs very little:

```ini
NETWORK=testnet
VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
VATICR_API_HOST=127.0.0.1     # bind to loopback; nginx is the only way in
VATICR_API_PORT=8787
```

### Run it under systemd

```ini
# /etc/systemd/system/vaticr-api.service
[Unit]
Description=Vaticr forecasting API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vaticr
WorkingDirectory=/opt/vaticr
EnvironmentFile=/opt/vaticr/.env
ExecStart=/opt/vaticr/.venv/bin/python -m uvicorn agents.server:app --host 127.0.0.1 --port 8787
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin vaticr && sudo chown -R vaticr:vaticr /opt/vaticr
sudo systemctl daemon-reload && sudo systemctl enable --now vaticr-api
curl -s localhost:8787/health | head -c 200      # sanity check
```

### Expose it over TLS

```nginx
# /etc/nginx/sites-available/vaticr-api
server {
    server_name api.your-domain.tld;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;          # /audit recomputes settlements; give it room
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vaticr-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.your-domain.tld
```

Firewall: allow 80/443 only. Port 8787 stays on loopback.

### The bot (optional, recommended for the demo)

Without it the dashboard still forecasts and audits - it just never places an
order, so the book never shows the agent's own quotes.

```bash
cd /opt/vaticr && npm install        # needs Node 20+
```

Add the signer to `.env`, and **start with `DRY_RUN=true`**:

```ini
DRY_RUN=true
PRIVATE_KEY=0x...        # a testnet key, funded with tUSDC. Never a real one.
VATICR_API_URL=http://127.0.0.1:8787
VATICR_COMMIT_FORECASTS=true
```

Watch a full cycle in dry run, confirm the orders it *would* place look right,
then flip `DRY_RUN=false` and run it the same way as the API - a second systemd
unit with `ExecStart=/usr/bin/npm run bot:only`, `WorkingDirectory=/opt/vaticr`.

> The `.env` on this box holds a funded private key. `chmod 600 .env`, keep the
> box patched, and never commit it.

---

## 2. Vercel

Import the repo. Framework preset **Next.js**; the defaults for build command
and output directory are correct - do not override them.

### Environment variables

Set these for **Production** and **Preview**:

| Variable | Value | Why |
|---|---|---|
| `VATICR_API_URL` | `https://api.your-domain.tld` | The VPS. Server-side only - never shipped to the browser. |
| `NEXT_PUBLIC_SITE_URL` | `https://your-domain.tld` | Absolute `og:` URLs, or link unfurls break. |
| `NEXT_PUBLIC_VENUE_ID` | `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c` | Which venue the app reads. |
| `NEXT_PUBLIC_SOMNIA_RPC_URL` | `https://api.infra.testnet.somnia.network` | Chain reads and the order book. |
| `NEXT_PUBLIC_INDEXER_URL` | `https://dev.smk.somnia.host/v1/graphql` | Market list and history. |
| `VATICR_REGISTRY` | `0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A` | Deployed forecast registry. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | *(optional)* | Without it, wallet connect degrades to injected-only - fine for a desktop demo, but **mobile wallets need it**. |

Anything `NEXT_PUBLIC_*` is **public** - it is compiled into the JavaScript the
browser downloads. Nothing secret goes in one. `PRIVATE_KEY` belongs on the VPS
and must never be added to Vercel.

### Custom domain

Add the domain in Vercel, point the DNS, and set `NEXT_PUBLIC_SITE_URL` to
match. Use a subdomain such as `api.` for the VPS so both sit under one name.

---

## 3. Verify the deploy

```bash
curl -s https://your-domain.tld/api/vaticr/health          # proxy reaches the VPS
curl -s https://your-domain.tld/privacy -o /dev/null -w '%{http_code}\n'
```

Then, in a browser:

1. Landing page renders, nav and hamburger both work.
2. `/dashboard` lists live windows with a posterior on each - **if these are
   empty, `VATICR_API_URL` is wrong or the VPS is down**; that is the single
   most common failure.
3. Connect a wallet, switch to Somnia testnet, place a small order.
4. Audit view shows settlements recomputed and matching.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Dashboard loads, every panel empty | `VATICR_API_URL` unset or unreachable. Check `systemctl status vaticr-api`. |
| `/api/vaticr/*` returns 504 | Brain is slow or down; `/audit` is the heaviest route - raise `proxy_read_timeout`. |
| Wallet button does nothing on a phone | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` missing. |
| Link previews show a bare URL | `NEXT_PUBLIC_SITE_URL` missing, so `metadataBase` fell back to localhost. |
| Book shows no bids or asks | Expected when nothing is resting. Confirm against the explorer before assuming a bug. |
