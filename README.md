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
git clone https://github.com/mrnetwork/Vaticr.git && cd Vaticr

npm install                       # workspace: bot + vendored Bot Kit ec-core
pip install -r requirements.txt   # FastAPI intelligence layer

cp .env.example .env              # works as-is; DRY_RUN=true by default

npm run bot:start                 # one command: starts the brain, then the bot
```

That is the whole setup. `bot:start` brings up the Python intelligence layer,
waits for the first news scan, then runs the trading loop — **in dry run**,
logging every order it would place and sending nothing.

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

<sub>If port 8787 is taken: `VATICR_API_PORT=8799 npm run bot:start`.</sub>

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
  1 inconclusive — decided by under 1bp, finer than an off-chain
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

## Commands

| Command | What it does |
|---|---|
| `npm run bot:start` | **One command.** Intelligence layer + trading bot. |
| `npm run doctor` | Preflight: venue, markets, API, signer, balances. |
| `npm run dev` | Next.js 14 dashboard on :3000. |
| `npm run api` | Intelligence layer alone (FastAPI). |
| `npm run bot:only` | Trading loop alone. |
| `npm run backstop` | Poke or void any window stuck past settlement. |
| `npm test` | Engine property tests + Solidity tests. |
| `npm run deploy:registry` | Deploy the forecast registry to Somnia testnet. |

Agents can also be driven directly:

```bash
python -m agents.scout       # scan feeds, print scored headlines
python -m agents.resolver    # audit settlements, print calibration
```

---

## Layout

```
agents/        Python 3.11 — read-only. The brain.
  scout.py       headlines → directional evidence
  lexicon.py     deterministic scorer (no key required)
  llm.py         optional Claude classifier — scores surprise, not keywords
  pricing.py     the Bayesian engine: GBM prior + log-odds evidence
  resolver.py    settlement audit · Brier scoring · backstops
  somnia.py      markets indexer + oracle price feed
  server.py      FastAPI surface the bot polls

bot/           TypeScript — every on-chain write.
  runner.ts      the trading loop  (npm run bot:start)
  strategy.ts    take-vs-quote, mint-a-pair levels, inventory caps
  backstop.ts    pokeOracle / voidExpired
  doctor.ts      preflight
  registry.ts    on-chain forecast commitments

contracts/     VaticrForecastRegistry.sol — append-only, no owner
app/           Next.js 14 dashboard
vendor/ec-core dreamDEX Bot Kit ec-core, vendored verbatim (MIT) — see SDK feedback
docs/          ARCHITECTURE.md · SDK_FEEDBACK.md
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

- **17 property tests** on the Bayesian engine — including Monte-Carlo recovery
  of a known volatility, and a regression for the EMA-smoothing bug that drove
  live priors to 0.0000.
- **7 Solidity tests** on the registry — append-only, no late commitments,
  agents independent, pagination safe past the end.

---

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `VaticrForecastRegistry` | Somnia testnet (50312) | *deploy with `npm run deploy:registry`; address is written to `deployments/50312.json`* |

Vaticr trades the DreamDEX protocol contracts, which it does not own:

| Contract | Address |
|---|---|
| `BinaryMarketsModule` | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| `MarketsCore` | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| `BinarySettlement` | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| `OutcomeToken6909` | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| `OracleHub` | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| tUSDC (testnet collateral, 6 dp) | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |

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
