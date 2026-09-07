"""The historical backtest - evidence for subsystem 2.

(`docs/ARCHITECTURE.md` §2 is the Bayesian engine; this replays it against the
past rather than adding anything to it.)

Vaticr's whole claim is that an event contract's probability can be *derived*
rather than guessed. The live track record cannot prove that yet: forecasts
accrue at the rate windows settle, and a handful of scored windows is noise.

But nothing about the claim needs to wait. Every input is public and
historical. The indexer holds hundreds of already-settled Up/Down windows with
the outcome the oracle actually wrote, and the price feed holds the full
one-second spot/mark series behind each of them. So the engine can be replayed
against the past: stand at a moment *inside* a window that closed hours ago,
reconstruct exactly what `agents.server` would have seen at that instant, ask
`pricing.prior_up` for a number, and check it against what the chain settled.

    ./.venv/bin/python -m agents.backtest --limit 300

**What is being tested.** The prior only - the price-process half of the
engine. The headline layer is deliberately excluded, and not because it is
inconvenient: reconstructing the scout's rolling window as it stood at a past
instant would require a historical news archive we do not have, and
approximating it with today's feed would leak the future into the forecast.
The prior is also the half that carries most of the weight (see the module
docstring in `pricing`), so it is the half worth proving.

**How lookahead is prevented.** One chokepoint, `PriceHistory._visible`, turns
a decision timestamp into an exclusive upper index via `bisect_right`. Every
decision-time quantity - the opening reference, the level, the volatility
series - is read through it and can only see ticks with `ts <= decision_ts`.
Nothing else indexes the tick array. The outcome is never derived from prices
at all; it is read from the settled indexer row. Each scored case additionally
carries the largest tick timestamp it consumed, and `Case.__post_init__`
asserts that value never exceeds its own decision time, so the guarantee is
re-checked at every decision point rather than merely asserted in a comment.

None of that would catch a leak introduced *inside* an accessor, so
`verify_no_lookahead` proves it a third way: a sample of cases is recomputed
against a history physically rebuilt without the future, and every field must
come out bit-identical. That check is not vacuous - mutating `level()` to peek
60 seconds forward takes it from 120/120 to 0/120. Both audit lines print in
the report header.

**Honesty rules.** Nothing here is tuned to the result. Markets with thin tick
coverage are *skipped and counted*, never filled with the fallback volatility -
substituting the fallback would measure a constant from `config.py` rather than
the engine. The report prints whatever comes out. A negative skill number would
be a real finding about the model and is reported as one.
"""

from __future__ import annotations

import argparse
import asyncio
import bisect
import json
import logging
import math
import time
from collections import Counter
from dataclasses import dataclass, field

import httpx

from .config import Settings, get_settings
from .pricing import PricePoint, annualise, prior_up, realized_vol_per_sec
from .somnia import MarketRow, PriceTick, SomniaReader

log = logging.getLogger("vaticr.backtest")

# Where inside each window to stand and forecast, as a fraction elapsed.
DEFAULT_FRACTIONS = (0.25, 0.50, 0.75)

# How much history the volatility estimate may look back over. 2400s is not an
# arbitrary choice: it is exactly what `agents.server._series` fetches live, and
# the backtest is worthless if it feeds the engine a different diet than
# production does. This history sits *before* the decision point, and for the
# early decision points it reaches back before the window even opened - that is
# past data, not future data, and the fetch span is widened to cover it.
VOL_LOOKBACK_SEC = 2400

# The price feed caps a single response at 5000 rows, so a multi-hour span is
# paged backwards. Sequential, with a small pause: this is somebody's public
# endpoint and a backtest is not an excuse to hammer it.
PAGE_LIMIT = 5000
PAGE_PAUSE_SEC = 0.15
MAX_PAGES = 48

# A decision point is only honoured if the feed has a tick within this many
# seconds *before* it. The feed publishes at 1s with occasional gaps of a few
# seconds; anything staler than this means we would be forecasting off a level
# the live agent would not have had either.
STALE_LEVEL_SEC = 30
# Same idea for the window's opening reference, which the indexer does not
# publish (rows carry strike="0") and which therefore has to be recovered from
# the feed at `tradingStart`. `somnia.tick_at` uses the same +/-120s tolerance.
OPEN_TOLERANCE_SEC = 120

