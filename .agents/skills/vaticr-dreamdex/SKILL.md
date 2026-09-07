---
name: vaticr-dreamdex
description: Architecture, protocol constraints, and integration rules for Vaticr - the DeAI forecasting and market-making stack on DreamDEX Event Contracts (Somnia), built for the Somnia x DreamDEX Hackathon.
---

# 🔮 Vaticr - DreamDEX Event Contracts Skill

Use this when working on **Vaticr**. Read
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) and
[docs/SDK_FEEDBACK.md](../../../docs/SDK_FEEDBACK.md) before changing anything
in `agents/` or `bot/`. The HTTP seam between the two halves is specified
endpoint by endpoint in [docs/API.md](../../../docs/API.md) - change a route
there and here in the same commit.

## Protocol facts that constrain every design decision

These are properties of DreamDEX, verified against the live testnet. Do not
design around wishes here.

1. **Event Contracts cannot be created from headlines.** They are rolling
   Up/Down windows on BTC/ETH price, minted per window by
   `BinaryMarketsModule`. No permissionless market creation; the question is
   always *"<ASSET> closes at or above its opening price"*; no preset strikes.
2. **They cannot be resolved by us.** Settlement is oracle-driven and automatic
   - scheduled on the OracleHub at creation with resolution gas reserved,
   delivered by Somnia reactivity at expiry. `BinaryMarketsModule` is the only
   trusted settler. The only permissionless calls are `pokeOracle(questionId)`
   and `voidExpired(marketId)`.
3. **It is a CLOB, not an AMM.** One book quoted in YES terms; `no = 1 - yes`.
4. **Settlement compares `mark` (the EMA), not `spot`.** Undocumented;
   determined empirically (8/8 vs 6/8). Price the *level* off `mark`.
5. **Volatility must not be estimated from `mark` at tick resolution.** It is an
   EMA; naive 1s differencing reads ~4x too low and drives priors to 0.0000.
   Estimate from `spot`, resampled onto a >=30s grid.
6. **`strike` reads `"0"` on market rows.** The opening price must be recovered
   from the price feed at the window's `tradingStart`.

## Architecture rules

- **Python is read-only. TypeScript owns every write.** Orders, claims,
  backstops and registry commitments are all TS, because the Bot Kit and
  `markets-sdk` own signing and nonces - and two senders on one key race.
- **`vendor/ec-core` is vendored verbatim from the official Bot Kit (MIT).**
  Never edit it. Vaticr code lives in `bot/` and imports
  `@dreamdex-bot-kit/ec-core` exactly as an in-repo strategy would.
- **Gate writes on the on-chain status, never the indexer** (it lags seconds).
  Only `Trading` (status 1) accepts orders.
- **Take only when the posterior clears the touch, never the mid.** Paying the
  spread is how a bot with real edge still loses.
- **Quote via mint-a-pair.** Resting `Buy YES @ p-d` + `Buy NO @ (1-p)-d` is a
  complete two-sided quote with zero inventory. Vaticr never sells, so its only
  risk is net imbalance.
- **Claim inside the trading loop.** Winnings are claimed, not received; a
  background timer would race the strategy's nonce.
- **`DRY_RUN=true` is the default** and must stay the default.

## Subsystems

| Path | Role |
|---|---|
| `agents/scout.py` + `lexicon.py` + `llm.py` | headlines → directional evidence |
| `agents/pricing.py` | GBM prior + log-odds evidence → posterior |
| `agents/resolver.py` | settlement audit · Brier scoring · backstops |
| `agents/somnia.py` | markets indexer + oracle price feed (read-only) |
| `agents/server.py` | FastAPI surface the bot polls |
| `bot/src/runner.ts` | the trading loop (`npm run bot:start`) |
| `bot/src/strategy.ts` | take-vs-quote, mint-a-pair levels, inventory caps |
| `contracts/VaticrForecastRegistry.sol` | append-only pre-settlement commitments |

## Verification

`npm test` runs 17 engine property tests and 7 Solidity tests.
`npm run doctor` checks venue scope, live markets, the API and the signer.
Both must pass before claiming anything works.

## Submission checklist

Mirrors `VATICR_PROJECT_SPEC.md` - keep the two in step; a checklist that
disagrees with itself is worse than no checklist.

- [x] Repo `mrnetwork0001/Vaticr`, Apache-2.0 (`vendor/ec-core` MIT, attributed)
      - still **private**; make it public before submitting.
- [x] Official DreamDEX Bot Kit integration (`vendor/ec-core` + `markets-sdk`).
- [x] SDK feedback report - `docs/SDK_FEEDBACK.md`.
- [ ] Deployed contract on Somnia testnet. `VaticrForecastRegistry.sol` is
      DEPLOYED at 0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A on Somnia testnet.
      Addresses and tx hashes are in deployments/50312.json and
      deployments/onchain-proof.json. Redeploy with `npm run deploy:registry`.
- [ ] 2–3 minute demo video - **not recorded**. Runbook: `DEMO.md`.
