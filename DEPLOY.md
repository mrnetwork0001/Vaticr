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

One script does the whole thing from this machine:

```bash
./scripts/deploy-vps.sh root@YOUR_SERVER_IP api.your-domain.tld you@email.tld
```

- **1st argument** - the SSH target. Key auth must already work
  (`ssh-copy-id root@YOUR_SERVER_IP` if it does not).
- **2nd argument** *(optional)* - the domain for the API. Sets up nginx. Point
  an A record at the server before running this.
- **3rd argument** *(optional)* - your email. Requests a Let's Encrypt
  certificate for that domain.

Re-run it any time to redeploy. Every step is idempotent, and your `.env` on
the server is written once and never overwritten afterwards.

### Why it pushes files instead of cloning

**The repository is private.** `git clone` on the server would mean leaving a
GitHub credential there, so the script `rsync`s `agents/` and
`requirements.txt` over SSH instead. Nothing else goes up: no keys, no `.env`,
no `node_modules`, no local virtualenv.

### What it puts on the server

| Path | What |
|---|---|
| `/opt/vaticr` | `agents/`, `requirements.txt`, the virtualenv, `.env` (mode 600) |
| `/var/lib/vaticr` | `forecasts.jsonl` and lock file - state lives outside the code |
| `/etc/systemd/system/vaticr-api.service` | The unit. Runs as an unprivileged `vaticr` user under `ProtectSystem=strict`, with `/var/lib/vaticr` its only writable path |
| `/etc/nginx/sites-available/vaticr-api` | Reverse proxy on 80/443, only when a domain was given |

Uvicorn binds `127.0.0.1`, so nginx is the only way in. Requirements on the
box: Ubuntu/Debian with **Python 3.11+** and root over SSH. Node is not needed
for the API.

### Verify by hand

```bash
ssh root@YOUR_SERVER_IP systemctl status vaticr-api
ssh root@YOUR_SERVER_IP journalctl -u vaticr-api -f
curl -s https://api.your-domain.tld/health
```

### The bot (optional, recommended for the demo)

Without it the dashboard still forecasts and audits - it just never places an
order, so the book never shows the agent's own quotes. The bot is the Node
side, so it needs the whole repository rather than `agents/` alone, plus
Node 20+:

```bash
rsync -az --exclude node_modules --exclude .next --exclude .venv --exclude .git \
  ./ root@YOUR_SERVER_IP:/opt/vaticr-bot/
ssh root@YOUR_SERVER_IP 'cd /opt/vaticr-bot && npm install --omit=dev'
```

Add the signer to `/opt/vaticr-bot/.env`, and **start with `DRY_RUN=true`**:

```ini
DRY_RUN=true
PRIVATE_KEY=0x...        # a testnet key, funded with tUSDC. Never a real one.
VATICR_API_URL=http://127.0.0.1:8787
VATICR_COMMIT_FORECASTS=true
```

Watch a full cycle in dry run, confirm the orders it *would* place look right,
then set `DRY_RUN=false` and give it its own systemd unit with
`ExecStart=/usr/bin/npm run bot:only` and `WorkingDirectory=/opt/vaticr-bot`.

> That `.env` holds a funded private key. `chmod 600` it, keep the box
> patched, and never commit it.

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
