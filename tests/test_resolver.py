"""Tests for the settlement audit and the calibration score.

Nothing here touches the network. `SettlementAudit` is handed fabricated
`MarketRow`s and reference prices, and `calibration()` reads a temporary
commitment log - so the audit's judgement and the Brier arithmetic are pinned
independently of whatever the testnet indexer happens to be serving.

These two surfaces are the project's honesty claim. If the audit calls a
disagreement a "match", nobody learns the chain and our reconstruction diverged;
if the Brier maths is wrong, the dashboard reports skill Vaticr does not have.

Runs standalone (`python -m tests.test_resolver`) or under pytest.
"""

from __future__ import annotations

import os
import tempfile
from contextlib import contextmanager
from typing import Iterator

from agents import store
from agents.resolver import INCONCLUSIVE_BPS, Resolver, SettlementAudit, brier
from agents.schemas import ForecastCommitment
from agents.somnia import MarketRow

RECEIPT = "https://dev.oracle.somnia.host/questions/0xq?view=graph"


def approx(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(a - b) <= tol


@contextmanager
def temp_store() -> Iterator[None]:
    """Redirect the commitment log (and its flock sidecar) to a scratch dir."""
    original = store.state_path
    with tempfile.TemporaryDirectory() as root:
        store.state_path = lambda *parts: os.path.join(root, *parts)  # type: ignore[assignment]
        try:
            yield
        finally:
            store.state_path = original  # type: ignore[assignment]


def market(
    *, winning_outcome: int | None = 0, voided: bool = False, expiry: int = 1_700_000_900
) -> MarketRow:
    """A settled BTC 15-minute window, as the indexer would return it."""
    return MarketRow(
        market_id="0xaa", asset="BTC", interval_sec=900,
        trading_start=expiry - 900, expiry=expiry, status="RESOLVED",
        winning_outcome=winning_outcome, voided=voided, finalized=True,
        oracle_question_id="0xq", resolved_at=expiry + 4,
        venue_id="0x6797", quote_volume=1234.5, trade_count=7,
    )


def audit(open_ref: float | None, close_ref: float | None, **kw) -> SettlementAudit:
    return SettlementAudit(market(**kw), open_ref, close_ref, RECEIPT)


def scored_record(
    market_id: str, posterior: float, outcome: str | None, brier_value: float | None
) -> ForecastCommitment:
    return ForecastCommitment(
        market_id=market_id, symbol=f"BTC 900s @{market_id}", asset="BTC",
        posterior=posterior, prior=0.5, committed_at=1_700_000_000,
        expiry=1_700_000_900, outcome=outcome,  # type: ignore[arg-type]
        resolved_at=1_700_000_950 if outcome else None, brier=brier_value,
    )


def seed(records: list[ForecastCommitment]) -> None:
    for r in records:
        store.record(r)


# --- Brier ------------------------------------------------------------------


def test_brier_scores_a_binary_forecast() -> None:
    """0.25 is the coin flip; certainty and being right is 0, certainty and
    being wrong is 1."""
    assert approx(brier(0.8, "up"), 0.04)
    assert approx(brier(0.8, "down"), 0.64)
    assert approx(brier(0.5, "up"), 0.25)
    assert approx(brier(0.5, "down"), 0.25)
    assert approx(brier(1.0, "up"), 0.0)
    assert approx(brier(0.0, "up"), 1.0)


def test_brier_excludes_a_voided_market() -> None:
    """A void is a feed outage, not a forecasting error.

    Scoring it as an outcome would punish a correct 0.95 with a 0.9025 the model
    had no way to avoid - the window never resolved on price at all. `None`
    means "not scored", and calibration drops it rather than averaging it in.
    """
    assert brier(0.95, "void") is None
    assert brier(0.05, "void") is None


# --- SettlementAudit --------------------------------------------------------


def test_derived_outcome_treats_the_boundary_as_a_yes() -> None:
    """"Closes at or above its opening price" - equality is an Up."""
    assert audit(100_000.0, 100_050.0).derived == "up"
    assert audit(100_000.0, 99_950.0).derived == "down"
    assert audit(100_000.0, 100_000.0).derived == "up"


def test_a_missing_reference_is_unverifiable_not_a_mismatch() -> None:
    """The feed can have no tick near a timestamp. Silence is not disagreement."""
    assert audit(None, 100_050.0).derived is None
    assert audit(100_000.0, None).verdict == "unverifiable"
    assert audit(None, None).margin_bps is None


def test_margin_is_signed_basis_points_off_the_open() -> None:
    assert approx(audit(100_000.0, 100_050.0).margin_bps, 5.0, 1e-6)
    assert approx(audit(100_000.0, 99_950.0).margin_bps, -5.0, 1e-6)
    # A zero open would divide by zero; guarded rather than raised.
    assert audit(0.0, 100.0).margin_bps is None


def test_agreement_with_the_chain_is_a_match() -> None:
    up = audit(100_000.0, 100_500.0, winning_outcome=0)
    down = audit(100_000.0, 99_500.0, winning_outcome=1)
    assert up.market.outcome == "up" and up.verdict == "match"
    assert down.market.outcome == "down" and down.verdict == "match"


def test_a_void_is_reported_as_voided_whatever_the_price_did() -> None:
    """A voided window did not settle on price, so there is nothing to check."""
    a = audit(100_000.0, 101_000.0, winning_outcome=None, voided=True)
    assert a.market.outcome == "void"
    assert a.derived == "up"      # the price still moved
    assert a.verdict == "voided"  # but the settlement was not about the price


def test_a_real_disagreement_is_a_mismatch() -> None:
    """Chain says Down, the feed says the window closed 50bp UP. Shout."""
    a = audit(100_000.0, 100_500.0, winning_outcome=1)
    assert a.verdict == "MISMATCH"


def test_a_hairline_disagreement_is_inconclusive_not_a_mismatch() -> None:
    """Under ~1bp our reconstruction has run out, and says so.

    The oracle settles on its own sampled tick; we recover the reference from
    the public feed by timestamp, and the two can differ by a tick. On a window
    that moved 0.009% that difference flips the sign - so reporting MISMATCH
    there would cry wolf on every near-flat window and bury a real divergence.
    """
    assert INCONCLUSIVE_BPS == 1.0
    # +0.9bp: we derive Up, the chain says Down - inside our resolution.
    assert audit(100_000.0, 100_009.0, winning_outcome=1).verdict == "inconclusive"
    # -0.9bp the other way, same call.
    assert audit(100_000.0, 99_991.0, winning_outcome=0).verdict == "inconclusive"
    # 1.1bp is outside it: now the disagreement is real.
    assert audit(100_000.0, 100_011.0, winning_outcome=1).verdict == "MISMATCH"
    assert audit(100_000.0, 99_989.0, winning_outcome=0).verdict == "MISMATCH"


def test_agreement_stays_a_match_however_thin_the_margin() -> None:
    """The inconclusive band only softens disagreements, never verifications."""
    a = audit(100_000.0, 100_001.0, winning_outcome=0)
    assert abs(a.margin_bps) < INCONCLUSIVE_BPS
    assert a.verdict == "match"


def test_as_dict_carries_the_evidence_a_reader_needs() -> None:
    row = audit(100_000.0, 100_500.0, winning_outcome=1).as_dict()
    assert row["onchain_outcome"] == "down" and row["derived_outcome"] == "up"
    assert row["verdict"] == "MISMATCH"
    assert approx(row["margin_bps"], 50.0, 1e-6)
    assert row["receipt_url"] == RECEIPT  # the audit is checkable by hand
    assert row["oracle_question_id"] == "0xq"


# --- calibration ------------------------------------------------------------


def test_calibration_of_an_empty_log_claims_nothing() -> None:
    with temp_store():
        report = Resolver().calibration()
        assert report.scored == 0
        assert report.brier_score is None and report.skill is None
        assert report.baseline_brier == 0.25


def test_calibration_averages_brier_and_reports_skill() -> None:
    with temp_store():
        seed(
            [
                scored_record("0x1", 0.9, "up", 0.01),
                scored_record("0x2", 0.7, "up", 0.09),
                scored_record("0x3", 0.3, "down", 0.09),
                scored_record("0x4", 0.1, "down", 0.01),
            ]
        )
        report = Resolver().calibration()
        assert report.scored == 4
        assert approx(report.brier_score, 0.05, 1e-9)   # (0.01+0.09+0.09+0.01)/4
        assert approx(report.skill, 0.8, 1e-9)          # 1 - 0.05/0.25
        assert approx(report.accuracy, 1.0, 1e-9)       # every side called right


def test_skill_goes_negative_when_the_model_is_confidently_wrong() -> None:
    """Skill is not clamped: worse than a coin flip must read as worse."""
    with temp_store():
        seed([scored_record("0x1", 0.8, "down", 0.64)])
        report = Resolver().calibration()
        assert approx(report.skill, 1.0 - 0.64 / 0.25, 1e-9)
        assert report.skill < 0
        assert report.accuracy == 0.0


def test_voids_and_pendings_are_counted_but_never_scored() -> None:
    """Only settled, scored windows enter the Brier average."""
    with temp_store():
        seed(
            [
                scored_record("0x1", 0.9, "up", 0.01),
                scored_record("0x2", 0.9, "void", None),
                scored_record("0x3", 0.9, None, None),
                # Settled but never scored - it must not count as a free 0.0.
                scored_record("0x4", 0.9, "up", None),
            ]
        )
        report = Resolver().calibration()
        assert report.scored == 1
        assert report.voided == 1
        assert report.pending == 1
        assert approx(report.brier_score, 0.01, 1e-9)


def test_calibration_buckets_are_half_open_with_a_closed_top() -> None:
    """A reliability diagram is only readable if every forecast lands once.

    Edges are [lo, hi) so 0.6 belongs to 0.6-0.8, not 0.4-0.6; the top bucket
    closes at 1.0 so a certainty is not silently dropped from the report.
    """
    with temp_store():
        seed(
            [
                scored_record("0x1", 0.0, "down", 0.0),
                scored_record("0x2", 0.6, "up", 0.16),
                scored_record("0x3", 1.0, "up", 0.0),
            ]
        )
        buckets = {b["range"]: b for b in Resolver().calibration().buckets}
        assert set(buckets) == {"0.0-0.2", "0.6-0.8", "0.8-1.0"}  # empties omitted
        assert buckets["0.0-0.2"]["count"] == 1
        assert buckets["0.6-0.8"]["count"] == 1
        assert buckets["0.8-1.0"]["count"] == 1


def test_bucket_reports_mean_forecast_against_observed_rate() -> None:
    """The whole point: does "70%" actually happen 70% of the time?"""
    with temp_store():
        # Four forecasts in the 0.6-0.8 bucket, three of which came in Up.
        seed(
            [
                scored_record("0x1", 0.7, "up", 0.09),
                scored_record("0x2", 0.7, "up", 0.09),
                scored_record("0x3", 0.7, "up", 0.09),
                scored_record("0x4", 0.7, "down", 0.49),
            ]
        )
        bucket = Resolver().calibration().buckets[0]
        assert bucket["range"] == "0.6-0.8"
        assert bucket["count"] == 4
        assert approx(bucket["mean_forecast"], 0.7, 1e-9)
        assert approx(bucket["observed_up_rate"], 0.75, 1e-9)


def run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    run()
