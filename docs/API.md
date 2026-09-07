# Vaticr - the Python ↔ TypeScript HTTP boundary

Every write in Vaticr is TypeScript; every model is Python. The two halves meet
at exactly one place: this FastAPI service, defined in
[`agents/server.py`](../agents/server.py) and consumed by
[`bot/src/signal.ts`](../bot/src/signal.ts) and the Next.js dashboard's proxy
route `app/api/vaticr/[...path]/route.ts`.

**Everything here is read-only with respect to the chain.** `POST /scan` and
`POST /commit` write to local process state and a JSON Lines file
(`.vaticr/forecasts.jsonl`) respectively - neither touches a wallet. That is the
whole point of the split: a compromised or wrong brain can produce a bad number,
never a bad transaction.

```
base url   http://127.0.0.1:8787          # VATICR_API_HOST / VATICR_API_PORT
start      npm run api                    # uvicorn agents.server:app
schema     http://127.0.0.1:8787/docs     # FastAPI's own OpenAPI UI
```

CORS is open (`allow_origins=["*"]`, methods `GET` and `POST`) because the data
is public and the UI is served from a different origin.

The wire types are pydantic models in [`agents/schemas.py`](../agents/schemas.py)
- that file, not this page, is the normative contract. This page is the map.

---

## Conventions

| | |
|---|---|
| Timestamps | Unix **seconds**, integer. |
| Probabilities | floats in `[0, 1]`; the posterior is clamped to `[0.02, 0.98]`. |
| `venue` | a DreamDEX venueId (`0x…`, 32 bytes). Omit and the reader falls back to `VENUE_ID` / inference. Several venues run side by side on one deployment, so passing it explicitly is the safe habit. |
| `asset` | `BTC` or `ETH`, case-insensitive on input, upper-case on output. |
| Errors | FastAPI's `{"detail": "..."}`. `502` when the indexer is unreachable, `404` from `/intent` when the market has no live forecast, `422` on parameter validation. |

---

## `GET /health`

Liveness plus the four facts that explain every other response: which network,
which two GraphQL endpoints, how much news is in the rolling window, and whether
the LLM classifier is actually on.

No parameters.

```json
{
  "ok": true,
  "network": "testnet",
  "indexer": "https://dev.smk.somnia.host/v1/graphql",
  "price_feed": "https://price-feed.dev.oracle.somnia.host/v1/graphql",
  "headlines_in_window": 29,
  "last_scan": 1788315761,
  "llm_classifier": "off (lexicon only)",
  "feeds": 5
}
```

`llm_classifier` is `"on"` only when `ANTHROPIC_API_KEY` is set **and**
`VATICR_LLM_ENABLED` is true; otherwise `"off (lexicon only)"`, which is a
fully working configuration, not a degraded one. `last_scan` is `null` until the
scout's first pass lands - `scripts/start.mjs` polls this endpoint and holds the
bot back until it does.

---

## `GET /headlines`

The rolling window of scored news. This is the evidence side of the posterior,
exposed on its own so the dashboard can show *why* a number moved.

| param | type | default | notes |
|---|---|---|---|
| `asset` | string | - | filter to headlines bearing on one asset |
| `limit` | int | `40` | max `200` |

Returns a JSON array of `Headline` (newest first):

```json
[
  {
    "id": "2ed50b1525ae3599",
    "source": "bitcoinmagazine.com",
    "title": "Bitcoin Slides as US-Iran Tensions Escalate",
    "url": "https://bitcoinmagazine.com/markets/bitcoin-slides-as-iran-us-war-escalates",
    "published_at": 1788298022,
    "assets": ["BTC"],
    "sentiment": 0.0,
    "salience": 0.15,
    "credibility": 0.65,
    "scorer": "lexicon",
    "rationale": "no directional terms"
  }
]
```

`sentiment` is direction in `[-1, +1]`, `salience` is how market-moving at all in
`[0, 1]`, `credibility` is the source weight in `[0, 1]`. `scorer` is `"lexicon"`
or `"llm"`. All three multiply into the log-likelihood ratio the engine applies -
a headline can be strongly directional and still barely move the posterior if it
is stale or from a weak source.

