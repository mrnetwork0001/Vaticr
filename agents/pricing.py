"""Subsystem 2 — the Bayesian probability engine.

A DreamDEX event contract asks one question: *will this window close at or
above the price it opened at?* That makes the fair value of the YES token a
genuine probability, and it can be derived rather than guessed.

The engine works in two stages.

**Prior — the price process.** Over a horizon of seconds to an hour, a driftless
geometric Brownian motion is a defensible model of BTC/ETH. With S the current
price, S0 the window's opening price ("the line to beat"), tau the seconds
remaining and sigma the per-second volatility:

    ln(S_T / S) ~ N(-sigma^2 * tau / 2, sigma^2 * tau)

    P(S_T >= S0) = Phi( (ln(S / S0) - sigma^2 * tau / 2) / (sigma * sqrt(tau)) )

This alone is a real edge: it is the honest read of where the window sits
relative to its own open, and it is what an order book full of humans watching
a candle chart tends to misprice near the extremes.

**Posterior — the headlines.** Each scored headline contributes a
log-likelihood ratio, and Bayes' rule is additive in log-odds:

    logit(posterior) = logit(prior) + sum_i LLR_i

Every contribution is discounted three ways: by the source's credibility, by
exponential time decay (news gets priced in), and by how much of the window is
left (a headline cannot move a contract that expires in four seconds). The
total is hard-capped so a burst of correlated stories cannot run the posterior
into a corner.

Fresh, genuinely market-moving headlines are rare — the scout typically holds
only a couple at a time. That is by design: the prior carries most of the
weight, and the news layer is a tilt on top of it, not a replacement for it.
"""

from __future__ import annotations

import math
import statistics
import time
from dataclasses import dataclass

from .config import Settings, get_settings
from .schemas import EvidenceItem, Forecast, Headline, TradeIntent

SECONDS_PER_YEAR = 365.0 * 24.0 * 3600.0


# --- small numerics ---------------------------------------------------------
def norm_cdf(x: float) -> float:
    """Standard normal CDF via the error function."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def logit(p: float) -> float:
    p = min(max(p, 1e-9), 1.0 - 1e-9)
    return math.log(p / (1.0 - p))


def sigmoid(x: float) -> float:
    # Branch to avoid overflow on large |x|.
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


@dataclass(frozen=True)
class PricePoint:
    ts: int
    price: float


# --- volatility -------------------------------------------------------------
def resample(points: list[PricePoint], step_sec: int) -> list[PricePoint]:
    """Snap an irregular tick series onto a fixed grid, last-observation-carried.

    Returns one point per `step_sec` bucket that has data.
    """
    ordered = sorted(points, key=lambda p: p.ts)
    if not ordered:
        return []
    out: list[PricePoint] = []
    bucket = ordered[0].ts // step_sec
    last = ordered[0]
    for point in ordered[1:]:
        b = point.ts // step_sec
        if b != bucket:
            out.append(last)
            bucket = b
        last = point
    out.append(last)
    return out


def realized_vol_per_sec(
    points: list[PricePoint], sample_step_sec: int = 30
) -> float | None:
    """Per-second volatility from a tick series, or None if too thin.

    The series is resampled onto a `sample_step_sec` grid before differencing,
    and this is not a detail — it is the difference between a usable number and
    a badly wrong one.

    The oracle publishes the settlement reference as an EMA (`mark`) at
    one-second resolution. An EMA is heavily autocorrelated, so consecutive
    one-second increments are far smaller than independent ones, and the
    textbook estimator reads the smoothing rather than the volatility.
    Measured on live BTC testnet data over a 50-minute span:

        sampling step   1s     5s     15s    30s    60s   120s
        vol from mark   0.079  0.155  0.234  0.278  0.264  0.266
        vol from spot   0.248  0.272  0.298  0.303  0.274  0.262

    against a ground truth of ~0.33 annualised implied by the actual realised
    300-second moves. At one second the estimate is roughly four times too low,
    which drives the prior to 0.0000 on windows that are genuinely close to a
    coin flip — the exact windows worth trading. By 30 seconds the
    autocorrelation has washed out and both series agree.
    """
    grid = resample(points, max(1, sample_step_sec))
    returns: list[float] = []
    for prev, cur in zip(grid, grid[1:]):
        dt = cur.ts - prev.ts
        if dt <= 0 or prev.price <= 0 or cur.price <= 0:
            continue
        # Normalise by elapsed time so a gap in the feed does not read as a jump.
        returns.append(math.log(cur.price / prev.price) / math.sqrt(dt))

    if len(returns) < 12:
        return None
    sigma = statistics.pstdev(returns)
    return sigma if sigma > 0 else None


def annualise(sigma_per_sec: float) -> float:
    return sigma_per_sec * math.sqrt(SECONDS_PER_YEAR)


def deannualise(annual_vol: float) -> float:
    return annual_vol / math.sqrt(SECONDS_PER_YEAR)


# --- the prior --------------------------------------------------------------
def prior_up(
    spot: float, open_price: float, seconds_left: float, sigma_per_sec: float
) -> float:
    """P(window closes at or above its opening price), price process only."""
    if spot <= 0 or open_price <= 0:
        return 0.5
    # No time and no vol left: the current position decides it outright.
    if seconds_left <= 0 or sigma_per_sec <= 0:
        return 1.0 if spot >= open_price else 0.0

    drift = math.log(spot / open_price)
    variance = sigma_per_sec * sigma_per_sec * seconds_left
    return norm_cdf((drift - 0.5 * variance) / math.sqrt(variance))


# --- the evidence -----------------------------------------------------------
def _decay(age_sec: float, half_life_sec: float) -> float:
    if half_life_sec <= 0:
        return 0.0
    return 0.5 ** (max(0.0, age_sec) / half_life_sec)


def _time_scale(seconds_left: float, window_sec: float) -> float:
    """How much of a headline's impact the remaining window can still express."""
    if window_sec <= 0 or seconds_left <= 0:
        return 0.0
    return math.sqrt(min(seconds_left, window_sec) / window_sec)


