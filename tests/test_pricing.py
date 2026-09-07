"""Property tests for the Bayesian engine.

Runs standalone (`python -m tests.test_pricing`) or under pytest.
"""

from __future__ import annotations

import math
import random
import time

from agents.config import get_settings
from agents.pricing import (
    PricePoint,
    annualise,
    build_forecast,
    deannualise,
    decide,
    evidence_for,
    logit,
    norm_cdf,
    prior_up,
    realized_vol_per_sec,
    resample,
    sigmoid,
)
from agents.schemas import Headline

S = get_settings()
SIGMA_1S = deannualise(0.55)  # ~55% annual vol, typical for BTC


def approx(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def test_norm_cdf_and_logit_roundtrip() -> None:
    assert approx(norm_cdf(0.0), 0.5)
    assert norm_cdf(-5) < 1e-6 and norm_cdf(5) > 1 - 1e-6
    for p in (0.01, 0.25, 0.5, 0.73, 0.99):
        assert approx(sigmoid(logit(p)), p, 1e-9)


def test_prior_at_the_money_is_a_coin_flip() -> None:
    """S == S0 with time left is ~0.5, a hair under from the -sigma^2*tau/2 term."""
    p = prior_up(100.0, 100.0, 900, SIGMA_1S)
    assert 0.49 < p < 0.5, p


def test_prior_moves_the_right_way() -> None:
    up = prior_up(101.0, 100.0, 900, SIGMA_1S)
    down = prior_up(99.0, 100.0, 900, SIGMA_1S)
    assert up > 0.5 > down
    # Symmetry: equal log-distance either side is equally far from 0.5.
    a = prior_up(100.0 * math.exp(0.01), 100.0, 900, SIGMA_1S)
    b = prior_up(100.0 * math.exp(-0.01), 100.0, 900, SIGMA_1S)
    assert approx(a - 0.5, 0.5 - b, 2e-3)


def test_prior_converges_to_a_step_at_expiry() -> None:
    """Less time left => more certain, and tau == 0 is a hard step."""
    prev = prior_up(101.0, 100.0, 3600, SIGMA_1S)
    for tau in (900, 300, 60, 10, 1):
        cur = prior_up(101.0, 100.0, tau, SIGMA_1S)
        assert cur >= prev - 1e-9, f"not monotone at tau={tau}"
        prev = cur
    assert prior_up(101.0, 100.0, 0, SIGMA_1S) == 1.0
    assert prior_up(99.0, 100.0, 0, SIGMA_1S) == 0.0
    # Exactly at the line at expiry, "at or above" wins.
    assert prior_up(100.0, 100.0, 0, SIGMA_1S) == 1.0


def test_higher_vol_pulls_toward_a_coin_flip() -> None:
    calm = prior_up(101.0, 100.0, 900, deannualise(0.20))
    wild = prior_up(101.0, 100.0, 900, deannualise(2.00))
    assert calm > wild > 0.5


def test_realized_vol_recovers_a_known_sigma() -> None:
    """Simulate a GBM at a known sigma and check the estimator finds it."""
    random.seed(7)
    true_sigma = deannualise(0.60)
    price, ts = 79_000.0, 1_700_000_000
    points = [PricePoint(ts, price)]
    for i in range(1, 4000):
        price *= math.exp(true_sigma * random.gauss(0, 1))
        points.append(PricePoint(ts + i, price))

    est = realized_vol_per_sec(points)
    assert est is not None
    # Within 10% of truth on 4k samples.
    assert abs(annualise(est) - 0.60) / 0.60 < 0.10, annualise(est)


def test_vol_estimator_is_immune_to_ema_smoothing() -> None:
    """An EMA of a random walk must not read as low volatility.

    This is the regression for the bug that drove live priors to 0.0000: raw
    one-second differencing of the oracle's EMA measured the smoothing, not the
    process. Resampling onto a coarser grid recovers the true sigma.
    """
    random.seed(11)
    true_sigma = deannualise(0.35)
    price, ts = 79_000.0, 1_700_000_000
    raw, ema = [], []
    smoothed = price
    alpha = 2.0 / (60.0 + 1.0)  # ~60s EMA, like the oracle mark
    for i in range(6000):
        price *= math.exp(true_sigma * random.gauss(0, 1))
        smoothed += alpha * (price - smoothed)
        raw.append(PricePoint(ts + i, price))
        ema.append(PricePoint(ts + i, smoothed))

    naive = realized_vol_per_sec(ema, sample_step_sec=1)
    fixed = realized_vol_per_sec(ema, sample_step_sec=30)
    on_raw = realized_vol_per_sec(raw, sample_step_sec=30)
    assert naive is not None and fixed is not None and on_raw is not None

    # Raw series: the estimator is accurate. This is the path production uses -
    # volatility comes from `spot`, precisely because it is not smoothed.
    assert abs(annualise(on_raw) - 0.35) / 0.35 < 0.25, annualise(on_raw)

    # EMA series: one-second differencing is catastrophically low, and
    # resampling recovers most of the gap but still understates. Since
    # understating volatility makes the prior OVERCONFIDENT, production never
    # estimates from the EMA - see `agents.server._series`.
    assert annualise(naive) < 0.35 * 0.4, annualise(naive)
    assert annualise(fixed) > annualise(naive) * 2.0
    assert annualise(fixed) < annualise(on_raw)


def test_realized_vol_refuses_thin_data() -> None:
    assert realized_vol_per_sec([]) is None
    assert realized_vol_per_sec([PricePoint(1, 100.0), PricePoint(2, 101.0)]) is None


def test_resample_snaps_to_grid() -> None:
    pts = [PricePoint(1000 + i, 100.0 + i) for i in range(120)]
    grid = resample(pts, 30)
    assert 4 <= len(grid) <= 5
    assert all(b.ts > a.ts for a, b in zip(grid, grid[1:]))


def _headline(sentiment: float, age: int = 0, salience: float = 1.0) -> Headline:
    return Headline(
        id=f"h{sentiment}{age}", source="test", title="t", url="https://x/y",
        published_at=int(time.time()) - age, assets=["BTC"],
        sentiment=sentiment, salience=salience, credibility=1.0,
    )


def test_evidence_signs_and_cap() -> None:
    bull, _ = evidence_for([_headline(1.0)], "BTC", 900, 900)
    bear, _ = evidence_for([_headline(-1.0)], "BTC", 900, 900)
    assert bull > 0 > bear and approx(bull, -bear, 1e-9)

    # Twenty maximally bullish headlines must not exceed the cap.
    flood, _ = evidence_for([_headline(1.0, age=i) for i in range(20)], "BTC", 900, 900)
    assert flood <= S.evidence_cap + 1e-9, flood


def test_evidence_decays_with_age() -> None:
    fresh, _ = evidence_for([_headline(1.0, age=0)], "BTC", 900, 900)
    stale, _ = evidence_for([_headline(1.0, age=7200)], "BTC", 900, 900)
    half, _ = evidence_for(
        [_headline(1.0, age=int(S.evidence_half_life_sec))], "BTC", 900, 900
    )
    assert fresh > half > stale
    assert approx(half, fresh / 2, 1e-9)          # one half-life
    assert approx(stale, fresh * 0.5 ** 4, 1e-9)  # 7200s == four half-lives


def test_news_stops_mattering_near_expiry() -> None:
    """A headline cannot move a window that is about to close."""
    early, _ = evidence_for([_headline(1.0)], "BTC", 900, 900)
    late, _ = evidence_for([_headline(1.0)], "BTC", 1, 900)
    assert early > late
    assert late < early * 0.05
    none, _ = evidence_for([_headline(1.0)], "BTC", 0, 900)
    assert none == 0.0


def test_evidence_ignores_other_assets() -> None:
    total, items = evidence_for([_headline(1.0)], "ETH", 900, 900)
    assert total == 0.0 and items == []


def test_posterior_is_prior_plus_evidence_in_log_odds() -> None:
    # Long enough to survive the 30s resampling grid the estimator uses.
    random.seed(3)
    price = 79_000.0
    vol = []
    for i in range(1800):
        price *= math.exp(SIGMA_1S * random.gauss(0, 1))
        vol.append(PricePoint(1_700_000_000 + i, price))
    f = build_forecast(
        asset="BTC", open_price=79_000.0, spot=79_050.0, seconds_left=600,
        window_sec=900, headlines=[_headline(0.8)], vol_points=vol,
    )
    assert approx(sigmoid(logit(f.prior) + f.evidence_log_odds), f.posterior, 1e-5)
    assert f.evidence_log_odds > 0 and f.posterior > f.prior
    assert f.vol_source == "realized"
    assert len(f.evidence) == 1


def test_forecast_falls_back_when_vol_data_is_thin() -> None:
    f = build_forecast(
        asset="BTC", open_price=79_000.0, spot=79_000.0, seconds_left=600,
        window_sec=900, headlines=[], vol_points=[],
    )
    assert f.vol_source == "fallback"
    assert approx(f.annual_vol, S.fallback_annual_vol, 1e-3)
    assert f.evidence_log_odds == 0.0


def test_posterior_respects_bounds() -> None:
    f = build_forecast(
        asset="BTC", open_price=79_000.0, spot=99_000.0, seconds_left=1,
        window_sec=900, headlines=[], vol_points=[],
    )
    assert f.posterior <= S.prob_ceil
    f2 = build_forecast(
        asset="BTC", open_price=99_000.0, spot=79_000.0, seconds_left=1,
        window_sec=900, headlines=[], vol_points=[],
    )
    assert f2.posterior >= S.prob_floor


def _fc(p: float) -> object:
    f = build_forecast(
        asset="BTC", open_price=100.0, spot=100.0, seconds_left=600,
        window_sec=900, headlines=[], vol_points=[],
    )
    f.posterior = p
    return f


def test_decide_requires_clearing_the_touch_not_the_mid() -> None:
    # Posterior 0.60, mid 0.55, but the ask is 0.62 - lifting it is negative EV.
    intent = decide(_fc(0.60), best_bid=0.48, best_ask=0.62, edge_threshold=0.04)
    assert intent.action == "quote", intent

    # Ask drops to 0.50: now worth taking.
    assert decide(_fc(0.60), 0.48, 0.50, edge_threshold=0.04).action == "take_yes"
    # Bid far above the posterior: sell YES exposure by buying NO.
    assert decide(_fc(0.30), 0.50, 0.55, edge_threshold=0.04).action == "take_no"
    # Empty book is the mint-a-pair cold start.
    assert decide(_fc(0.50), None, None).action == "quote"


def run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    run()
