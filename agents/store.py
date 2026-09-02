"""Durable record of what Vaticr predicted, so it can be scored later.

A forecast that is never written down cannot be audited. Every commitment is
appended before its window settles; the resolver fills in the outcome
afterwards. JSON Lines keeps it append-friendly, human-readable and free of a
database dependency.

The file is shared by *separate processes* — the FastAPI server commits
forecasts while `python -m agents.resolver` rewrites the same file to fill in
outcomes — so every read-modify-write here is serialised with an OS-level
`flock`, not just a `threading.Lock`. See `_exclusive`.
"""

from __future__ import annotations

import fcntl
import os
import threading
from contextlib import contextmanager
from typing import Iterator

from .config import state_path
from .schemas import ForecastCommitment

# In-process ordering only. It was never sufficient on its own: a threading
# lock is invisible to any other interpreter, and the two writers of this file
# are two processes. Kept because it is cheaper than a syscall for the common
# same-process contention, and because it makes the flock hand-off fair between
# a FastAPI worker's threads.
_LOCK = threading.Lock()
_FILE = "forecasts.jsonl"
# The flock is taken on a sidecar, never on forecasts.jsonl itself: `_rewrite`
# swaps the data file for a new inode via os.replace, and a lock held on the
# old inode would be silently orphaned by that swap — the next writer would
# lock the *new* file and the two would overlap anyway.
_LOCK_FILE = "forecasts.jsonl.lock"


def _path() -> str:
    return state_path(_FILE)


@contextmanager
def _flocked(mode: int) -> Iterator[None]:
    """Hold `mode` (LOCK_EX or LOCK_SH) on the sidecar for the block's duration.

    Cross-process mutual exclusion. Without it, `record()`'s append could land
    between `resolve()`'s `load_all()` and its `os.replace()`, and the replace
    would drop the just-appended commitment on the floor. Losing a committed
    forecast is not a cosmetic bug: the entire auditability claim is "we wrote
    the prediction down before the outcome existed", and a silently dropped
    line is indistinguishable from never having predicted at all.
    """
    with open(state_path(_LOCK_FILE), "a+", encoding="utf-8") as fh:
        fcntl.flock(fh, mode)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


@contextmanager
def _exclusive() -> Iterator[None]:
    """Serialise a full read-modify-write against every thread and process."""
    with _LOCK, _flocked(fcntl.LOCK_EX):
        yield


def _read() -> list[ForecastCommitment]:
    """Parse the file. Callers hold the lock; `load_all` is the public door."""
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


def load_all() -> list[ForecastCommitment]:
    # Shared, not exclusive: concurrent readers are harmless, but a reader that
    # took no lock at all could observe a half-written append from another
    # process. (That line would be skipped as torn, i.e. silently missing from
    # a calibration report, which is exactly the kind of quiet loss this
    # module exists to prevent.)
    with _flocked(fcntl.LOCK_SH):
        return _read()


def _rewrite(records: list[ForecastCommitment]) -> None:
    path = _path()
    tmp = f"{path}.{os.getpid()}.tmp"  # per-process name; the lock does the rest
    with open(tmp, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(r.model_dump_json() + "\n")
        fh.flush()
        os.fsync(fh.fileno())  # the replace is only atomic if the data landed
    os.replace(tmp, path)  # atomic


def record(commitment: ForecastCommitment) -> bool:
    """Append a commitment. Returns False if this market was already recorded."""
    with _exclusive():
        existing = _read()
        if any(r.market_id == commitment.market_id for r in existing):
            return False
        with open(_path(), "a", encoding="utf-8") as fh:
            fh.write(commitment.model_dump_json() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return True


def resolve_many(updates: dict[str, dict]) -> int:
    """Fill in several settled outcomes in ONE read-modify-write.

    The resolver scores a whole batch per sweep. Doing that as N separate
    `resolve()` calls rewrote the entire file N times and left N windows in
    which a crash could half-apply the batch; one pass under one lock is both
    cheaper and atomic. `updates` maps market_id -> {outcome, resolved_at,
    brier, oracle_question_id}. Returns how many records were filled in.
    """
    if not updates:
        return 0
    keyed = {k.lower(): v for k, v in updates.items()}
    with _exclusive():
        records = _read()
        hits = 0
        for r in records:
            if r.outcome is not None:
                continue
            patch = keyed.get(r.market_id.lower())
            if patch is None:
                continue
            r.outcome = patch["outcome"]  # type: ignore[assignment]
            r.resolved_at = patch.get("resolved_at")
            r.brier = patch.get("brier")
            if patch.get("oracle_question_id"):
                r.oracle_question_id = patch["oracle_question_id"]
            hits += 1
        if hits:
            _rewrite(records)
        return hits


def resolve(
    market_id: str,
    outcome: str,
    resolved_at: int,
    brier: float | None,
    oracle_question_id: str | None = None,
) -> bool:
    """Fill in a settled outcome. Returns False when nothing matched."""
    return resolve_many(
        {
            market_id: {
                "outcome": outcome,
                "resolved_at": resolved_at,
                "brier": brier,
                "oracle_question_id": oracle_question_id,
            }
        }
    ) > 0


def pending() -> list[ForecastCommitment]:
    return [r for r in load_all() if r.outcome is None]