def evidence_for(
    headlines: list[Headline],
    asset: str,
    seconds_left: float,
    window_sec: float,
    now: int | None = None,
    settings: Settings | None = None,
) -> tuple[float, list[EvidenceItem]]:
    """Total headline evidence in log-odds, plus the per-item breakdown."""
    s = settings or get_settings()
    now = now or int(time.time())
    scale = _time_scale(seconds_left, window_sec)

    items: list[EvidenceItem] = []
    total = 0.0
    for h in headlines:
        if asset.upper() not in h.assets or h.sentiment == 0.0:
            continue
        age = max(0, now - h.published_at)
        decay = _decay(age, s.evidence_half_life_sec)
        llr = (
            s.evidence_kappa
            * h.sentiment
            * h.salience
            * h.credibility
            * decay
            * scale
        )
        if abs(llr) < 1e-4:
            continue
        total += llr
        items.append(
            EvidenceItem(
                headline_id=h.id,
                title=h.title,
                source=h.source,
                age_sec=age,
                log_likelihood_ratio=round(llr, 5),
                decay=round(decay, 5),
            )
        )

    capped = max(-s.evidence_cap, min(s.evidence_cap, total))
    items.sort(key=lambda i: abs(i.log_likelihood_ratio), reverse=True)
    return capped, items


# --- the forecast -----------------------------------------------------------
def build_forecast(
    *,
    asset: str,
    open_price: float,
    spot: float,
    seconds_left: float,
    window_sec: float,
    headlines: list[Headline],
    vol_points: list[PricePoint] | None = None,
    market_id: str | None = None,
    symbol: str | None = None,
    settings: Settings | None = None,
) -> Forecast:
    """Combine the price-process prior with headline evidence."""
    s = settings or get_settings()
    now = int(time.time())

    sigma = realized_vol_per_sec(vol_points or [], s.vol_sample_step_sec)
    vol_source: str = "realized"
    if sigma is None:
        sigma = deannualise(s.fallback_annual_vol)
        vol_source = "fallback"

    prior = prior_up(spot, open_price, seconds_left, sigma)
    ev_log_odds, evidence = evidence_for(
        headlines, asset, seconds_left, window_sec, now=now, settings=s
    )

    posterior = sigmoid(logit(prior) + ev_log_odds)
    posterior = min(max(posterior, s.prob_floor), s.prob_ceil)

    degraded = open_price <= 0 or spot <= 0
    return Forecast(
        asset=asset.upper(),
        market_id=market_id,
        symbol=symbol,
        open_price=open_price,
        spot=spot,
        seconds_left=round(seconds_left, 2),
        window_sec=window_sec,
        annual_vol=round(annualise(sigma), 4),
        vol_source=vol_source,  # type: ignore[arg-type]
        prior=round(prior, 6),
        posterior=round(posterior, 6),
        evidence_log_odds=round(ev_log_odds, 5),
        evidence=evidence,
        computed_at=now,
        degraded=degraded,
        note="missing open price or spot" if degraded else "",
    )


# --- turning a forecast into an intent --------------------------------------
def decide(
    forecast: Forecast,
    best_bid: float | None,
    best_ask: float | None,
    *,
    edge_threshold: float = 0.04,
) -> TradeIntent:
    """Compare the posterior to the live YES book and pick an action.

    `best_bid` / `best_ask` are YES probabilities. Taking is only worthwhile
    when the posterior clears the *touch* we would actually pay, not the mid —
    paying the spread is the most common way a "positive edge" signal loses
    money.
    """
    p = forecast.posterior

    if forecast.degraded:
        return TradeIntent(
            action="skip", edge=0.0, reason="degraded forecast", target_probability=p
        )

    if best_bid is None and best_ask is None:
        # An empty book is the cold-start case: mint-a-pair lets us quote both
        # sides with no inventory and no counterparty.
        return TradeIntent(
            action="quote", edge=0.0, reason="empty book — seed both sides",
            target_probability=p,
        )

    mid = (
        (best_bid + best_ask) / 2.0
        if best_bid is not None and best_ask is not None
        else (best_bid if best_bid is not None else best_ask)
    )
    assert mid is not None
    edge = p - mid

    # Buying YES lifts the ask; buying NO hits the bid (NO costs 1 - bid).
    if best_ask is not None and p - best_ask > edge_threshold:
        return TradeIntent(
            action="take_yes",
            edge=round(p - best_ask, 5),
            reason=f"posterior {p:.3f} clears ask {best_ask:.3f}",
            target_probability=p,
        )
    if best_bid is not None and best_bid - p > edge_threshold:
        return TradeIntent(
            action="take_no",
            edge=round(best_bid - p, 5),
            reason=f"bid {best_bid:.3f} clears posterior {p:.3f}",
            target_probability=p,
        )

    return TradeIntent(
        action="quote",
        edge=round(edge, 5),
        reason=f"no takeable edge (mid {mid:.3f}) — quote around posterior",
        target_probability=p,
    )
