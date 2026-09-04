# 🔮 VATICR — Autonomous Bayesian Forecasting & Market Making on DreamDEX Event Contracts

> **Somnia × DreamDEX Event Contracts Hackathon Blueprint ($5,000 Prize Pool)**  
> **Host:** Somnia Network & DreamDEX (`dorahacks.io/hackathon/event-contracts/detail`)  
> **Target:** 1st Place ($5,000 USDso Prize Pool Target)  
> **Submission Deadline:** September 8, 2026 @ 19:00 UTC  
> **Primary Track:** `Open Track`  
> **Core Tech Stack:** Somnia Testnet + DreamDEX Event Contracts + DreamDEX Bot Kit (`dreamdex-bot-kit`) + Solidity + Next.js 14 + Python 3.11  
> **License:** Apache 2.0 Open Source  
> **Author:** Ifeanyichukwu Onwo (`mrnetwork0001`)  

---

> ### ⚠️ Design revision — what changed and why
>
> This document originally specified a **headline-to-contract factory**: scan the
> news, deploy a matching Event Contract, resolve it later from a signed news
> payload. Three of its premises did not survive contact with the live DreamDEX
> protocol:
>
> 1. **Event Contracts cannot be created from headlines.** They are rolling
>    Up/Down windows on BTC/ETH price, minted per window by
>    `BinaryMarketsModule`. There is no permissionless market-creation entry
>    point, and the question text is fixed.
> 2. **Contracts cannot be resolved from news payloads.** Settlement is
>    oracle-driven and automatic — the question is scheduled on the OracleHub at
>    creation with its resolution gas reserved, and Somnia reactivity fires the
>    callback at expiry. `BinaryMarketsModule` is the only trusted settler.
> 3. **The venue is a CLOB, not an AMM.**
>
> The body below has been rewritten to specify **what shipped**. The full
> reasoning, with the protocol evidence, is in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the integration findings behind it
> are in [docs/SDK_FEEDBACK.md](docs/SDK_FEEDBACK.md).

---

## 📌 Executive Summary & Core Value Proposition

A DreamDEX Event Contract asks exactly one question: *will this window close at
or above the price it opened at?* That makes the fair value of a YES token a
genuine probability — and a probability can be **derived** rather than guessed.
Almost nobody derives it. The books on these windows are priced by people
watching a candle chart, and they misprice hardest near the extremes, where the
arithmetic is least intuitive.

**VATICR** derives that probability, trades it through the official Bot Kit, and
then proves whether it was any good.

1. **Prior from the price process.** Where the window sits relative to its own
   open, given time remaining and measured volatility.
2. **Posterior from the news.** Live headlines scored for directional impact and
   folded in as log-likelihood ratios, decayed by age, source credibility, and
   how much of the window is left.
3. **Traded with zero inventory.** Takes when the posterior clears the *touch*;
   otherwise rests a two-sided **mint-a-pair** quote that needs no inventory and
   no counterparty market maker.
4. **Audited afterwards.** Every settlement is independently recomputed from the
   public oracle feed, and every forecast is committed before its window closes
   and Brier-scored against what actually happened.

The differentiator is (4). A trading bot that cannot be checked is a claim; one
that publishes its forecasts before settlement and scores them afterwards is
evidence.

---

## 🏗️ Technical Architecture & Bot Flow

```
   ┌───────────────────────────────┐   ┌───────────────────────────────┐
   │  PUBLIC NEWS FEEDS            │   │  SOMNIA ORACLE PRICE FEED     │
   │  CoinDesk · Cointelegraph     │   │  BTC/ETH spot + mark, 1s      │
   │  Decrypt · BTC Mag · Fed      │   │  (the settlement reference)   │
   └──────────────┬────────────────┘   └───────────────┬───────────────┘
                  │                                    │
                  ▼                                    ▼
   ┌───────────────────────────────┐   ┌───────────────────────────────┐
   │  1. SCOUT   agents/scout.py   │   │  window geometry from the     │
   │  headline → directional       │   │  markets indexer: open price, │
   │  evidence, per asset          │   │  expiry, cadence, status      │
   └──────────────┬────────────────┘   └───────────────┬───────────────┘
                  └─────────────────┬──────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
                  │  2. BAYESIAN ENGINE                 │
                  │     agents/pricing.py               │
                  │  prior = Φ((ln(S/S₀) − σ²τ/2)/σ√τ)  │
                  │  logit(post) = logit(prior) + Σ LLR │
                  └─────────────────┬───────────────────┘
                                    │  HTTP — docs/API.md
                                    ▼
                  ┌─────────────────────────────────────┐
                  │  3. BOT       bot/src/runner.ts     │
                  │     dreamDEX Bot Kit (ec-core)      │
                  │  edge over the TOUCH → IOC take     │
                  │  otherwise           → mint-a-pair  │
                  │  every cycle         → claim        │
                  └─────────────────┬───────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
                  │  4. RESOLVER  agents/resolver.py    │
                  │     audit · Brier score · backstop  │
                  └─────────────────────────────────────┘
```

