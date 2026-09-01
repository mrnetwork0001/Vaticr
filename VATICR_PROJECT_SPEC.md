# 🔮 VATICR — Autonomous DeAI Headline-to-Contract Factory & DreamDEX Bot Kit Fleet

> **Somnia × DreamDEX Event Contracts Hackathon Blueprint ($5,000 Prize Pool)**  
> **Host:** Somnia Network & DreamDEX (`dorahacks.io/hackathon/event-contracts/detail`)  
> **Target:** 1st Place ($5,000 USDso Prize Pool Target)  
> **Submission Deadline:** September 8, 2026 @ 19:00 UTC  
> **Primary Track:** `Open Track`  
> **Core Tech Stack:** Somnia Testnet + DreamDEX Event Contracts + DreamDEX Bot Kit (`dreamdex-bot-kit`) + Solidity + Next.js 14 + Python 3.11  
> **License:** Apache 2.0 Open Source  
> **Author:** Ifeanyichukwu Onwo (`mrnetwork`)  

---

> ### ⚠️ Design revision — read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first
>
> Three premises in the original blueprint below turned out not to hold against
> the live DreamDEX protocol, and the implementation diverges from them:
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
> What shipped instead: the AI converts headlines into a *Bayesian posterior* on
> the windows the protocol already runs, the Bot Kit trades that view via
> **mint-a-pair** two-sided quoting with zero inventory, and the resolution agent
> audits settlements, Brier-scores every forecast, and drives the permissionless
> `pokeOracle` / `voidExpired` backstops.
>
> The subsystem numbering below still maps 1:1 to `agents/scout.py`,
> `agents/pricing.py`, `bot/runner.ts` and `agents/resolver.py`.

---

## 📌 Executive Summary & Core Value Proposition

Prediction markets today suffer from manual market creation, illiquid order books, and slow oracle resolutions. Most hackathon entries build static DApp UIs or hyper-niche math formulas that fail to generate trading volume or active liquidity.

**VATICR** is an **Autonomous DeAI Headline-to-Contract Factory & Market Maker Fleet** built natively for DreamDEX on Somnia.

Vaticr scans real-time news APIs (Crypto, Fed Rates, Tech), **automatically deploys live DreamDEX Event Contracts in 10 seconds**, and embeds the official **DreamDEX Bot Kit** (`dreamdex-bot-kit`) to seed initial liquidity, compute Bayesian odds, and execute active multi-leg trades on Somnia testnet.

---

## 🏗️ Technical Architecture & Bot Flow

```
   ┌────────────────────────────────────────────────────────┐
   │               WEB3 NEWS & REAL-TIME EVENT STREAM       │
   │    (Crypto Upgrades, Macro Rates, Sports & Tech News)  │
   └───────────────────────────┬────────────────────────────┘
                               │
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │     AGENT 1: HEADLINE-TO-CONTRACT AI FACTORY           │
   │   (Deploys fresh DreamDEX Event Contracts on Somnia)   │
   └───────────────────────────┬────────────────────────────┘
                               │
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │     AGENT 2: BAYESIAN PROBABILITY & PRICING ENGINE     │
   │   (Calculates real-time YES/NO odds & dynamic pricing) │
   └───────────────────────────┬────────────────────────────┘
                               │
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │     AGENT 3: DREAMDEX BOT KIT ARBITRAGE & AMM FLEET    │
   │   (Uses dreamdex-bot-kit to seed liquidity & trade)    │
   └───────────────────────────┬────────────────────────────┘
```

---

## 🌟 4 Key Subsystems

### 1. Headline-to-Contract AI Factory (`agents/scout.py`)
- Scans live financial and Web3 news feeds, parses event rules, and deploys new binary event contracts on Somnia via DreamDEX factory contracts.

### 2. Bayesian Probability Engine (`agents/pricing.py`)
- Calculates real-time implied probability and prices binary YES/NO tokens dynamically.

### 3. DreamDEX Bot Kit Integration (`bot/runner.ts`)
- Leverages `@somnia-chain/dreamdex-bot-kit` to deploy automated market-maker (AMM) bots that seed liquidity and trade mispriced contracts.

### 4. Autonomous Verifiable News Settlement (`agents/resolver.py`)
- Fetches cryptographically signed news API payloads, verifies outcome verdicts, and resolves DreamDEX contracts on Somnia.

---

## 📋 Required Submission Package Checklist

- [x] Public GitHub repository (`mrnetwork/Vaticr`).
- [x] Deployed Smart Contracts on Somnia Testnet.
- [x] Integration with official DreamDEX Bot Kit (`dreamdex-bot-kit`).
- [x] 2–3 Minute Demo Video URL.
- [x] DreamDEX SDK Feedback Report.

---

## 📄 License
Apache 2.0 Open Source