COIN_FLIP_BRIER = 0.25
COIN_FLIP_LOG_LOSS = math.log(2.0)
# Log loss is unbounded, and the raw prior is genuinely allowed to reach 0.0000
# on a window that has run away from its open. Clipping is only so a single
# confident miss does not print `inf` and erase every other number.
LOG_LOSS_CLIP = 1e-6


# --- the tick history, and the one place time is bounded --------------------
class PriceHistory:
    """One asset's ascending tick series, sliced only ever by an upper bound.

    The entire no-lookahead guarantee of this module lives in `_visible`. It is
    the only method that indexes `self.ticks`, every public accessor goes
    through it, and it returns an *exclusive* end index from `bisect_right`, so
    the returned prefix contains exactly the ticks with `ts <= upto`.
    """

    def __init__(self, asset: str, ticks: list[PriceTick]) -> None:
        self.asset = asset
        self.ticks = sorted(ticks, key=lambda t: t.ts)
        self._ts = [t.ts for t in self.ticks]

    def __len__(self) -> int:
        return len(self.ticks)

    @property
    def span(self) -> tuple[int, int]:
        return (self._ts[0], self._ts[-1]) if self._ts else (0, 0)

    def _visible(self, upto: int) -> int:
        """Exclusive end index of the ticks knowable at `upto`."""
        return bisect.bisect_right(self._ts, upto)

    def level(self, upto: int) -> PriceTick | None:
        """The most recent tick at `upto`, or None if the feed had gone quiet."""
        end = self._visible(upto)
        if end == 0:
            return None
        tick = self.ticks[end - 1]
        return tick if upto - tick.ts <= STALE_LEVEL_SEC else None

    def open_reference(self, trading_start: int, upto: int) -> PriceTick | None:
        """The tick nearest the window's open, among those visible at `upto`.

        Mirrors `somnia.tick_at`: nearest wins, within a +/-120s tolerance. By
        construction `trading_start < upto`, so the ticks bracketing the open
        are all in the past at the decision point and no future data is touched
        to recover the line to beat.
        """
        end = self._visible(upto)
        if end == 0:
            return None
        lo = bisect.bisect_left(self._ts, trading_start - OPEN_TOLERANCE_SEC)
        hi = min(end, bisect.bisect_right(self._ts, trading_start + OPEN_TOLERANCE_SEC))
        if hi <= lo:
            return None
        window = self.ticks[lo:hi]
        return min(window, key=lambda t: abs(t.ts - trading_start))

    def vol_points(self, upto: int, lookback: int = VOL_LOOKBACK_SEC) -> list[PricePoint]:
        """The spot series the vol estimator may see at `upto`.

        `spot`, not `mark`, for the reason `agents.server._series` documents:
        the mark is an EMA and differencing it measures the smoothing.
        """
        end = self._visible(upto)
        start = bisect.bisect_left(self._ts, upto - lookback)
        return [PricePoint(ts=t.ts, price=t.spot) for t in self.ticks[start:end]]

    def max_ts_upto(self, upto: int) -> int:
        """Largest tick timestamp any accessor could have returned at `upto`."""
        end = self._visible(upto)
        return self._ts[end - 1] if end else -1


# --- one replayed forecast --------------------------------------------------
@dataclass(frozen=True)
class Case:
    """A prior computed at one instant inside one settled window, and its truth."""

    market_id: str
    asset: str
    interval_sec: int
    trading_start: int
    expiry: int
    fraction: float
    decision_ts: int
    seconds_left: float
    open_ref: float
    level: float
    annual_vol: float
    prior: float
    outcome: str  # 'up' or 'down', straight off the settled indexer row
    tick_count: int
    max_tick_ts: int

    def __post_init__(self) -> None:
        # Re-check the lookahead guarantee per case rather than trusting the
        # comment above it. A backtest that has quietly leaked the future is
        # worse than no backtest, because it reads as evidence.
        if self.max_tick_ts > self.decision_ts:
            raise AssertionError(
                f"lookahead: {self.market_id} used tick {self.max_tick_ts} "
                f"at decision {self.decision_ts}"
            )

    @property
    def actual(self) -> float:
        return 1.0 if self.outcome == "up" else 0.0

    @property
    def brier(self) -> float:
        return (self.prior - self.actual) ** 2

    @property
    def hit(self) -> bool:
        return (self.prior >= 0.5) == (self.outcome == "up")

    def log_loss(self, floor: float = LOG_LOSS_CLIP, ceil: float | None = None) -> float:
        p = min(max(self.prior, floor), ceil if ceil is not None else 1.0 - floor)
        return -(self.actual * math.log(p) + (1.0 - self.actual) * math.log(1.0 - p))

    def as_dict(self) -> dict:
        return {
            "market_id": self.market_id,
            "asset": self.asset,
            "interval_sec": self.interval_sec,
            "fraction": self.fraction,
            "decision_ts": self.decision_ts,
            "seconds_left": self.seconds_left,
            "open_ref": round(self.open_ref, 4),
            "level": round(self.level, 4),
            "annual_vol": round(self.annual_vol, 4),
            "prior": round(self.prior, 6),
            "outcome": self.outcome,
            "brier": round(self.brier, 6),
        }


