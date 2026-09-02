# DreamDEX SDK & Bot Kit — Integration Feedback

Written while building [Vaticr](../README.md) against the Somnia Shannon
testnet venue, September 2026, using `@somnia-chain/markets-sdk@0.28.1` and the
[dreamDEX Bot Kit](https://github.com/somnia-chain/dreamdex-bot-kit).

Everything below was hit in practice and verified against live testnet data.
Ordered by how much time it cost.

---

## 1. `@somnia-chain/dreamdex-bot-kit` is not on npm, and `ec-core` cannot be installed

**Impact: blocking.** The natural first move — `npm i @somnia-chain/dreamdex-bot-kit` — returns 404:

```
npm error 404 Not Found - GET https://registry.npmjs.org/@somnia-chain%2fdreamdex-bot-kit
```

The kit is a GitHub monorepo, not a package, and the piece an event-contract bot
actually needs, `@dreamdex-bot-kit/ec-core`, is marked `"private": true` inside
it. npm cannot install a single workspace package out of a monorepo
subdirectory, so there is no supported way to depend on `ec-core` from an
external project.

Vaticr vendors it verbatim under [`vendor/ec-core`](../vendor/ec-core) with the
MIT header and provenance intact. That works, but it means we do not get
upstream fixes, and every team building outside the kit's own repo will
independently reinvent this.

**Suggestion:** publish `@somnia-chain/ec-core` (or `@dreamdex-bot-kit/ec-core`)
to npm. It has three dependencies and no build step; it would be a small
release with a large effect on anyone building outside the monorepo.

---

## 2. The opening price — the single most important number — is not published

**Impact: high.** Every event contract asks one question: *does this window
close at or above its opening price?* That opening price is the strike, and it
is the input every pricing model needs first.

The indexed market row has a `strike` field. On every live testnet market it
reads `"0"`:

```
BTC  int=300   strike=0  qid=48380  tradingStart=1788241500  expiry=1788241800
     q="BTC closes at or above its opening price"
```

`getMarketOnchain()` does not carry it either — `MarketOnchain` has `expiry`,
`status`, `backing`, `winningOutcome`, but no opening price.

So the strike has to be reconstructed off-protocol, by querying the price-feed
indexer for the reference at the market's own `tradingStart`. That works, but it
is inference: it depends on picking the right series (see §3), the right
timestamp, and the right tie-break, and every integrator will re-derive it
slightly differently. Two front-ends can then legitimately disagree about what
the line even is.

*(Interestingly, some series encode it in the symbol — `BTC-7911351-01SEP26-0545`
is an open of 79113.51 — but others read `BTC-0-...`, so it cannot be relied on.)*

**Suggestion:** populate `strike` on the market row, and expose it on
`MarketOnchain`. If it is genuinely not known until the window opens, publishing
it at that moment would still remove all the guesswork.

---

## 3. Settlement resolves against `mark`, not `spot` — and this is undocumented

**Impact: high, and silent.** The price feed publishes two series per asset:
`spot` (the multi-source median) and `mark` (its EMA). The docs describe the
settlement reference only as "a multi-source price reference", which reads like
`spot`.

It is `mark`. Measured over the eight most recently settled BTC/ETH windows,
comparing close-versus-open:

| reference | reproduced the on-chain winner |
|---|---|
| `mark` | **8 / 8** |
| `spot` | 6 / 8 |

The two disagreements were exactly the windows where the two series drifted
apart in direction — i.e. the near-the-money windows, which are precisely the
ones where the probability is most sensitive and most worth trading. A bot
pricing off `spot` is systematically wrong in the region that matters, and
nothing tells it so: the orders fill, the settlements just go the other way.

*On the 8/8:* that is a clean sweep on eight windows, not a claim that an
off-chain reconstruction can adjudicate every settlement. Widened to twenty
settlements, `mark` reproduces the on-chain winner 19/20, and the single
exception is a window that closed 0.005% from its open — where the oracle's own
sampled tick and the tick we recover from the public feed by timestamp differ by
one. Vaticr's audit therefore reports three counts, not two: **verified**,
**mismatched**, and **inconclusive** for a disagreement under 1bp, which is
finer than the reconstruction can resolve. Publishing the settlement series
would collapse that third bucket for everyone.

**Suggestion:** state the settlement series explicitly in
[Settlement & Voids](https://docs.dreamdex.io/trading/event-contracts/settlement-and-voids)
and in the event-contract developer docs.

---

## 4. `fetchPriceCandles` is broken on the testnet price feed

**Impact: medium.** The SDK exposes candles, but on the testnet feed:

```js
await client.fetchPriceCandles("BTC", "1m", { limit: 5 });
// Error: @somnia-chain/markets-sdk: indexer price-feed PriceCandles failed:
//        not a valid graphql query
```

`fetchPriceHistory` works and returns one-second ticks, so this is recoverable —
but candles are the natural primitive for volatility estimation, and the error
surfaces as a generic GraphQL validation failure rather than "unsupported here",
so it reads like caller error.

---

## 5. The oracle feed is an EMA at 1-second resolution — naive volatility is ~4× too low

**Impact: medium; costs money rather than time.** Because `mark` is an EMA
sampled every second, consecutive one-second increments are heavily
autocorrelated. The textbook realised-volatility estimator therefore measures
the smoothing, not the process. Measured on live BTC testnet data over a
50-minute span:

| sampling step | 1s | 5s | 15s | 30s | 60s | 120s |
|---|---|---|---|---|---|---|
| vol from `mark` | 0.079 | 0.155 | 0.234 | 0.278 | 0.264 | 0.266 |
| vol from `spot` | 0.248 | 0.272 | 0.298 | 0.303 | 0.274 | 0.262 |

Ground truth from the actual realised 300-second moves is ≈0.33 annualised.

At one-second sampling on `mark` the estimate is roughly **four times too low**.
Fed into a Gaussian model that drives P(Up) to 0.0000 on windows that are
genuinely close to a coin flip — maximum confidence exactly where there is least
information. This is a quiet way to lose money, and it looks like a working bot.

Vaticr resamples onto a 30-second grid and estimates volatility from `spot`
while taking the *level* from `mark`, since understating volatility makes the
prior overconfident. Details in
[`agents/pricing.py`](../agents/pricing.py).

**Suggestion:** a sentence in the developer docs noting that `mark` is smoothed
and should not be differenced at tick resolution would save every quant team
this measurement.

---

## 6. Several venues run concurrently on one deployment

**Impact: low — handled well already.** Testnet currently shows 16 live binary
markets spread across three venues:

```
0x1a1e6821…  4 markets
0x679795a0…  10 markets   <- the documented DreamDEX venue
0x3e57c57b…  2 markets
```

`activeMarkets()` refuses to guess and throws with a message naming the venues,
which is the right call — silently trading the wrong venue would be much worse.
The Bot Kit's warning that these ids move is accurate and worth keeping
prominent. The documented testnet id was still correct at time of writing.

---

## 7. Smaller things

- **Doc link 404.** `/developers/event-contracts/market-structure-and-lifecycle`
  is linked from the developer overview but 404s; the live page is
  `/developers/event-contracts/market-structure`. (`llms-full.txt` and
  `sitemap.md` are excellent — they made the rest of this integration fast.)
- **Windows shorter than documented.** The trading docs describe 15-minute and
  1-hour windows; testnet is also running 60s and 300s series. The Bot Kit's
  `minLeftSec()` already scales headroom to the cadence, which is exactly right —
  but a fixed 300s guard (the obvious first implementation) rejects every
  five-minute window outright.
- **Reverted writes do not throw.** Well documented in the Bot Kit's gotchas and
  handled by `assertTxOk`, but it is worth repeating in the protocol docs: the
  SDK skips simulation and resolves successfully on a reverted receipt.

---

## What was good

- **`llms-full.txt` and `sitemap.md`.** Nearly this entire integration was built
  from those two files. More projects should ship them.
- **The Bot Kit's `docs/gotchas.md` and the comments inside `ec-core`.** The
  float-price/`InvalidPrice` explanation, the pool-recycle warning, and the
  "winnings are claimed, not received" section each saved hours. The measured
  evidence in those comments ("of fifteen ordinary probabilities only 0.25, 0.5
  and 0.75 survive") is unusually honest and useful documentation.
- **Mint-a-pair.** `Buy YES × Buy NO` minting a fresh pair is an elegant
  cold-start solution, and the fact that it lets a maker quote *both sides with
  zero inventory* is the single best thing about building on this venue. It
  deserves more prominence than one row in a table — it is the reason a small
  bot can provide real liquidity here.
- **Permissionless settlement backstops.** `pokeOracle` / `voidExpired` plus
  pre-reserved resolution gas means funds cannot strand behind an operator.
  Publishing the per-source oracle receipt makes settlement auditable by anyone;
  Vaticr recomputes all of it and surfaces the receipt link in its UI.
