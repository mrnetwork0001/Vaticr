"""Subsystem 4 — the Autonomous Resolution & Settlement Agent.

(Numbered to match `docs/ARCHITECTURE.md` §4, after scout, the Bayesian engine
and the bot.)

What this agent is *not*: a thing that resolves markets from news payloads.
DreamDEX event contracts settle themselves. The settlement question is
scheduled on the OracleHub when the market is created, with the gas for its own
resolution reserved up front, and Somnia's on-chain reactivity delivers the
answer straight to the hub's callback at expiry. `BinaryMarketsModule` is the
only address a market trusts as its settler. No keeper, no cron, no operator.

So this agent does the three jobs that *are* still unowned:

1. **Audit.** Independently recompute every settlement from the public oracle
   feed and compare it to the on-chain winner, and surface the receipt URL that
   shows each price source that voted. A settlement nobody checks is a
   settlement nobody can trust.

2. **Score.** Every forecast is committed to disk *before* its window closes,
   then scored with the Brier score once the oracle speaks. This is the honest
   measure of whether Vaticr's probabilities mean anything — a model that
   cannot beat 0.25 is a coin flip with extra steps.

3. **Backstop.** Watch for windows the oracle has not answered inside the
   settlement window and name the permissionless escape hatches that unstick
   them: `pokeOracle(questionId)` pulls a posted answer, and after the
   settlement window lapses anyone may call `voidExpired()` to release funds at
   0.5 a side. Execution lives in `bot/src/backstop.ts`, which holds the
   signer.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import time
from typing import Any

import httpx

from .config import Settings, get_settings
from .schemas import CalibrationReport, ForecastCommitment
from .somnia import MARKET_FIELDS, MarketRow, SomniaReader, _row
from . import store

log = logging.getLogger("vaticr.resolver")


# Below this margin an off-chain reconstruction cannot honestly adjudicate a
# window. The oracle settles on its own sampled tick; we recover the reference
# from the public feed by timestamp, and the two can differ by a tick. On a
# window that moved 0.005% that difference flips the sign, so a disagreement
# here says our resolution ran out — not that the chain is wrong.
INCONCLUSIVE_BPS = 1.0

# How far back reconciliation will reach for a settled row, and in what steps.
#
# The venue mints roughly six windows per five-minute cadence — about 70 settled
# rows an hour, measured against the testnet indexer — so the old single
# `limit=200` page reached back barely three hours. Every forecast older than
# that stayed pending forever and the Brier record was silently truncated to
# whatever the last sweep happened to catch.
#
# The indexer orders newest-first and takes only a lower time bound, so there is
# no cursor to advance: the next page is a *wider* page. Widening doubles until
# the oldest pending forecast is inside the window, and stops at MAX_ROWS
# (~45h of this venue's cadence) so a stuck-pending record from a dead venue
# cannot turn every sweep into an unbounded scan.
RECONCILE_PAGE = 200
RECONCILE_MAX_ROWS = 3_200


class SettlementAudit:
    """One market's settlement, checked against the public price feed."""

    def __init__(
        self, market: MarketRow, open_ref: float | None, close_ref: float | None,
        receipt_url: str | None,
    ) -> None:
        self.market = market
        self.open_ref = open_ref
        self.close_ref = close_ref
        self.receipt_url = receipt_url

    @property
    def derived(self) -> str | None:
        if self.open_ref is None or self.close_ref is None:
            return None
        # "closes at or above its opening price" — the boundary is a YES.
        return "up" if self.close_ref >= self.open_ref else "down"

    @property
    def margin_bps(self) -> float | None:
        """How far the window closed from its own open, in basis points."""
        if not self.open_ref or self.close_ref is None:
            return None
        return (self.close_ref - self.open_ref) / self.open_ref * 10_000

    @property
    def verdict(self) -> str:
        if self.market.outcome == "void":
            return "voided"
        if self.derived is None:
            return "unverifiable"
        if self.derived == self.market.outcome:
            return "match"
        margin = self.margin_bps
        if margin is not None and abs(margin) < INCONCLUSIVE_BPS:
            # Decided by less than our reconstruction can resolve.
            return "inconclusive"
        return "MISMATCH"

    def as_dict(self) -> dict:
        margin = self.margin_bps
        return {
            "market_id": self.market.market_id,
            "symbol": self.market.symbol,
            "asset": self.market.asset,
            "expiry": self.market.expiry,
            "onchain_outcome": self.market.outcome,
            "derived_outcome": self.derived,
            "open_reference": self.open_ref,
            "close_reference": self.close_ref,
            "margin_bps": None if margin is None else round(margin, 3),
            "verdict": self.verdict,
            "oracle_question_id": self.market.oracle_question_id,
            "receipt_url": self.receipt_url,
        }


