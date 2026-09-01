"""Durable record of what Vaticr predicted, so it can be scored later.

A forecast that is never written down cannot be audited. Every commitment is
appended before its window settles; the resolver fills in the outcome
afterwards. JSON Lines keeps it append-friendly, human-readable and free of a
database dependency.
"""

from __future__ import annotations

import json
import os
import threading

from .config import state_path
from .schemas import ForecastCommitment

_LOCK = threading.Lock()
_FILE = "forecasts.jsonl"


def _path() -> str:
    return state_path(_FILE)


def load_all() -> list[ForecastCommitment]:
    path = _path()
    if not os.path.exists(path):
        return []
    out: list[ForecastCommitment] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(ForecastCommitment.model_validate_json(line))
            except ValueError:
                continue  # skip a torn final line rather than lose the file
    return out


def _rewrite(records: list[ForecastCommitment]) -> None:
    path = _path()
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(r.model_dump_json() + "\n")
    os.replace(tmp, path)  # atomic


def record(commitment: ForecastCommitment) -> bool:
    """Append a commitment. Returns False if this market was already recorded."""
    with _LOCK:
        existing = load_all()
        if any(r.market_id == commitment.market_id for r in existing):
            return False
        with open(_path(), "a", encoding="utf-8") as fh:
            fh.write(commitment.model_dump_json() + "\n")
        return True


def resolve(
    market_id: str,
    outcome: str,
    resolved_at: int,
    brier: float | None,
    oracle_question_id: str | None = None,
) -> bool:
    """Fill in a settled outcome. Returns False when nothing matched."""
    with _LOCK:
        records = load_all()
        hit = False
        for r in records:
            if r.market_id != market_id or r.outcome is not None:
                continue
            r.outcome = outcome  # type: ignore[assignment]
            r.resolved_at = resolved_at
            r.brier = brier
            if oracle_question_id:
                r.oracle_question_id = oracle_question_id
            hit = True
        if hit:
            _rewrite(records)
        return hit


def pending() -> list[ForecastCommitment]:
    return [r for r in load_all() if r.outcome is None]
