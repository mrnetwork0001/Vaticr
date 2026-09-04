# 🔮 Vaticr

**Autonomous DeAI forecasting and market making for DreamDEX Event Contracts on Somnia.**

Built for the [Somnia × DreamDEX Event Contracts Hackathon](https://dorahacks.io/hackathon/event-contracts/detail) · Apache-2.0

---

## What it does

A DreamDEX Event Contract asks one question: *will this window close at or above
the price it opened at?* That makes the fair value of a YES token a genuine
probability — and a probability can be **derived** rather than guessed.

Vaticr derives it, trades it, and then proves whether it was any good.

1. **Prior from the price process.** Where the window sits relative to its own
   open, given time remaining and measured volatility.
2. **Posterior from the news.** Live headlines scored for directional impact and
   folded in as log-likelihood ratios — decayed by age, credibility, and how
   much of the window is left.
3. **Traded through the official Bot Kit.** Takes when the posterior clears the
   *touch*; otherwise rests a two-sided **mint-a-pair** quote that needs **zero
   inventory**.
4. **Audited afterwards.** Every settlement is independently recomputed from the
   public oracle feed, and every forecast is Brier-scored against what actually
   happened.

> **Not a market factory.** DreamDEX Event Contracts are protocol-created
> rolling BTC/ETH windows, and they settle themselves via the OracleHub — there
> is no permissionless market creation and no news-driven resolution. Vaticr
> works *with* that design rather than against it. The reasoning is in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quickstart

```bash
git clone https://github.com/mrnetwork0001/Vaticr.git && cd Vaticr

npm install                              # workspace: bot + vendored Bot Kit ec-core

python3.11 -m venv .venv                 # the tooling looks for ./.venv first
./.venv/bin/pip install -r requirements.txt

cp .env.example .env                     # works as-is; DRY_RUN=true by default

npm run bot:start                        # one command: starts the brain, then the bot
```

That is the whole setup. `bot:start` brings up the Python intelligence layer,
waits for the first news scan, then runs the trading loop — **in dry run**,
logging every order it would place and sending nothing.

The virtualenv is not optional in practice: `scripts/start.mjs` and the `api` /
`test:agents` npm scripts all prefer `./.venv/bin/python` and only fall back to
whatever `python3` is on `PATH`. Any Python 3.11+ interpreter works; put it at
`./.venv` and everything finds it.

Check everything first:

```bash
npm run doctor      # venue scope, live markets, API, wallet, balances
```

To trade for real, set a funded key and turn off the safety:

```bash
# .env
DRY_RUN=false
PRIVATE_KEY=0x...
```

Watch it on the dashboard:

```bash
npm run dev         # http://localhost:3000
```

<sub>If port 8787 is taken: `VATICR_API_PORT=8799 npm run bot:start` (and set
`VATICR_API_URL=http://127.0.0.1:8799` so the bot and the dashboard follow).</sub>

---

## Funding a testnet run

Dry run needs nothing. Trading for real on Somnia testnet needs two assets, and
only one of them is your problem:

**1. STT for gas — you fetch this.** Somnia's Shannon testnet (chainId **50312**)
pays gas in STT.

| | |
|---|---|
| Faucet | <https://testnet.somnia.network/> |
| Explorer | <https://shannon-explorer.somnia.network/> |
| RPC | `https://api.infra.testnet.somnia.network` |

Alternate faucets if that one is dry: [Google Cloud](https://cloud.google.com/application/web3/faucet/somnia/shannon),
[Stakely](https://stakely.io/faucet/somnia-testnet-stt), [thirdweb](https://thirdweb.com/somnia-shannon-testnet).
A few STT is plenty — these are cheap transactions.

**2. tUSDC collateral — the Bot Kit fetches this for you.** Test collateral is
`0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` (6 decimals) and it exposes a public
`faucet(uint256)`. `ec-core`'s `seedInventory()` calls it automatically whenever
the signer's balance drops below 1,000 tUSDC, on any non-mainnet network. You do
not need to do anything — but it does need gas, which is why STT comes first.
Set `FAUCET_ENABLED=false` to turn that off.

Confirm both with `npm run doctor`. It prints the wallet's native and collateral
balances and fails on either being zero — and on gas being merely *thin*, since
the SDK signs with a fixed gas ceiling rather than estimating, so a balance that
looks non-zero can still be rejected at send time. On **mainnet** there is no
faucet: collateral is real USDso and the bot warns and skips rather than
minting.

---

## What it looks like running

```
cycle 4: 8 live market(s), 10 forecast(s)
  BTC-0-01SEP26-0630/tUSDC book=[0.096/0.118] prior=0.186 post=0.186 news=-0.003(2) net=0.0 -> take_yes
     posterior 0.186 clears ask 0.118 by 0.068
  ETH-0-01SEP26-0700/tUSDC book=[0.065/0.086] prior=0.101 post=0.101 net=0.0 -> quote
     no takeable edge (mid 0.075) — quoting around 0.101
     QUOTE BUY_YES 5 @ 0.071 resting id=...
     QUOTE BUY_NO  5 @ 0.869 resting id=...
  ETH-0-01SEP26-0620/tUSDC: skip — only 41s left (need 120s)
```

And the settlement audit, recomputed independently from the oracle feed:

```
market                    chain  derived         open      close    margin  verdict
ETH 300s @1788270000      down   down          2443.07    2435.90  -29.33bp  match
BTC 300s @1788270000      down   down         77809.31   77595.24  -27.51bp  match
BTC 900s @1788269400      up     up           77783.91   77863.42  +10.22bp  match
ETH 300s @1788269100      down   up            2439.46    2439.58   +0.48bp  inconclusive

  11/12 settlements independently verified
  1 inconclusive — decided by under 1.0bp, finer than an off-chain
  reconstruction can resolve
  receipt: https://dev.oracle.somnia.host/questions/48402?view=graph
```

That last row is the interesting one. The oracle settles on its own sampled
tick; Vaticr recovers the reference from the public feed by timestamp, and on a
window that closed 0.005% from its open those can disagree. Rather than call
that a failed settlement, the audit reports it as **inconclusive** — our
resolution ran out, the chain is not wrong. Over twenty settlements there were
zero genuine mismatches.

---

## Does the model actually work?

The project's claim is that an event contract's probability can be *derived*.
That is testable, so it is tested. Every input is public and historical, so
`npm run backtest` replays settled windows the model never saw.

The run below is **frozen** in [`docs/evidence/backtest-2026-09-04.json`](docs/evidence/backtest-2026-09-04.json),
produced by `npm run backtest -- --limit 300 --json`. Re-running it will not
reproduce these exact figures — it replays a rolling window of recent
settlements, so the sample moves every day. The frozen file is what the numbers
below quote.

```
sample        900 forecasts across 300 settled windows
              (3 decision points each, at 25% / 50% / 75% elapsed)
span          2026-09-03 12:00 -> 2026-09-04 08:55 UTC

Brier         0.16432   (coin flip 0.25)
skill         +0.3427     1 - Brier/0.25
accuracy      0.7489
log loss      0.49156   (coin flip 0.69315)

by time elapsed        n      Brier      skill   accuracy
  25% into window    300    0.20965    +0.1614     0.6667
  50% into window    300    0.17229    +0.3109     0.74
  75% into window    300    0.11103    +0.5559     0.84
```

**Skill rises as the window closes** — +0.1614 a quarter of the way in,
+0.5559 three-quarters in. That is the signature of a model reading the price
process rather than fitting noise: information accumulates and the posterior
sharpens with it.

Three things worth disclosing, because being asked about them is worse than
volunteering them:

- **No lookahead.** Volatility and level at each decision point use only ticks
  at or before that instant. All 900 cases assert it, and 120 are re-run
  against a history physically truncated at the decision, so the assertion is
  not vacuous. A lookahead bug is the classic way a backtest lies.
- **Prior only.** The headline layer is excluded, because a historical scout
  window cannot be reconstructed without leaking the future. This measures the
  price-process prior alone; the news layer's contribution is unproven.
- **The edge is concentrated in the short windows** — where the bot actually
  trades. 300s scores +0.3383 over n=606, while the long windows are thin
  and closer to a coin flip on small samples. The frozen JSON carries the full
  per-window breakdown.

---

## Commands

| Command | What it does |
|---|---|
| `npm run bot:start` | **One command.** Intelligence layer + trading bot. |
| `npm run bot:dry` | Same, with `DRY_RUN=true` forced regardless of `.env`. |
| `npm run doctor` | Preflight: network, module bytecode, venue, markets, API, signer, balances. |
| `npm run dev` | Next.js 14 dashboard on :3000. |
| `npm run api` | Intelligence layer alone (uvicorn on `VATICR_API_PORT`, default 8787). |
| `npm run bot:only` | Trading loop alone — assumes the API is already up. |
| `npm run backstop` | Poke or void any window stuck past settlement. |
| `npm test` | 17 engine property tests + 7 Solidity tests. |
| `npm run typecheck` | `tsc --noEmit` over the app and the bot workspace. |
| `npm run compile` | Hardhat compile. |
| `npm run deploy:registry` | Deploy the forecast registry to Somnia testnet. |

Agents can also be driven directly:

```bash
./.venv/bin/python -m agents.scout       # scan feeds, print scored headlines
./.venv/bin/python -m agents.resolver    # audit settlements, print calibration
```

`agents.resolver` takes `--venue <venueId>`, `--limit <n>`, and `--watch`
with `--interval <sec>` to keep sweeping.

---

## Layout

```
agents/          Python 3.11 — read-only. The brain.
  scout.py         headlines → directional evidence
  lexicon.py       deterministic scorer (no key required)
  llm.py           optional Claude classifier — scores surprise, not keywords
  pricing.py       the Bayesian engine: GBM prior + log-odds evidence
  resolver.py      settlement audit · Brier scoring · backstops
  somnia.py        markets indexer + oracle price feed
  server.py        FastAPI surface the bot polls
  store.py         forecast commitments (.vaticr/forecasts.jsonl)

bot/src/         TypeScript — every on-chain write.
  runner.ts        the trading loop  (npm run bot:start)
  strategy.ts      take-vs-quote, mint-a-pair levels, inventory caps
  backstop.ts      pokeOracle / voidExpired
  doctor.ts        preflight
  registry.ts      on-chain forecast commitments
  signal.ts        typed client for the Python API

contracts/       VaticrForecastRegistry.sol — append-only, no owner
tests/           Python engine property tests
test/            Solidity tests (hardhat)
app/             Next.js 14 landing + dashboard
vendor/ec-core   dreamDEX Bot Kit ec-core, vendored verbatim (MIT) — see SDK feedback
docs/            ARCHITECTURE.md · API.md · SDK_FEEDBACK.md
DEMO.md          runbook for the demo recording
```

---

## Two things worth knowing

**Mint-a-pair is why a small bot can make real markets here.** On a binary book,
`Buy YES × Buy NO` needs no seller — the pool mints a fresh pair for two
opposite-side buyers. So a resting `Buy YES @ p−δ` plus `Buy NO @ (1−p)−δ` is a
complete two-sided quote with **no inventory and no counterparty maker**.
Vaticr never sells, which means the only risk it carries is its net imbalance.

**Settlement resolves against the EMA, not spot.** This is undocumented, and it
matters: over the eight most recent settlements, `mark` reproduced the on-chain
winner 8/8 while `spot` managed 6/8 — disagreeing exactly on the near-the-money
windows that are most worth trading. Vaticr prices the level off `mark` and
measures volatility off `spot`. That finding and five others are written up in
[docs/SDK_FEEDBACK.md](docs/SDK_FEEDBACK.md).

---

## Testing

```bash
npm test
```

- **114 tests** — 75 Python (engine, news scorer, store, resolver, indexer
  clients), 32 TypeScript (the trading decision layer), 7 Solidity (the
  registry). The engine's property tests include Monte-Carlo recovery
  of a known volatility, and a regression for the EMA-smoothing bug that drove
  live priors to 0.0000.
- **7 Solidity tests** on the registry — append-only, no late commitments,
  agents independent, pagination safe past the end.

Run either half alone with `npm run test:agents` or `npm run test:contracts`.

`npm test` covers those two. Four further Python suites are not yet wired into
it and are run directly:

```bash
./.venv/bin/python -m tests.test_lexicon     # 15 — the deterministic scorer
./.venv/bin/python -m tests.test_resolver    # 17 — audit verdicts, Brier, backstops
./.venv/bin/python -m tests.test_somnia      # 15 — the two GraphQL readers
./.venv/bin/python -m tests.test_store       # 11 — commitment durability
```

The bot's decision layer has **32 vitest tests** on top of that, also outside
`npm test`:

```bash
npm run test -w @vaticr/bot   # take-vs-quote, touch pricing, inventory caps
```

---

## Contracts

**`VaticrForecastRegistry` is live on Somnia Shannon testnet:**

[`0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A`](https://shannon-explorer.somnia.network/address/0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A)

### On-chain proof

Vaticr is not a dry-run demo. One command — `npm run go-live -- --send` — put the
whole loop on testnet, and every step is independently verifiable:

| Step | Transaction |
|---|---|
| Registry deployed | [`0x34aacd003fee407156…`](https://shannon-explorer.somnia.network/tx/0x34aacd003fee40715641f770c559cfc8ce57a0c912578087c07199251c3fcf5f) |
| tUSDC minted from the public faucet | [`0x7f977e6137bb8f802a…`](https://shannon-explorer.somnia.network/tx/0x7f977e6137bb8f802a4666301d97704d53622f6f3ff72660771db1ed6f85b132) |
| Forecast committed **before** settlement | [`0xcaf0964062a26a2dd3…`](https://shannon-explorer.somnia.network/tx/0xcaf0964062a26a2dd38ceeb28283e37c8e92504a16fea3a28967e7f47a3119a2) |
| Real order resting on the book | [`0x5a6afb0c19e85bdc40…`](https://shannon-explorer.somnia.network/tx/0x5a6afb0c19e85bdc409152900b88e187cbf423e005b283a4e9e11033e47a67d8) |

Read the commitment back off the chain and it still says what it said at the
time: posterior **73.26%** on
`ETH-0-02SEP26-0330/tUSDC`, stamped **318 seconds before that window expired**.
That is the entire point of the registry — the forecast was public and immutable
while the outcome was still unknown, so the track record cannot be edited after
the fact.

The order was a post-only `BUY_YES 1 @ 0.713` against a book
showing 0.852/0.876, deliberately resting inside the touch rather than crossing.
Collateral escrow confirms it landed: the account holds 9999.287 tUSDC, exactly
10000 minted minus the 0.713 the resting order locked up.

Account activity: [`0xEac2828E82…`](https://shannon-explorer.somnia.network/address/0xEac2828E829F77a1815A023660C160f14486242a)

Vaticr trades the DreamDEX protocol contracts, which it does not own:

| Contract | Address (Somnia testnet, 50312) |
|---|---|
| `BinaryMarketsModule` | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| `MarketsCore` | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| `BinarySettlement` | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| `OutcomeToken6909` | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| `OracleHub` | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| tUSDC (testnet collateral, 6 dp) | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |

These come from `vendor/ec-core/src/addresses.ts`; `npm run doctor` verifies the
module still has bytecode at that address, because a stale deployment map is the
most common way a working bot goes quiet.

---

## Safety

`DRY_RUN=true` is the default and prints every order it would send. Before
trading real funds: run `npm run doctor`, use a hot key holding only what you can
lose, and consider the Bot Kit's
[session keys](https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/docs/session-keys.md)
so the trading key cannot withdraw. Nothing here is financial advice.

## License

Apache-2.0. `vendor/ec-core` is MIT, © DreamDEX S.A. — vendored verbatim with
its license and provenance intact ([NOTICE](vendor/ec-core/NOTICE.md)).