# --- scoring ----------------------------------------------------------------
@dataclass(frozen=True)
class Score:
    """Aggregate metrics over a set of cases. Used for the whole run and slices."""

    n: int
    brier: float | None = None
    skill: float | None = None
    accuracy: float | None = None
    log_loss: float | None = None
    base_rate: float | None = None

    def as_dict(self) -> dict:
        return {
            "n": self.n,
            "brier": self.brier,
            "skill": self.skill,
            "accuracy": self.accuracy,
            "log_loss": self.log_loss,
            "base_rate": self.base_rate,
        }


def score_cases(cases: list[Case]) -> Score:
    if not cases:
        return Score(n=0)
    n = len(cases)
    brier = sum(c.brier for c in cases) / n
    return Score(
        n=n,
        brier=round(brier, 5),
        skill=round(1.0 - brier / COIN_FLIP_BRIER, 4),
        accuracy=round(sum(1 for c in cases if c.hit) / n, 4),
        log_loss=round(sum(c.log_loss() for c in cases) / n, 5),
        base_rate=round(sum(c.actual for c in cases) / n, 4),
    )


def reliability(cases: list[Case], bins: int = 10) -> list[dict]:
    """Does "70%" actually happen 70% of the time? One row per non-empty bucket."""
    rows: list[dict] = []
    for i in range(bins):
        lo, hi = i / bins, (i + 1) / bins
        members = [
            c for c in cases
            if lo <= c.prior < hi or (i == bins - 1 and c.prior >= hi)
        ]
        if not members:
            continue
        rows.append(
            {
                "range": f"{lo:.1f}-{hi:.1f}",
                "count": len(members),
                "mean_forecast": round(sum(c.prior for c in members) / len(members), 4),
                "observed_up_rate": round(
                    sum(c.actual for c in members) / len(members), 4
                ),
            }
        )
    return rows


