# 🔮 Vaticr — Autonomous DeAI Headline-to-Contract Factory & DreamDEX Bot Kit Fleet

> Built for **Somnia × DreamDEX Event Contracts Hackathon** on DoraHacks ($5,000 Prize Pool)  
> **Target:** 1st Place ($5,000 USDso Prize Pool Target)  
> **Submission Deadline:** September 8, 2026 @ 19:00 UTC  
> **Core Tech Stack:** Somnia Testnet + DreamDEX Event Contracts + `dreamdex-bot-kit` + Solidity + Next.js 14  
> **License:** Apache 2.0 Open Source  

---

## 📌 Overview

**Vaticr** is an **Autonomous DeAI Headline-to-Contract Factory & Market Maker Fleet** built for DreamDEX on Somnia.

- **Headline-to-Contract AI Factory (`agents/scout.py`):** Scans live news APIs and deploys matching DreamDEX Event Contracts on Somnia testnet in under 10 seconds.
- **DreamDEX Bot Kit Market Maker (`bot/runner.ts`):** Leverages `@somnia-chain/dreamdex-bot-kit` to seed liquidity and execute automated multi-leg trades.
- **Bayesian Odds Engine (`agents/pricing.py`):** Dynamically prices binary YES/NO tokens based on real-world probability.
- **Autonomous Resolution Agent (`agents/resolver.py`):** Resolves contracts using verified news payloads without manual admin intervention.

---

## 🚀 Quickstart & Setup Instructions

### 1. Prerequisites
- Node.js 18+ & Hardhat
- Python 3.11+
- Somnia Testnet RPC

### 2. Installation
```bash
git clone https://github.com/mrnetwork/Vaticr.git
cd Vaticr
npm install
pip install -r requirements.txt
```

### 3. Run DreamDEX Bot Kit Runner
```bash
npm run bot:start
```

---

## 📄 License
Apache 2.0 Open Source
