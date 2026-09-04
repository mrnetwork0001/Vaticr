# Vaticr — Architecture

## The constraint that shaped this project

Vaticr began as a "headline-to-contract factory": scan the news, deploy a
matching DreamDEX Event Contract, resolve it later from a signed news payload.

That design is not buildable on DreamDEX, for three reasons that are worth
stating plainly because they are properties of the protocol, not gaps in it:

1. **Event Contracts cannot be created from headlines.** They are rolling
   Up/Down windows on BTC and ETH price, minted per window by
   `BinaryMarketsModule` on a schedule. There is no permissionless "create a
   market from this question" entry point, and the question text is fixed:
   *"<ASSET> closes at or above its opening price"*. There are no preset
   strikes — each window resolves against wherever it opened.

2. **Contracts cannot be resolved from news.** Resolution is oracle-driven and
   automatic. Each market's settlement question is scheduled on the OracleHub at
   creation *with the gas for its own resolution reserved up front*, and
   Somnia's on-chain reactivity delivers the answer straight to the hub's
   callback at expiry. `BinaryMarketsModule` is the only address a market trusts
   as its settler. As the docs put it: **"Nobody has to — the chain does."**

3. **It is a CLOB, not an AMM.** One on-chain order book per market, quoted in
   YES terms, where a NO price is always `1 − yes`.

So Vaticr does not deploy markets and does not resolve them. It does the thing
that is genuinely unowned: **decide what these windows are actually worth, trade
that view, and make the resulting track record auditable.**

The pivot cost nothing in ambition. It swapped a subsystem the protocol forbids
for one it rewards.

---

## The four subsystems

```
        ┌──────────────────────────────────────────────────────────┐
        │  PUBLIC NEWS FEEDS          SOMNIA ORACLE PRICE FEED     │
        │  CoinDesk · Cointelegraph   BTC/ETH spot + mark, 1s      │
        │  Decrypt · Fed press        (the settlement reference)   │
        └───────────────┬──────────────────────┬───────────────────┘
                        │                      │
      ┌─────────────────▼──────────┐  ┌────────▼─────────────────────┐
      │ 1. SCOUT   agents/scout.py │  │ window geometry from the     │
      │   headline → directional   │  │ markets indexer:             │
      │   evidence, per asset      │  │ open price, expiry, status   │
      └─────────────────┬──────────┘  └────────┬─────────────────────┘
                        │                      │
                        └──────────┬───────────┘
                                   ▼
                 ┌─────────────────────────────────────┐
                 │ 2. BAYESIAN ENGINE                  │
                 │    agents/pricing.py                │
                 │                                     │
                 │  prior  = Φ( ln(S/S₀) − σ²τ/2       │
                 │              ───────────────  )     │
                 │                  σ√τ                │
                 │  logit(post) = logit(prior) + Σ LLR │
                 └─────────────────┬───────────────────┘
                                   │  HTTP (FastAPI)
                                   ▼
                 ┌─────────────────────────────────────┐
                 │ 3. BOT       bot/src/runner.ts      │
                 │    dreamDEX Bot Kit + markets-sdk   │
                 │                                     │
                 │  edge over the TOUCH  → IOC take    │
                 │  otherwise            → mint-a-pair │
                 │                          two-sided  │
                 │  each loop            → claim       │
                 └─────────────────┬───────────────────┘
                                   ▼
                 ┌─────────────────────────────────────┐
                 │ 4. RESOLVER  agents/resolver.py     │
                 │    audit · Brier score · backstop   │
                 └─────────────────────────────────────┘
```

---

## 1. Scout — headlines into evidence

[`agents/scout.py`](../agents/scout.py) polls public RSS/Atom feeds (keyless by
default, so a fresh clone produces real signal with zero configuration) and
scores each item on three axes: **direction** (−1…+1), **salience** (how
market-moving at all), and **source credibility**.

Scoring has two implementations:

- [`agents/lexicon.py`](../agents/lexicon.py) — deterministic, offline, no
  credentials. Phrase tables plus regex patterns for the productive
  constructions a keyword list misses: `"Strategy buys $370M Bitcoin"` and
  `"moves 4,800 BTC to Coinbase"` (an exchange inflow, therefore bearish) both
  score correctly, and negation flips polarity.
- [`agents/llm.py`](../agents/llm.py) — optional. With an `ANTHROPIC_API_KEY`,
  Claude re-scores each batch for *surprise* rather than keywords: a
  long-expected approval that finally lands is mostly priced in. Any failure
  falls back to the lexicon; the pipeline never goes dark.

**An honest finding:** genuinely fresh, market-moving crypto headlines are
*rare* — typically two or three at a time across five major feeds. This is why
the prior carries most of the weight and news is a tilt on top of it. A design
that needed a headline per trade would idle almost always.

## 2. Bayesian engine — what a window is worth

[`agents/pricing.py`](../agents/pricing.py).

**Prior.** Over seconds to an hour, a driftless GBM is a defensible model of
BTC/ETH. With `S` the current level, `S₀` the window's opening price, `τ` the
seconds remaining and `σ` per-second volatility:

```
P(S_T ≥ S₀) = Φ( (ln(S/S₀) − σ²τ/2) / (σ√τ) )
```