---

## `POST /scan`

Force an immediate feed poll instead of waiting for the scout's timer
(`VATICR_SCOUT_POLL_SEC`, default 45s). Used by the demo runbook so a recording
does not open on an empty window.

No body, no parameters.

```json
{ "added": 3, "in_window": 29 }
```

`added` counts genuinely new items - the scout deduplicates by URL hash, so
re-scanning a quiet minute legitimately returns `0`.

---

## `GET /forecasts`

**The endpoint the bot polls each cycle.** A Bayesian posterior for every live
event-contract window in scope, with the window geometry the bot needs to decide
whether it is even worth quoting.

| param | type | default | notes |
|---|---|---|---|
| `venue` | string | - | venueId to scope to |
| `asset` | string | - | `BTC` / `ETH` |
| `limit` | int | `12` | max `50` |

Returns an array of envelopes: the `Forecast` plus the on-chain window facts.

One live envelope, captured verbatim from the testnet venue:

```json
[
  {
    "forecast": {
      "asset": "ETH",
      "market_id": "0x0000000000000000000000000000000000000000000000000000000000010bdb",
      "symbol": "ETH 60s @1788316320",
      "open_price": 2406.1759244480654,
      "spot": 2407.6467051798627,
      "seconds_left": 0.0,
      "window_sec": 60.0,
      "annual_vol": 0.4723,
      "vol_source": "realized",
      "prior": 1.0,
      "posterior": 0.98,
      "evidence_log_odds": 0.0,
      "evidence": [],
      "computed_at": 1788316320,
      "degraded": false,
      "note": ""
    },
    "expiry": 1788316320,
    "trading_start": 1788316260,
    "interval_sec": 60,
    "status": "Trading",
    "oracle_question_id": "36351514722149437037801569473899203756566696790557931124865988629670460710361",
    "receipt_url": "https://dev.oracle.somnia.host/questions/36351514722149437037801569473899203756566696790557931124865988629670460710361?view=graph"
  }
]
```

That row also shows the posterior clamp doing its job: with the window at its
last second and the level above its open, the raw prior is `1.0`, and the
posterior is capped at `VATICR_PROB_CEIL` (0.98) because certainty is never a
tradable claim.

`evidence` is empty whenever no headline in the window bears on that asset - the
common case, and the honest one. When populated, each item is an `EvidenceItem`:

| field | meaning |
|---|---|
| `headline_id` | matches an `id` from `/headlines` |
| `title`, `source` | the headline, for display |
| `age_sec` | seconds since publication |
| `log_likelihood_ratio` | signed contribution to the posterior log-odds |
| `decay` | the time-decay multiplier already applied, in `[0, 1]` |

`evidence_log_odds` is the sum of those contributions after the cap
(`VATICR_EVIDENCE_CAP`), so it is not always the plain total of the list.

`oracle_question_id` is passed through verbatim from the indexer's
`oracleQuestionId`. It is a decimal string, and its width is not stable - short
ids (`48380`) and full 77-digit uint256s both occur on live testnet rows. Treat
it as an opaque identifier, never as a number, and build receipt links by
concatenation rather than by parsing it.

Notes that matter for anyone reading these numbers:

- `spot` is the **`mark`** series (the EMA), not the raw spot - because `mark` is
  what settlement compares. `annual_vol` is measured from the raw `spot` series
  resampled onto a 30-second grid, because differencing an EMA at tick resolution
  reads about 4× too low. Two series, on purpose; see
  [SDK_FEEDBACK §3 and §5](./SDK_FEEDBACK.md).
- `open_price` is reconstructed from the price feed at `trading_start`. The
  indexer publishes `strike: "0"` on these rows, so there is nothing to read.
- `vol_source` is `"fallback"` when the tick history was too thin to estimate,
  in which case `VATICR_FALLBACK_VOL` was used and `degraded` is usually set.
