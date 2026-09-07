# DoraHacks BUIDL - submission copy

Paste-ready text for the Somnia × DreamDEX Event Contracts Hackathon.
Fill the four bracketed placeholders before submitting.

- `[LIVE URL]` - the Vercel deployment
- `[VIDEO URL]` - the 2-3 minute walkthrough
- `[REPO URL]` - `https://github.com/mrnetwork0001/Vaticr` **once it is reachable by judges**
- `[DECK URL]` - https://claude.ai/code/artifact/72484586-670b-40fc-814f-a520e14b780e
  (**share it from the page's share menu first** - artifacts are private by default,
  so an unshared link opens for you and 404s for a judge)

---

## Name

Vaticr

## Tagline

*Price the window, trade the gap, prove the record.*

## Short description (280 characters)

An event contract's YES token has a real, derivable probability. Vaticr derives
it from the price process, tilts it with live news, trades the gap with zero
inventory, commits every forecast on-chain before settlement, and Brier-scores
itself afterwards.

## Full description

**The problem.** Every DreamDEX Event Contract asks one question: will this
window close at or above the price it opened at? That makes the fair value of a
YES token a genuine probability - not a matter of opinion. Yet the book is
quoted by people guessing, and nobody can tell afterwards whether any given
quote was skilful or lucky, because nothing was written down before the fact.

**What Vaticr does.** It derives that probability instead of guessing it.

1. **A prior from the price process.** Where the window sits relative to its own
   open, given time remaining and measured volatility - a closed-form GBM
   barrier probability, not a heuristic.
2. **A posterior from the news.** Live headlines are scored for directional
   impact and folded in as log-likelihood ratios, decayed by age, source
   credibility, and how much of the window is left.
3. **Traded through the official Bot Kit.** It takes when the posterior clears
   the touch by more than fees; otherwise it rests a two-sided **mint-a-pair**
   quote, which on a binary book needs no counterparty maker and therefore
   **no inventory**.
4. **Committed on-chain, before the fact.** Each forecast is written to a
   `VaticrForecastRegistry` contract while the window is still open, so the
   record cannot be edited after the outcome is known.
5. **Audited afterwards.** Every settled window is recomputed from the public
   oracle feed and compared to the on-chain winner, and the whole history is
   Brier-scored against a coin flip in the app.

**Why it is not a demo shell.** The frozen backtest covers 900 forecasts over
300 windows: Brier **0.15522** against a coin flip's 0.25, skill **+0.3791**,
accuracy 76.22%. It is lookahead-free - volatility and level at each decision
point use only ticks at or before that instant, asserted on all 900 cases and
re-run against a physically truncated history on 120 of them. The evidence file
is committed to the repository, not screenshotted.

**What we learned that others will hit.** Two findings changed what a *correct*
price even is, and both are undocumented. Settlement resolves against the
oracle's EMA (`mark`), not spot - over the eight most recent settlements `mark`
reproduced the on-chain winner 8/8 while spot managed 6/8, disagreeing exactly
on the near-the-money windows most worth trading. And because that feed is an
EMA sampled every second, the textbook volatility estimator measures the
smoothing rather than the process and reads roughly **4× too low**; volatility
has to come off `spot` on a 30-second grid. Both are written up, with the
measurements, in our SDK feedback report.

---

## Links

| | |
|---|---|
| Live app | `[LIVE URL]` |
| Demo video | `[VIDEO URL]` |
| Repository | `[REPO URL]` |
| Deck | https://claude.ai/code/artifact/72484586-670b-40fc-814f-a520e14b780e |
| SDK & documentation feedback | `[REPO URL]/blob/main/docs/SDK_FEEDBACK.md` |
| Backtest evidence, 900 forecasts | `[REPO URL]/blob/main/docs/evidence/backtest-2026-09-04.json` |
| Forecast registry on Shannon | https://shannon-explorer.somnia.network/address/0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A |

---

## Against the judging criteria

**Innovation & originality (20%).** Most prediction-market entries help a human
place a bet. Vaticr treats the contract as what it mathematically is - a
probability - and makes the interesting claim falsifiable by committing each
forecast on-chain *before* settlement, then scoring itself in public. The
mint-a-pair quoting strategy is a second original use of the protocol: it makes
two-sided market-making possible with zero inventory and no counterparty maker.

**Technical implementation (25%).** Trades through the official dreamDEX Bot Kit
(`ec-core`, vendored with its licence intact) and `@somnia-chain/markets-sdk`.
Four subsystems: a Python forecasting and audit service, a TypeScript trading
loop, a Solidity registry, and a Next.js 14 app with wagmi/viem wallet support.
114 tests. TypeScript owns every write because that is where the SDK owns
signing, nonces and escrow, and two senders on one key race each other.

**User experience & design (20%).** One working surface with five destinations,
not seven panels on a single scroll. Every probability is shown as both a bar
and a number. The app says when data is stale instead of inventing a value. It
is responsive down to 320px, and it has a settlement audit that would expose our
own model if it were wrong.

**Business & ecosystem impact (20%).** Two-sided quotes with zero inventory
lower the capital needed to make markets on a new venue, which is the binding
constraint on any young order book. The audit gives traders a reason to trust
settlement they did not have to take on faith. Both drive the thing the
ecosystem needs: more resting liquidity, on more windows, from more participants.

**Presentation & demo (15%).** See the deck and the walkthrough.

---

## Optional deliverable: SDK and documentation feedback

Submitted as [`docs/SDK_FEEDBACK.md`](docs/SDK_FEEDBACK.md) - six substantive
findings plus smaller notes, every one hit while building and verified against
live testnet data, with suggested fixes and what each cost us:

1. `ec-core` cannot be installed from outside the Bot Kit monorepo.
2. The opening price - the strike of every window - is not published anywhere.
3. Settlement resolves against `mark`, not `spot`, and this is undocumented.
4. `fetchPriceCandles` is broken on the testnet price feed.
5. The oracle feed is a 1-second EMA, so naive volatility reads ~4× too low.
6. Several venues run concurrently on one deployment.

It also records what worked well, because a feedback report that only complains
is not useful to the team receiving it.