**Python is read-only with respect to the chain. TypeScript owns every write.**
Orders, claims, backstops and registry commitments are all TS, because that is
where the Bot Kit and `markets-sdk` own signing, nonces and escrow — and two
senders on one key race each other. The two halves meet at one HTTP boundary,
specified endpoint by endpoint in [docs/API.md](docs/API.md).

---

## 🌟 4 Key Subsystems

### 1. Scout — headlines into evidence (`agents/scout.py`)
Polls public RSS/Atom feeds — keyless by default, so a fresh clone produces real
signal with zero configuration — and scores each item on **direction**,
**salience** and **source credibility**. Two scorers:
[`agents/lexicon.py`](agents/lexicon.py) is deterministic and offline;
[`agents/llm.py`](agents/llm.py) optionally uses Claude to score *surprise*
rather than keywords, and falls back to the lexicon on any failure so the
pipeline never goes dark.

### 2. Bayesian probability engine (`agents/pricing.py`)
A driftless-GBM prior on `P(S_T ≥ S₀)` from the window's own opening price, time
remaining and measured volatility, updated additively in log-odds by the news
evidence. Two measurement details decide whether any of it works: the *level*
comes from `mark` (the series settlement actually compares) while *volatility*
comes from `spot` resampled onto a 30-second grid — differencing the EMA at tick
resolution reads ~4× too low and drives priors to 0.0000. Covered by 17 property
tests including Monte-Carlo recovery of a known σ.

### 3. DreamDEX Bot Kit integration (`bot/src/runner.ts`)
Built on the official Bot Kit, vendored verbatim at
[`vendor/ec-core`](vendor/ec-core) (MIT, never edited — it is not installable
from npm; see SDK_FEEDBACK §1), plus `@somnia-chain/markets-sdk`. Takes only
when the posterior clears the **touch**, never the mid; otherwise rests a
`Buy YES @ p−δ` + `Buy NO @ (1−p)−δ` **mint-a-pair** quote, which is a complete
two-sided market with no inventory because two opposite-side buyers mint a fresh
pair. Gates every write on the authoritative on-chain status, and claims
winnings inside the loop so nothing races its own nonce.

### 4. Resolution, audit and backstops (`agents/resolver.py`)
Three jobs the protocol leaves open to anyone. **Audit:** recompute every
settlement from the public oracle feed and compare it to the on-chain winner,
reporting *verified / mismatched / inconclusive* — where "inconclusive" is a
disagreement under 1bp, which is finer than an off-chain reconstruction can
resolve. **Score:** Brier-score every pre-committed forecast against a 0.25
coin-flip baseline. **Backstop:** find windows the oracle has not answered and
name the permissionless `pokeOracle` / `voidExpired` call;
[`bot/src/backstop.ts`](bot/src/backstop.ts) holds the signer and makes it.

### Supporting: on-chain forecast commitments (`contracts/VaticrForecastRegistry.sol`)
An append-only log of forecasts published *before* settlement, with no owner, no
upgrade path, and no revisions. An off-chain file proves nothing — whoever holds
it can rewrite it. 7 Solidity tests.

---

## 📋 Required Submission Package Checklist

- [x] GitHub repository (`mrnetwork0001/Vaticr`), Apache 2.0 — **currently private; must be made public before submission.**
- [x] Integration with official DreamDEX Bot Kit (`vendor/ec-core` + `markets-sdk`).
- [x] DreamDEX SDK Feedback Report — [docs/SDK_FEEDBACK.md](docs/SDK_FEEDBACK.md).
- [x] Deployed smart contracts on Somnia Testnet — `VaticrForecastRegistry` is live at [`0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A`](https://shannon-explorer.somnia.network/address/0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A), with a forecast committed on-chain 318s before its window closed and a real order placed. Addresses and transaction hashes in `deployments/`.
- [ ] 2–3 minute demo video URL — **not yet recorded.** Runbook: [DEMO.md](DEMO.md).

---

## 📄 License
Apache 2.0 Open Source. `vendor/ec-core` is MIT, © DreamDEX S.A., vendored
verbatim with its license and provenance intact.