- `status` is the **indexer's** view and lags by seconds. The bot re-checks the
  authoritative on-chain status before sending anything; only `Trading` accepts
  orders.
- A market whose opening price or level cannot be recovered is **omitted**
  rather than returned with a guessed number, so this array can be shorter than
  `limit` even when more markets are live.

---

## `GET /intent`

What to do about one market, given the live book the bot is actually looking at.
The bot passes its own top-of-book in; the service does not fetch order books.

| param | type | default | notes |
|---|---|---|---|
| `market_id` | string | **required** | |
| `best_bid` | float | - | top-of-book YES bid |
| `best_ask` | float | - | top-of-book YES ask |
| `venue` | string | - | venueId to scope to |
| `edge_threshold` | float | `0.04` | minimum edge over the **touch** |

```
GET /intent?market_id=0x…106e2&best_bid=0.096&best_ask=0.118&edge_threshold=0.05
```

```json
{
  "forecast": { "...": "the same Forecast object as /forecasts" },
  "intent": {
    "action": "take_yes",
    "edge": 0.068,
    "reason": "posterior 0.186 clears ask 0.118 by 0.068",
    "target_probability": 0.186
  }
}
```

`action` is one of `take_yes`, `take_no`, `quote`, `skip`. The gate is the
**touch**, never the mid - clearing the mid but not the spread is the standard
way a bot with genuine edge still loses money. `404` if `market_id` has no live
forecast (expired, out of venue scope, or its opening price could not be
recovered).

---

## `POST /commit`

Record a forecast **before** its window closes, so it can be Brier-scored
afterwards. A prediction is only evidence of skill if it was written down before
the outcome was known.

Body (`CommitRequest`):

```json
{
  "market_id": "0x…106e2",
  "symbol": "BTC 300s @1788291000",
  "asset": "BTC",
  "posterior": 0.186,
  "prior": 0.186,
  "expiry": 1788291000,
  "headline_ids": ["2ed50b1525ae3599"]
}
```

Response:

```json
{ "recorded": true, "reason": "" }
```

Idempotent per `market_id`: a second commit for the same market returns
`{"recorded": false, "reason": "already committed"}` rather than overwriting.
Commitments land in `.vaticr/forecasts.jsonl`. This is the *off-chain* record;
the on-chain equivalent - same discipline, but tamper-evident - is
`bot/src/registry.ts` writing to `VaticrForecastRegistry.sol`, and it is the bot
that makes that call, not this service.

---

## `GET /calibration`

Reconciles every pending commitment against settled outcomes, then reports how
well the posteriors have actually tracked reality.

| param | type | default |
|---|---|---|
| `venue` | string | - |

```json
{
  "scored": 24,
  "brier_score": 0.1837,
  "baseline_brier": 0.25,
  "skill": 0.2652,
  "accuracy": 0.7083,
  "buckets": [
    { "range": "0.0-0.2", "count": 9, "mean_forecast": 0.121, "observed_up_rate": 0.111 },
    { "range": "0.8-1.0", "count": 7, "mean_forecast": 0.874, "observed_up_rate": 0.857 }
  ],
  "pending": 6,
  "voided": 1
}
```

`brier_score` is the mean squared error of the posterior against the realised
outcome; **0.25 is a coin flip and lower is better**, so `skill = 1 −
brier/0.25` is positive only when there is real edge. `buckets` is the
reliability diagram - does "70%" actually happen 70% of the time? Voided markets
are excluded from scoring rather than counted as losses: nothing was forecast
about a feed outage. With no settled commitments yet the report is
`{"scored": 0, "brier_score": null, "skill": null, "accuracy": null,
"buckets": [], "pending": n, "voided": m}`.

This route does real network work (it reconciles before reporting) and can take
several seconds.

---

## `GET /audit`

Independently recomputes each settled window from the public oracle price feed
and compares the result to the on-chain winner.

