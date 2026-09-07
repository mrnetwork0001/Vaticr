"""Durability tests for the forecast commitment log.

The whole auditability claim is "the prediction was written down before the
outcome existed". A commitment that is dropped by a dedupe, an overwrite or a
rewrite is indistinguishable from never having forecast at all - so these tests
care less about happy-path reads than about what survives a second writer, a
torn line and a full-file rewrite.

Every test runs against a temporary state directory: `agents.store.state_path`
is redirected, which moves both the data file and the flock sidecar, so the
real `.vaticr/forecasts.jsonl` is never touched.

Runs standalone (`python -m tests.test_store`) or under pytest.
"""

from __future__ import annotations

import glob
import os
import tempfile
from contextlib import contextmanager
from typing import Iterator

from agents import store
from agents.schemas import ForecastCommitment


@contextmanager
def temp_store() -> Iterator[str]:
    """Point the store at a throwaway directory and hand back the data path."""
    original = store.state_path
    with tempfile.TemporaryDirectory() as root:
        store.state_path = lambda *parts: os.path.join(root, *parts)  # type: ignore[assignment]
        try:
            yield os.path.join(root, "forecasts.jsonl")
        finally:
            store.state_path = original  # type: ignore[assignment]


def commitment(market_id: str, posterior: float = 0.62) -> ForecastCommitment:
    return ForecastCommitment(
        market_id=market_id, symbol=f"BTC 900s @{market_id}", asset="BTC",
        posterior=posterior, prior=0.55, committed_at=1_700_000_000,
        expiry=1_700_000_900, headline_ids=["h1"],
    )


def test_record_appends_and_reads_back() -> None:
    with temp_store():
        assert store.load_all() == []  # a missing file is empty, not an error
        assert store.record(commitment("0xaa")) is True
        got = store.load_all()
        assert len(got) == 1
        assert got[0].market_id == "0xaa"
        assert got[0].outcome is None and got[0].brier is None


def test_record_dedupes_by_market_id() -> None:
    """One window, one commitment.

    The server commits on every poll while a window is open. Without the dedupe
    the log would hold dozens of rows for the same market, and calibration would
    weight that window dozens of times - the loudest market, not the best
    forecast, would decide the Brier score.
    """
    with temp_store():
        assert store.record(commitment("0xaa", posterior=0.62)) is True
        assert store.record(commitment("0xaa", posterior=0.71)) is False
        records = store.load_all()
        assert len(records) == 1
        assert records[0].posterior == 0.62  # the FIRST view is the commitment


def test_resolve_fills_the_outcome() -> None:
    with temp_store():
        store.record(commitment("0xaa", posterior=0.8))
        assert store.resolve("0xaa", "up", 1_700_000_950, 0.04, "0xq1") is True
        r = store.load_all()[0]
        assert r.outcome == "up"
        assert r.resolved_at == 1_700_000_950
        assert r.brier == 0.04
        assert r.oracle_question_id == "0xq1"


def test_resolve_never_rewrites_a_settled_record() -> None:
    """Settlement is final; a second sweep must not restate history."""
    with temp_store():
        store.record(commitment("0xaa"))
        assert store.resolve("0xaa", "up", 1_700_000_950, 0.04) is True
        assert store.resolve("0xaa", "down", 1_700_009_999, 0.99) is False
        r = store.load_all()[0]
        assert r.outcome == "up" and r.brier == 0.04


def test_resolve_of_an_unknown_market_is_a_no_op() -> None:
    with temp_store():
        store.record(commitment("0xaa"))
        assert store.resolve("0xdead", "up", 1_700_000_950, 0.1) is False
        assert store.load_all()[0].outcome is None


def test_resolve_matches_market_id_case_insensitively() -> None:
    """Addresses arrive checksummed from one surface and lowercased from another."""
    with temp_store():
        store.record(commitment("0xAaBb"))
        assert store.resolve("0xaabb", "down", 1_700_000_950, 0.36) is True
        assert store.load_all()[0].outcome == "down"


def test_a_voided_market_records_no_brier() -> None:
    """Nothing was predicted about a feed outage, so nothing is scored."""
    with temp_store():
        store.record(commitment("0xaa"))
        assert store.resolve("0xaa", "void", 1_700_000_950, None) is True
        r = store.load_all()[0]
        assert r.outcome == "void" and r.brier is None


def test_pending_returns_only_unresolved_records() -> None:
    with temp_store():
        for mid in ("0xaa", "0xbb", "0xcc"):
            store.record(commitment(mid))
        store.resolve("0xbb", "up", 1_700_000_950, 0.04)
        ids = sorted(r.market_id for r in store.pending())
        assert ids == ["0xaa", "0xcc"]


def test_a_torn_final_line_costs_one_record_not_the_file() -> None:
    """A crash mid-append leaves a half-written JSON line.

    Everything before it is still a valid commitment and must still be read.
    Treating the file as corrupt would throw away the entire forecast history
    to save one row.
    """
    with temp_store() as path:
        store.record(commitment("0xaa"))
        store.record(commitment("0xbb"))
        before = os.path.getsize(path)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write('{"market_id": "0xcc", "symbol": "BTC 900s @')  # torn mid-write

        records = store.load_all()
        assert [r.market_id for r in records] == ["0xaa", "0xbb"]
        # A read is non-destructive: the torn bytes are skipped, not repaired.
        assert os.path.getsize(path) > before


def test_rewrite_keeps_every_other_record_and_leaves_no_temp_file() -> None:
    """Resolving one market rewrites the whole file; the rest must come back.

    `_rewrite` writes a sibling temp file and `os.replace`s it in. A bug in the
    round-trip - a dropped record, a field lost to serialisation - would be
    invisible until calibration silently scored fewer windows than were
    committed.
    """
    with temp_store() as path:
        for mid in ("0xaa", "0xbb", "0xcc"):
            store.record(commitment(mid, posterior=0.5 + len(mid) / 100))
        store.resolve("0xbb", "down", 1_700_000_950, 0.09, "0xq2")

        records = {r.market_id: r for r in store.load_all()}
        assert sorted(records) == ["0xaa", "0xbb", "0xcc"]
        assert records["0xbb"].outcome == "down" and records["0xbb"].brier == 0.09
        # Untouched neighbours keep every field, not just their id.
        assert records["0xaa"].outcome is None
        assert records["0xaa"].headline_ids == ["h1"]
        assert records["0xcc"].prior == 0.55
        assert glob.glob(f"{path}.*.tmp") == []  # replace happened, nothing orphaned


def test_resolve_many_applies_a_whole_batch_in_one_pass() -> None:
    """The resolver scores a sweep at a time; the batch must be all-or-nothing.

    Doing it as N separate `resolve()` calls rewrote the file N times and left N
    windows in which a crash could half-apply the sweep.
    """
    with temp_store():
        for mid in ("0xaa", "0xbb", "0xcc"):
            store.record(commitment(mid))
        hits = store.resolve_many(
            {
                "0xaa": {"outcome": "up", "resolved_at": 1, "brier": 0.04},
                "0xbb": {"outcome": "down", "resolved_at": 2, "brier": 0.16},
                "0xzz": {"outcome": "up", "resolved_at": 3, "brier": 0.0},  # unknown
            }
        )
        assert hits == 2
        by_id = {r.market_id: r for r in store.load_all()}
        assert by_id["0xaa"].outcome == "up"
        assert by_id["0xbb"].outcome == "down"
        assert by_id["0xcc"].outcome is None
        assert store.resolve_many({}) == 0  # empty batch touches nothing


def run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    run()
