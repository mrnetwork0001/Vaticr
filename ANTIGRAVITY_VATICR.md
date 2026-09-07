# 🔮 ANTIGRAVITY_VATICR - Project Context Directive

> **Project:** VATICR - autonomous Bayesian forecasting and market making on
> DreamDEX Event Contracts (Somnia testnet)  
> **Event:** Somnia × DreamDEX Event Contracts Hackathon (DoraHacks)  
> **Deadline:** September 8, 2026 @ 19:00 UTC · **Track:** Open  
> **Repo:** <https://github.com/mrnetwork0001/Vaticr> · Apache-2.0  

This file exists so an agent dropped into the repo with no context knows where
to look. It carries no architecture of its own - every claim below would be a
second copy to drift out of date. **Read these instead:**

| Read | For |
|---|---|
| [README.md](README.md) | what it does, quickstart, commands, funding a testnet run |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the four subsystems and why the design is what it is |
| [docs/API.md](docs/API.md) | the Python ↔ TypeScript HTTP boundary, route by route |
| [docs/SDK_FEEDBACK.md](docs/SDK_FEEDBACK.md) | what the live protocol actually does, measured |
| [VATICR_PROJECT_SPEC.md](VATICR_PROJECT_SPEC.md) | the blueprint and the submission checklist |
| [.agents/skills/vaticr-dreamdex/SKILL.md](.agents/skills/vaticr-dreamdex/SKILL.md) | the rules that constrain any change |
| [DEMO.md](DEMO.md) | the runbook for the demo recording |

## The three rules that are easiest to break

1. **Vaticr does not create or resolve markets.** Event Contracts are
   protocol-minted rolling Up/Down windows on BTC/ETH; settlement is automatic
   via the OracleHub. Anything that reads like a "headline-to-contract factory"
   is describing a design that was abandoned because the protocol forbids it.
2. **Python is read-only; TypeScript owns every on-chain write.** Orders,
   claims, backstops and registry commitments are all in `bot/src/`.
3. **`vendor/ec-core` is the official Bot Kit, vendored verbatim under MIT.**
   Never edit it. Vaticr code lives in `bot/` and imports it as any in-repo
   DreamDEX strategy would.

## Submission requirements

Tracked in one place - the checklist at the bottom of
[VATICR_PROJECT_SPEC.md](VATICR_PROJECT_SPEC.md), mirrored in `SKILL.md`. Two
items are still open: the repo is private, and the demo video is not recorded.