| param | type | default | notes |
|---|---|---|---|
| `venue` | string | - | |
| `limit` | int | `12` | max `50` |

```json
{
  "verified": 11,
  "mismatched": 0,
  "inconclusive": 1,
  "total": 12,
  "reference": "mark (EMA) - empirically the settlement series; see docs/SDK_FEEDBACK.md",
  "settlements": [
    {
      "market_id": "0x0000000000000000000000000000000000000000000000000000000000010bd5",
      "symbol": "ETH 60s @1788316260",
      "asset": "ETH",
      "expiry": 1788316260,
      "onchain_outcome": "down",
      "derived_outcome": "down",
      "open_reference": 2408.6424078347227,
      "close_reference": 2406.1759244480654,
      "margin_bps": -10.24,
      "verdict": "match",
      "oracle_question_id": "27018257724669958180025863985432783564611049281960413864925743360817806389311",
      "receipt_url": "https://dev.oracle.somnia.host/questions/27018257724669958180025863985432783564611049281960413864925743360817806389311?view=graph"
    }
  ]
}
```

(The `settlements` row above is real; the counters are illustrative of a run
that hit one sub-1bp window. A clean run reports
`{"verified": 4, "mismatched": 0, "inconclusive": 0, "total": 4}`.)

The three counters are the whole point, and they are deliberately not two:

| `verdict` | counted as | meaning |
|---|---|---|
| `match` | `verified` | our reconstruction agrees with the chain |
| `MISMATCH` | `mismatched` | genuine disagreement, decided by **≥ 1bp** |
| `inconclusive` | `inconclusive` | disagreement under **1bp** (`INCONCLUSIVE_BPS` in `agents/resolver.py`) |
| `voided` | - | the market was voided; nothing to verify |
| `unverifiable` | - | the feed could not supply one of the two references |

The 1bp floor is not a fudge. The oracle settles on its own sampled tick and we
recover the reference from the public feed by timestamp; the two can differ by a
tick, which is irrelevant on a normal window and decisive on one that closed
0.005% from its open. Measured over twenty settlements, both "nearest tick" and
"last tick at or before the boundary" reproduce the on-chain winner 19/20,
failing on the *same* window. Below that margin the honest statement is that our
resolution ran out - not that the chain is wrong. Anything at or above it is
reported as a real mismatch.

`verdict` values `voided` and `unverifiable` appear in `settlements` but are in
none of the three counters, so `verified + mismatched + inconclusive ≤ total`.

---

## `GET /backstops`

Windows the oracle has not answered inside their settlement grace period, each
with the permissionless call that unsticks it.

| param | type | default |
|---|---|---|
| `venue` | string | - |

```json
{
  "count": 2,
  "markets": [
    {
      "market_id": "0x00000000000000000000000000000000000000000000000000000000000106e3",
      "symbol": "ETH 300s @1788291000",
      "expiry": 1788291000,
      "overdue_sec": 24806,
      "oracle_question_id": "48768",
      "suggested_call": "voidExpired",
      "receipt_url": "https://dev.oracle.somnia.host/questions/48768?view=graph"
    }
  ]
}
```

`suggested_call` is `pokeOracle` while the window is only modestly overdue and
`voidExpired` once it has lapsed far past the grace period (4× the 300s grace).
This service only *names* the call - it holds no key. Execution is
[`bot/src/backstop.ts`](../bot/src/backstop.ts), run with `npm run backstop`.

---

## Consumers

| Consumer | Uses |
|---|---|
| `bot/src/runner.ts` | `/forecasts` each cycle, `/commit` per new window |
| `bot/src/doctor.ts` | `/health`, `/forecasts` |
| `bot/src/backstop.ts` | `/backstops` |
| `app/components/Dashboard.tsx` | `/health`, `/forecasts`, `/headlines`, `/audit` |
| `app/components/LiveStats.tsx` | `/health`, `/forecasts`, `/audit` |

The browser never calls this service directly - Next.js proxies it through
`/api/vaticr/<path>` so the API URL stays server-side and there is one origin.