@dataclass
class BacktestReport:
    """Everything the run measured, in a shape the API or a test can consume."""

    network: str
    venue_id: str | None
    markets_requested: int
    markets_usable: int
    markets_skipped: int
    skip_reasons: dict[str, int]
    fractions: tuple[float, ...]
    window_from: int
    window_to: int
    ticks_per_asset: dict[str, int]
    lookahead_checked: int
    truncation_checked: int = 0
    truncation_matched: int = 0
    cases: list[Case] = field(default_factory=list)

    @property
    def overall(self) -> Score:
        return score_cases(self.cases)

    @property
    def clamped_log_loss(self) -> float | None:
        """Log loss with the production posterior clamp applied.

        `pricing.build_forecast` never publishes a probability outside
        [prob_floor, prob_ceil]; the raw prior is unclamped and can sit at
        0.000000, where a single miss costs 13.8 nats. Both numbers are honest -
        the raw one measures the model, the clamped one measures what the bot
        would actually have quoted - so both are printed rather than one being
        chosen to flatter the other.
        """
        if not self.cases:
            return None
        s = get_settings()
        total = sum(
            c.log_loss(floor=s.prob_floor, ceil=s.prob_ceil) for c in self.cases
        )
        return round(total / len(self.cases), 5)

    @property
    def climatology(self) -> Score | None:
        """Brier of always quoting the sample's own observed up-rate.

        A harder baseline than the coin flip and an in-sample one - it is handed
        the answer's base rate for free, which no live forecaster gets. It is
        here because beating 0.25 on a sample that happened to settle 55% down
        is not by itself evidence of anything.
        """
        if not self.cases:
            return None
        rate = sum(c.actual for c in self.cases) / len(self.cases)
        brier = sum((rate - c.actual) ** 2 for c in self.cases) / len(self.cases)
        return Score(n=len(self.cases), brier=round(brier, 5), base_rate=round(rate, 4))

    def by(self, key) -> list[tuple[str, Score]]:
        """Score one slice per distinct `key(case)`, in a stable readable order.

        Ordered by window length then decision point rather than by label, so
        "900s" sorts after "300s" instead of before it.
        """
        groups: dict[str, list[Case]] = {}
        for c in self.cases:
            groups.setdefault(str(key(c)), []).append(c)
        ordered = sorted(
            groups.items(),
            key=lambda kv: (
                min(c.interval_sec for c in kv[1]),
                min(c.fraction for c in kv[1]),
                kv[0],
            ),
        )
        return [(name, score_cases(members)) for name, members in ordered]

    @property
    def verdict(self) -> str:
        s = self.overall
        if s.n == 0 or s.skill is None:
            return "NO RESULT - no window had enough tick coverage to score."
        if s.skill <= 0.0:
            return (
                f"NEGATIVE RESULT - skill {s.skill:+.4f}. Over these {s.n} "
                f"forecasts the derived prior did not beat a coin flip."
            )
        return (
            f"skill {s.skill:+.4f} over {s.n} forecasts - the derived prior beat "
            f"the coin flip on {self.markets_usable} settled windows it never saw."
        )

    def as_dict(self) -> dict:
        return {
            "network": self.network,
            "venue_id": self.venue_id,
            "markets_requested": self.markets_requested,
            "markets_usable": self.markets_usable,
            "markets_skipped": self.markets_skipped,
            "skip_reasons": self.skip_reasons,
            "fractions": list(self.fractions),
            "window_from": self.window_from,
            "window_to": self.window_to,
            "ticks_per_asset": self.ticks_per_asset,
            "lookahead_checked": self.lookahead_checked,
            "truncation_checked": self.truncation_checked,
            "truncation_matched": self.truncation_matched,
            "overall": self.overall.as_dict(),
            "clamped_log_loss": self.clamped_log_loss,
            "climatology": self.climatology.as_dict() if self.climatology else None,
            "reliability": reliability(self.cases),
            "by_asset": {k: v.as_dict() for k, v in self.by(lambda c: c.asset)},
            "by_window_sec": {
                k: v.as_dict() for k, v in self.by(lambda c: c.interval_sec)
            },
            "by_fraction": {
                k: v.as_dict() for k, v in self.by(lambda c: f"{c.fraction:.2f}")
            },
            "verdict": self.verdict,
        }


def _same_case(a: Case, b: Case) -> bool:
    """Bit-for-bit equality of every decision-time quantity."""
    return (
        a.open_ref == b.open_ref
        and a.level == b.level
        and a.annual_vol == b.annual_vol
        and a.prior == b.prior
        and a.tick_count == b.tick_count
    )