def brier(probability_up: float, outcome: str) -> float | None:
    """Brier score for a single binary forecast. Lower is better; 0.25 is a coin flip.

    A voided market is not a forecasting error — nothing was predicted about a
    feed outage — so it is excluded from scoring rather than counted as a loss.
    """
    if outcome == "void":
        return None
    actual = 1.0 if outcome == "up" else 0.0
    return (probability_up - actual) ** 2


class Resolver:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.reader = SomniaReader(self.settings)

    # -- 1. audit ------------------------------------------------------------
    async def audit_settled(
        self, client: httpx.AsyncClient, venue_id: str | None = None, limit: int = 12
    ) -> list[SettlementAudit]:
        markets = await self.reader.settled_markets(
            client, venue_id=venue_id, limit=limit
        )
        audits: list[SettlementAudit] = []
        for m in markets:
            open_ref, close_ref = await asyncio.gather(
                self.reader.reference_at(client, m.asset, m.trading_start),
                self.reader.reference_at(client, m.asset, m.expiry),
            )
            audits.append(
                SettlementAudit(
                    m, open_ref, close_ref,
                    self.reader.oracle_receipt_url(m.oracle_question_id),
                )
            )
        return audits

    # -- 2. score ------------------------------------------------------------
    async def _settled_covering(
        self, client: httpx.AsyncClient, venue_id: str | None, oldest: int, floor: int
    ) -> list[MarketRow]:
        """Settled rows reaching back past `oldest`, widening the page until they do."""
        limit = RECONCILE_PAGE
        while True:
            rows = await self.reader.settled_markets(
                client, venue_id=venue_id, limit=limit, since=floor
            )
            reach = min((m.expiry for m in rows), default=floor)
            covered = reach <= oldest
            # A short page means the filter's entire result fit, so there is
            # nothing older to fetch and widening again re-reads the same rows.
            exhausted = len(rows) < limit
            if covered or exhausted or limit >= RECONCILE_MAX_ROWS:
                if not (covered or exhausted):
                    log.warning(
                        "resolver: settled scan capped at %d rows, reaching back "
                        "only to %d — forecasts older than that stay pending",
                        limit, reach,
                    )
                log.info(
                    "resolver: settled window = %d row(s) back to %d "
                    "(oldest pending %d)",
                    len(rows), reach, oldest,
                )
                return rows
            limit = min(limit * 2, RECONCILE_MAX_ROWS)

    async def _voided_markets(
        self, client: httpx.AsyncClient, venue_id: str | None, since: int,
        limit: int = RECONCILE_MAX_ROWS,
    ) -> list[MarketRow]:
        """Voided windows, which `settled_markets` structurally cannot return.

        A void carries `winningOutcome: null` — the same shape the indexer uses
        for "not settled yet" — and `settled_markets` filters
        `winningOutcome: {_is_null: false}`. So a voided market was never in the
        reconcile set: its forecast stayed pending forever and `brier()`'s void
        branch was dead code. Confirmed against the testnet indexer, which
        returns rows with `voided: true` and a null winner.

        One page is enough where the settled scan needs several: voids are the
        rare case — five rows across the whole testnet indexer — so a single
        request at the same row cap cannot truncate the way a 200-row page of
        settlements does.

        The right home for this is `settled_markets` itself; `somnia.py` is
        owned elsewhere, so the query lives here until that lands.
        """
        where = [
            'marketType: {_eq: "BINARY"}',
            "expiry: {_gte: $since}",
            "voided: {_eq: true}",
        ]
        signature = "$since: numeric!, $limit: Int!"
        variables: dict[str, Any] = {"since": since, "limit": limit}
        if venue_id:
            where.append("venueId: {_eq: $venue}")
            signature += ", $venue: String!"
            variables["venue"] = venue_id
        query = f"""
        query Voided({signature}) {{
          Market(where: {{{", ".join(where)}}},
                 order_by: {{expiry: desc}}, limit: $limit) {{ {MARKET_FIELDS} }}
        }}
        """
        data = await self.reader._query(
            client, self.reader.indexer_url, query, variables
        )
        return [_row(n) for n in data.get("Market", [])]

    async def reconcile(
        self, client: httpx.AsyncClient, venue_id: str | None = None
    ) -> int:
        """Match settled markets to committed forecasts and score them."""
        outstanding = store.pending()
        if not outstanding:
            return 0

        oldest = min(r.expiry for r in outstanding)
        floor = oldest - 60
        settled, voided = await asyncio.gather(
            self._settled_covering(client, venue_id, oldest, floor),
            self._voided_markets(client, venue_id, floor),
        )
        by_id = {m.market_id.lower(): m for m in settled + voided}

        updates: dict[str, dict] = {}
        voids = 0
        for record in outstanding:
            market = by_id.get(record.market_id.lower())
            if market is None or market.outcome is None:
                continue
            # brier() returns None for a void: nothing was predicted about a
            # feed outage, so it is excluded from the score rather than counted
            # as a loss. The record still leaves pending, which is the point.
            updates[record.market_id] = {
                "outcome": market.outcome,
                "resolved_at": market.resolved_at or int(time.time()),
                "brier": brier(record.posterior, market.outcome),
                "oracle_question_id": market.oracle_question_id,
            }
            if market.outcome == "void":
                voids += 1

        scored = store.resolve_many(updates)
        if scored:
            log.info(
                "resolver: resolved %d of %d pending forecast(s) (%d voided)",
                scored, len(outstanding), voids,
            )
        return scored

    def calibration(self) -> CalibrationReport:
        """How well the posteriors have actually tracked reality."""
        records = store.load_all()
        pending = [r for r in records if r.outcome is None]
        voided = [r for r in records if r.outcome == "void"]
        scored = [
            r for r in records if r.outcome in ("up", "down") and r.brier is not None
        ]

        if not scored:
            return CalibrationReport(
                scored=0, pending=len(pending), voided=len(voided)
            )

        mean_brier = sum(r.brier or 0.0 for r in scored) / len(scored)
        hits = sum(
            1
            for r in scored
            if (r.posterior >= 0.5) == (r.outcome == "up")
        )

        # Reliability diagram: does "70%" actually happen 70% of the time?
        edges = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
        buckets = []
        for lo, hi in zip(edges, edges[1:]):
            members = [
                r for r in scored if lo <= r.posterior < hi or (hi == 1.0 and r.posterior == 1.0)
            ]
            if not members:
                continue
            buckets.append(
                {
                    "range": f"{lo:.1f}-{hi:.1f}",
                    "count": len(members),
                    "mean_forecast": round(
                        sum(r.posterior for r in members) / len(members), 4
                    ),
                    "observed_up_rate": round(
                        sum(1 for r in members if r.outcome == "up") / len(members), 4
                    ),
                }
            )

        return CalibrationReport(
            scored=len(scored),
            brier_score=round(mean_brier, 5),
            skill=round(1.0 - mean_brier / 0.25, 5),
            accuracy=round(hits / len(scored), 4),
            buckets=buckets,
            pending=len(pending),
            voided=len(voided),
        )

    # -- 3. backstop ---------------------------------------------------------
    async def backstops(
        self, client: httpx.AsyncClient, venue_id: str | None = None,
        grace_sec: int = 300,
    ) -> list[dict]:
        """Markets stuck past their settlement window, with the call to unstick them."""
        stuck = await self.reader.overdue_markets(
            client, grace_sec=grace_sec, venue_id=venue_id
        )
        now = int(time.time())
        out = []
        for m in stuck:
            overdue_for = now - m.expiry
            # Below the grace window a poke may simply be early; past it, the
            # market can be voided outright by anyone.
            action = "voidExpired" if overdue_for > grace_sec * 4 else "pokeOracle"
            out.append(
                {
                    "market_id": m.market_id,
                    "symbol": m.symbol,
                    "expiry": m.expiry,
                    "overdue_sec": overdue_for,
                    "oracle_question_id": m.oracle_question_id,
                    "suggested_call": action,
                    "receipt_url": self.reader.oracle_receipt_url(
                        m.oracle_question_id
                    ),
                }
            )
        return out

    async def sweep(self, venue_id: str | None = None) -> dict:
        """One full pass: reconcile, audit, and look for stuck markets."""
        async with httpx.AsyncClient(
            timeout=self.settings.http_timeout_sec
        ) as client:
            scored = await self.reconcile(client, venue_id)
            audits = await self.audit_settled(client, venue_id)
            stuck = await self.backstops(client, venue_id)
        return {
            "scored": scored,
            "audits": [a.as_dict() for a in audits],
            "backstops": stuck,
            "calibration": self.calibration().model_dump(),
        }