This is already an edge on its own: it is the honest read of where a window sits
relative to its own open, and it is what a book full of people watching a candle
chart tends to misprice near the extremes.

**Posterior.** Bayes is additive in log-odds:

```
logit(posterior) = logit(prior) + Σᵢ LLRᵢ
```

Each headline's contribution is discounted three ways — by source credibility,
by exponential time decay (news gets priced in; 30-minute half-life), and by how
much of the window remains, since a headline cannot move a contract expiring in
four seconds. The total is hard-capped so a burst of correlated stories cannot
run the posterior into a corner.

**Two measurement details that decide whether any of this works:**

- The *level* comes from `mark`, because that is the series settlement compares.
  The *volatility* comes from `spot`, because `mark` is an EMA and differencing
  it understates volatility — which makes the prior overconfident, the direction
  that loses money.
- The series is resampled onto a 30-second grid before differencing. At
  one-second resolution the estimator measures EMA autocorrelation, not
  volatility, and reads ~4× too low. See
  [SDK_FEEDBACK §5](./SDK_FEEDBACK.md#5-the-oracle-feed-is-an-ema-at-1-second-resolution--naive-volatility-is-4-too-low).

Seventeen property tests cover the engine specifically (114 across the repo),
including Monte-Carlo recovery of a known
σ and a regression for the EMA bug: [`tests/test_pricing.py`](../tests/test_pricing.py).

## 3. Bot — trading the view

[`bot/src/runner.ts`](../bot/src/runner.ts), built on the official
[dreamDEX Bot Kit](https://github.com/somnia-chain/dreamdex-bot-kit)
(`ec-core`, vendored — see [SDK_FEEDBACK §1](./SDK_FEEDBACK.md)) and
`@somnia-chain/markets-sdk`.

The strategy is built around **mint-a-pair**. Of the four crossing paths on a
binary book, `Buy YES × Buy NO` is the interesting one: two opposite-side
*buyers* need no seller — the pool mints a fresh pair and hands one leg to each.
Two consequences:

- A resting `Buy YES @ p−δ` plus `Buy NO @ (1−p)−δ` is a complete two-sided
  quote requiring **no inventory and no counterparty market maker**. A
  conventional maker must hold what it sells; this one never sells.
- Because Vaticr only ever buys, its position is complete sets plus an
  imbalance. A complete set is worth exactly 1 collateral at settlement whatever
  the outcome, so the only risk carried is the **imbalance** — which is what
  `VATICR_MAX_NET_INVENTORY` caps.

Taking is gated on clearing the **touch**, never the mid. Paying the spread is
the most common way a signal bot with genuine edge still loses money.

Each cycle also gates on the authoritative on-chain status (the indexer lags by
seconds; only `Trading` accepts orders), scales its expiry headroom to the
window's cadence, and sweeps settled markets — **winnings are claimed, not
received**, and claiming runs inside the trading loop so it cannot race its own
nonce.

## 4. Resolver — audit, score, backstop

[`agents/resolver.py`](../agents/resolver.py). Three jobs the protocol leaves
open:

- **Audit.** Recompute every settlement independently from the public oracle
  feed and compare to the on-chain winner, surfacing the per-source receipt URL.

  One honest limit: the oracle settles on its own sampled tick, and we recover
  the reference from the public feed by timestamp. Those can differ by a tick,
  which is irrelevant on a normal window and decisive on one that closed a
  fraction of a basis point from its open. Measured over twenty settlements,
  both "nearest tick" and "last tick at or before the boundary" reproduce the
  on-chain winner 19/20, failing on the *same* window — one that moved 0.005%.

  So a disagreement under 1bp is reported as **inconclusive** rather than a
  mismatch: at that margin our reconstruction has run out of resolution, and
  claiming the chain is wrong would be the dishonest reading. Anything above
  that threshold is a real mismatch and is reported as one.
- **Score.** Every forecast is committed *before* its window closes, then
  Brier-scored once the oracle speaks. A model that cannot beat 0.25 is a coin
  flip with extra steps, and this is the only way to know.
- **Backstop.** Watch for windows the oracle has not answered inside the
  settlement window, and name the permissionless escape hatch —
  `pokeOracle(questionId)` or, once the window lapses, `voidExpired()`.
  Execution is [`bot/src/backstop.ts`](../bot/src/backstop.ts), which holds the
  signer.

## On-chain commitments

[`contracts/VaticrForecastRegistry.sol`](../contracts/VaticrForecastRegistry.sol)
is an append-only log of forecasts published *before* settlement. A prediction
is only evidence of skill if it was public before the outcome was known, and an
off-chain file proves nothing — whoever holds it can rewrite it.

The contract has no owner, no upgrade path, and refuses both late commitments
and revisions. That is the whole security model: an agent that could edit its
own history would prove nothing by having one.

---

## Why Python and TypeScript

The split is not incidental. Every **write** — orders, claims, backstops,
registry commitments — is TypeScript, because that is where the Bot Kit and
`markets-sdk` own signing, nonces and escrow, and because the kit is explicit
that two senders on one key race each other. Python is **read-only**: it queries
the two public GraphQL endpoints and does the modelling, which keeps the
forecasting logic testable in isolation behind one HTTP boundary — specified
route by route, with response shapes and worked examples, in
[API.md](./API.md).