# --- data loading -----------------------------------------------------------
class Backtester:
    """Replays the prior over settled windows. Network reads cached per run."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.reader = SomniaReader(self.settings)
        self._history: dict[str, PriceHistory] = {}

    async def _fetch_history(
        self, client: httpx.AsyncClient, asset: str, since: int, until: int
    ) -> PriceHistory:
        """Page the 1s feed backwards over [since, until] and cache it.

        The feed returns the newest `PAGE_LIMIT` rows inside the bounds, so each
        page walks the ceiling down to just below the earliest row it saw. One
        request at a time - a few hundred markets need ~12 pages per asset, and
        that is the entire network cost of the run.
        """
        cached = self._history.get(asset)
        if cached is not None:
            return cached

        collected: dict[int, PriceTick] = {}
        ceiling = until
        for page in range(MAX_PAGES):
            ticks = await self.reader.price_series(
                client, asset, since=since, until=ceiling, limit=PAGE_LIMIT
            )
            if not ticks:
                break
            for t in ticks:
                collected[t.ts] = t
            earliest = ticks[0].ts
            log.info(
                "backtest: %s page %d -> %d ticks, back to %d",
                asset, page + 1, len(ticks), earliest,
            )
            if earliest <= since or len(ticks) < PAGE_LIMIT:
                break
            ceiling = earliest - 1
            await asyncio.sleep(PAGE_PAUSE_SEC)

        history = PriceHistory(asset, list(collected.values()))
        self._history[asset] = history
        return history

    async def load(
        self, client: httpx.AsyncClient, venue_id: str | None, limit: int,
        asset: str | None = None,
    ) -> tuple[list[MarketRow], dict[str, PriceHistory]]:
        markets = await self.reader.settled_markets(
            client, venue_id=venue_id, limit=limit
        )
        markets = [
            m for m in markets
            if m.outcome in ("up", "down")
            and m.interval_sec > 0
            and m.expiry > m.trading_start
        ]
        if asset:
            markets = [m for m in markets if m.asset == asset.upper()]
        if not markets:
            return [], {}

        histories: dict[str, PriceHistory] = {}
        for a in sorted({m.asset for m in markets}):
            rows = [m for m in markets if m.asset == a]
            # The vol lookback reaches back before the earliest window opens, so
            # the fetch floor has to as well or the oldest markets would be
            # skipped for a shortage we created ourselves.
            since = min(r.trading_start for r in rows) - VOL_LOOKBACK_SEC - 60
            until = max(r.expiry for r in rows)
            histories[a] = await self._fetch_history(client, a, since, until)
            log.info("backtest: %s history %d ticks", a, len(histories[a]))
        return markets, histories

    # -- the replay ----------------------------------------------------------
    def replay_market(
        self, market: MarketRow, history: PriceHistory,
        fractions: tuple[float, ...] = DEFAULT_FRACTIONS,
    ) -> tuple[list[Case], list[str]]:
        """Every decision point inside one settled window. Returns (cases, skips)."""
        cases: list[Case] = []
        skips: list[str] = []
        window = float(market.interval_sec or (market.expiry - market.trading_start))

        for frac in fractions:
            decision_ts = market.trading_start + int(round(frac * window))
            if decision_ts >= market.expiry:
                skips.append("decision at or past expiry")
                continue

            open_tick = history.open_reference(market.trading_start, decision_ts)
            if open_tick is None:
                skips.append("no opening reference in feed")
                continue
            level_tick = history.level(decision_ts)
            if level_tick is None:
                skips.append("no fresh level at decision time")
                continue

            points = history.vol_points(decision_ts)
            sigma = realized_vol_per_sec(points, self.settings.vol_sample_step_sec)
            if sigma is None:
                # Deliberately NOT falling back to config's fallback_annual_vol:
                # that would score a constant instead of the engine.
                skips.append("insufficient ticks for volatility")
                continue

            # Both prices come from `mark`, the EMA the settlement is computed
            # against. Using spot for the level would price a different question
            # than the one the contract asks.
            prior = prior_up(
                spot=level_tick.mark,
                open_price=open_tick.mark,
                seconds_left=float(market.expiry - decision_ts),
                sigma_per_sec=sigma,
            )
            cases.append(
                Case(
                    market_id=market.market_id,
                    asset=market.asset,
                    interval_sec=market.interval_sec,
                    trading_start=market.trading_start,
                    expiry=market.expiry,
                    fraction=frac,
                    decision_ts=decision_ts,
                    seconds_left=float(market.expiry - decision_ts),
                    open_ref=open_tick.mark,
                    level=level_tick.mark,
                    annual_vol=round(annualise(sigma), 4),
                    prior=prior,
                    outcome=market.outcome or "",
                    tick_count=len(points),
                    max_tick_ts=history.max_ts_upto(decision_ts),
                )
            )
        return cases, skips

    def verify_no_lookahead(
        self, markets: list[MarketRow], histories: dict[str, PriceHistory],
        fractions: tuple[float, ...], sample: int = 40,
    ) -> tuple[int, int]:
        """Recompute a sample of cases against a physically truncated history.

        The `bisect_right` chokepoint and the per-case assertion both argue that
        no future tick is reachable. This proves it instead: for each sampled
        decision point the asset's series is rebuilt containing *only* ticks at
        or before that instant - the future does not exist in the object at all
        - and the case is recomputed. If any accessor were reaching forward, the
        opening reference, the level, the volatility or the prior would move.
        Every field is compared, not just the prior, because a leak that happens
        to cancel out in one number is still a leak.

        Returns (checked, identical).
        """
        if not markets:
            return (0, 0)
        # Deterministic spread across the sample rather than a random draw, so a
        # rerun checks the same cases and a failure is reproducible.
        step = max(1, len(markets) // max(1, sample))
        checked = matched = 0
        for market in markets[::step][:sample]:
            history = histories.get(market.asset)
            if history is None:
                continue
            for case in self.replay_market(market, history, fractions)[0]:
                cut = history.ticks[: bisect.bisect_right(history._ts, case.decision_ts)]
                blind = PriceHistory(market.asset, cut)
                redone = self.replay_market(market, blind, (case.fraction,))[0]
                checked += 1
                if redone and _same_case(redone[0], case):
                    matched += 1
        return (checked, matched)

    async def run(
        self, *, venue_id: str | None = None, limit: int = 300,
        fractions: tuple[float, ...] = DEFAULT_FRACTIONS,
        asset: str | None = None, selftest: int = 40,
    ) -> BacktestReport:
        async with httpx.AsyncClient(
            timeout=max(30.0, self.settings.http_timeout_sec)
        ) as client:
            markets, histories = await self.load(client, venue_id, limit, asset)

        cases: list[Case] = []
        skips: Counter[str] = Counter()
        usable = 0
        for m in markets:
            history = histories.get(m.asset)
            if history is None or not len(history):
                skips["no price history for asset"] += len(fractions)
                continue
            got, missed = self.replay_market(m, history, fractions)
            cases.extend(got)
            skips.update(missed)
            if got:
                usable += 1

        truncation = (
            self.verify_no_lookahead(markets, histories, fractions, selftest)
            if selftest else (0, 0)
        )
        return BacktestReport(
            network=self.reader.network,
            venue_id=venue_id,
            markets_requested=len(markets),
            markets_usable=usable,
            markets_skipped=len(markets) - usable,
            skip_reasons=dict(skips),
            fractions=fractions,
            window_from=min((m.trading_start for m in markets), default=0),
            window_to=max((m.expiry for m in markets), default=0),
            ticks_per_asset={a: len(h) for a, h in histories.items()},
            # Every Case asserted its own bound at construction, so a case that
            # exists is a case that passed.
            lookahead_checked=len(cases),
            truncation_checked=truncation[0],
            truncation_matched=truncation[1],
            cases=cases,
        )


# --- CLI --------------------------------------------------------------------
def default_venue() -> str | None:
    """VENUE_ID from the environment, falling back to the project's .env file.

    `config.Settings` does not carry the venue - it is a bot-side value that the
    TypeScript runner and the dashboard read straight from `.env` - but a
    backtest that ignores it silently mixes every venue on the testnet into one
    sample. Reading it here keeps the default honest without reaching into a
    module this file does not own.
    """
    from os import environ, path

    venue = environ.get("VENUE_ID")
    if venue:
        return venue
    env_file = path.join(path.dirname(path.dirname(path.abspath(__file__))), ".env")
    try:
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                key, _, value = line.partition("=")
                if key.strip() == "VENUE_ID" and value.strip():
                    return value.strip()
    except OSError:
        pass
    return None


def _utc(ts: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts)) if ts else "-"


def _score_line(label: str, s: Score) -> str:
    if s.n == 0 or s.brier is None:
        return f"  {label:<16}n=0"
    return (
        f"  {label:<16}n={s.n:<6} Brier={s.brier:.5f}  skill={s.skill:+.4f}  "
        f"acc={s.accuracy:.4f}  logloss={s.log_loss:.4f}  up-rate={s.base_rate:.3f}"
    )


def render(report: BacktestReport) -> str:
    r = report
    s = r.overall
    out: list[str] = []
    out.append("\n=== VATICR BACKTEST - derived priors vs settled outcomes ===")
    out.append(f"  network        {r.network}")
    out.append(f"  venue          {r.venue_id or '(all)'}")
    out.append(
        f"  markets        {r.markets_requested} settled, {r.markets_usable} scored, "
        f"{r.markets_skipped} skipped"
    )
    out.append(
        f"  decision pts   {' / '.join(f'{f:.0%}' for f in r.fractions)} of each "
        f"window elapsed"
    )
    out.append(
        f"  sample span    {_utc(r.window_from)} -> {_utc(r.window_to)} UTC"
    )
    out.append(
        "  price ticks    "
        + "  ".join(f"{a} {n:,}" for a, n in sorted(r.ticks_per_asset.items()))
        + "  (1s feed, paged)"
    )
    out.append(
        f"  lookahead      {r.lookahead_checked}/{r.lookahead_checked} cases asserted "
        f"max(tick ts) <= decision ts"
    )
    if r.truncation_checked:
        out.append(
            f"  replay proof   {r.truncation_matched}/{r.truncation_checked} cases "
            f"identical when the history is physically truncated at the decision"
        )

    out.append("\n=== HEADLINE NUMBERS ===")
    if s.n == 0 or s.brier is None:
        out.append("  nothing scored")
    else:
        clim = r.climatology
        out.append(f"  sample size    {s.n} forecasts")
        out.append(f"  Brier          {s.brier:.5f}   (coin flip {COIN_FLIP_BRIER})")
        out.append(f"  skill          {s.skill:+.4f}     1 - Brier/0.25")
        if clim and clim.brier is not None:
            out.append(
                f"  climatology    {clim.brier:.5f}   always quoting the sample's "
                f"own {clim.base_rate:.1%} up-rate (in-sample, free answer)"
            )
        out.append(f"  accuracy       {s.accuracy:.4f}")
        out.append(
            f"  log loss       {s.log_loss:.5f}   (coin flip {COIN_FLIP_LOG_LOSS:.5f})"
        )
        cl = r.clamped_log_loss
        settings = get_settings()
        if cl is not None:
            out.append(
                f"  log loss (bot) {cl:.5f}   raw prior clamped to "
                f"[{settings.prob_floor}, {settings.prob_ceil}] as the bot would quote it"
            )

    out.append("\n=== RELIABILITY (does 70% happen 70% of the time?) ===")
    rows = reliability(r.cases)
    if not rows:
        out.append("  no cases")
    else:
        out.append(f"  {'bucket':<12}{'n':>7}{'forecast':>11}{'observed':>11}   error")
        for b in rows:
            err = b["observed_up_rate"] - b["mean_forecast"]
            out.append(
                f"  {b['range']:<12}{b['count']:>7}{b['mean_forecast']:>11.4f}"
                f"{b['observed_up_rate']:>11.4f}   {err:+.4f}"
            )

    out.append("\n=== BREAKDOWNS ===")
    for title, groups in (
        ("by asset", r.by(lambda c: c.asset)),
        ("by window", r.by(lambda c: f"{c.interval_sec}s")),
        ("by elapsed", r.by(lambda c: f"{c.fraction:.0%} in")),
    ):
        out.append(f"  -- {title}")
        for name, sc in groups:
            out.append(_score_line(name, sc))

    if r.skip_reasons:
        out.append("\n=== SKIPPED (never filled, always counted) ===")
        for reason, n in sorted(r.skip_reasons.items(), key=lambda kv: -kv[1]):
            out.append(f"  {n:>6}  {reason}")

    out.append(f"\n=== VERDICT ===\n  {r.verdict}")
    out.append(
        "  Prior only - the headline layer is excluded because a historical "
        "scout window\n  cannot be reconstructed without leaking the future."
    )
    return "\n".join(out)


async def _main() -> None:
    parser = argparse.ArgumentParser(
        description="Backtest the Vaticr prior against settled DreamDEX windows"
    )
    parser.add_argument("--limit", type=int, default=300, help="settled markets to pull")
    parser.add_argument(
        "--venue", default=None, help="venueId to scope to (defaults to VENUE_ID)"
    )
    parser.add_argument("--asset", default=None, help="restrict to BTC or ETH")
    parser.add_argument(
        "--fractions", default="0.25,0.50,0.75",
        help="comma-separated points inside each window to forecast at",
    )
    parser.add_argument(
        "--all-venues", action="store_true",
        help="do not scope to VENUE_ID (mixes every testnet venue into one sample)",
    )
    parser.add_argument(
        "--selftest", type=int, default=40,
        help="cases to re-run against a truncated history as a lookahead proof (0 off)",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    parser.add_argument("--cases", action="store_true", help="include every case in JSON")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(message)s",
    )

    venue = None if args.all_venues else (args.venue or default_venue())
    fractions = tuple(float(f) for f in args.fractions.split(",") if f.strip())

    report = await Backtester().run(
        venue_id=venue, limit=args.limit, fractions=fractions, asset=args.asset,
        selftest=args.selftest,
    )

    if args.json:
        payload = report.as_dict()
        if args.cases:
            payload["cases"] = [c.as_dict() for c in report.cases]
        print(json.dumps(payload, indent=2))
    else:
        print(render(report))


if __name__ == "__main__":
    asyncio.run(_main())