def commit(
    *, market_id: str, symbol: str, asset: str, posterior: float, prior: float,
    expiry: int, headline_ids: list[str] | None = None,
) -> bool:
    """Record a forecast before its window closes, so it can be scored later."""
    return store.record(
        ForecastCommitment(
            market_id=market_id, symbol=symbol, asset=asset,
            posterior=posterior, prior=prior, committed_at=int(time.time()),
            expiry=expiry, headline_ids=headline_ids or [],
        )
    )


def _report(result: dict, limit: int) -> None:
    print("\n=== SETTLEMENT AUDIT (recomputed from the public oracle feed) ===")
    print(
        f"{'market':<26}{'chain':<7}{'derived':<9}{'open':>11}{'close':>11}"
        f"{'margin':>10}  verdict"
    )
    for a in result["audits"][:limit]:
        o = f"{a['open_reference']:.2f}" if a["open_reference"] else "-"
        c = f"{a['close_reference']:.2f}" if a["close_reference"] else "-"
        m = f"{a['margin_bps']:+.2f}bp" if a["margin_bps"] is not None else "-"
        print(
            f"{a['symbol']:<26}{str(a['onchain_outcome']):<7}"
            f"{str(a['derived_outcome']):<9}{o:>11}{c:>11}{m:>10}  {a['verdict']}"
        )
    matched = sum(1 for a in result["audits"] if a["verdict"] == "match")
    unclear = sum(1 for a in result["audits"] if a["verdict"] == "inconclusive")
    total = len(result["audits"])
    print(f"\n  {matched}/{total} settlements independently verified")
    if unclear:
        print(
            f"  {unclear} inconclusive — decided by under {INCONCLUSIVE_BPS}bp, "
            f"finer than an off-chain reconstruction can resolve"
        )
    if result["audits"]:
        print(f"  receipt: {result['audits'][0]['receipt_url']}")

    print("\n=== BACKSTOPS ===")
    if not result["backstops"]:
        print("  none — every expired window settled inside its grace period")
    for b in result["backstops"]:
        print(f"  {b['symbol']} overdue {b['overdue_sec']}s -> {b['suggested_call']}()")

    cal = result["calibration"]
    print("\n=== CALIBRATION ===")
    print(f"  scored={cal['scored']} pending={cal['pending']} voided={cal['voided']}")
    if cal["scored"]:
        print(
            f"  Brier={cal['brier_score']} (coin flip 0.25) "
            f"skill={cal['skill']} accuracy={cal['accuracy']}"
        )
        for b in cal["buckets"]:
            print(
                f"    {b['range']}: n={b['count']:<4} "
                f"forecast={b['mean_forecast']:.3f} observed={b['observed_up_rate']:.3f}"
            )


async def _watch(resolver: Resolver, venue: str | None, interval: int, limit: int) -> None:
    """Sweep on a cadence until SIGINT/SIGTERM.

    Without this, the whole resolution half of the stack only ever ran when a
    human typed the CLI — forecasts sat unscored, and a market stuck past its
    settlement window went unnamed until somebody looked. The bot polls the
    FastAPI server continuously; the scoring side has to keep the same hours.
    """
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        # A signal handler on the loop, not a KeyboardInterrupt unwinding mid
        # sweep: an interrupt landing inside store.resolve_many() would be
        # holding the flock, and dying there is how a lock file outlives its
        # process. This lets the in-flight sweep finish and exit cleanly.
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    log.info("resolver: watching, sweeping every %ds (ctrl-c to stop)", interval)
    while not stop.is_set():
        try:
            _report(await resolver.sweep(venue), limit)
        except Exception as exc:  # a transient indexer hiccup must not end the watch
            log.warning("resolver: sweep failed (%s); retrying next tick", exc)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)
    log.info("resolver: stopped")


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Vaticr resolution agent")
    parser.add_argument("--venue", default=None, help="venueId to scope to")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument(
        "--watch", action="store_true",
        help="keep sweeping on a cadence instead of exiting after one pass",
    )
    parser.add_argument(
        "--interval", type=int, default=300,
        help="seconds between sweeps in --watch mode (default: one 5m window)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    resolver = Resolver()
    if args.watch:
        await _watch(resolver, args.venue, args.interval, args.limit)
        return
    _report(await resolver.sweep(args.venue), args.limit)


if __name__ == "__main__":
    asyncio.run(_main())
