"""Subsystem 3 — the Autonomous Resolution & Settlement Agent.

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
   0.5 a side. Execution lives in `bot/src/resolver-backstop.ts`, which holds
   the signer.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time

import httpx

from .config import Settings, get_settings
from .schemas import CalibrationReport, ForecastCommitment
from .somnia import MarketRow, SomniaReader
from . import store

log = logging.getLogger("vaticr.resolver")


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
    def verdict(self) -> str:
        if self.market.outcome == "void":
            return "voided"
        if self.derived is None:
            return "unverifiable"
        return "match" if self.derived == self.market.outcome else "MISMATCH"

    def as_dict(self) -> dict:
        return {
            "market_id": self.market.market_id,
            "symbol": self.market.symbol,
            "asset": self.market.asset,
            "expiry": self.market.expiry,
            "onchain_outcome": self.market.outcome,
            "derived_outcome": self.derived,
            "open_reference": self.open_ref,
            "close_reference": self.close_ref,
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
    async def reconcile(
        self, client: httpx.AsyncClient, venue_id: str | None = None
    ) -> int:
        """Match settled markets to committed forecasts and score them."""
        outstanding = store.pending()
        if not outstanding:
            return 0

        oldest = min(r.expiry for r in outstanding)
        settled = await self.reader.settled_markets(
            client, venue_id=venue_id, limit=200, since=oldest - 60
        )
        by_id = {m.market_id.lower(): m for m in settled}

        scored = 0
        for record in outstanding:
            market = by_id.get(record.market_id.lower())
            if market is None or market.outcome is None:
                continue
            store.resolve(
                market_id=record.market_id,
                outcome=market.outcome,
                resolved_at=market.resolved_at or int(time.time()),
                brier=brier(record.posterior, market.outcome),
                oracle_question_id=market.oracle_question_id,
            )
            scored += 1
        if scored:
            log.info("resolver: scored %d settled forecast(s)", scored)
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


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Vaticr resolution agent")
    parser.add_argument("--venue", default=None, help="venueId to scope to")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    resolver = Resolver()
    result = await resolver.sweep(args.venue)

    print("\n=== SETTLEMENT AUDIT (recomputed from the public oracle feed) ===")
    print(f"{'market':<26}{'chain':<7}{'derived':<9}{'open':>11}{'close':>11}  verdict")
    for a in result["audits"][: args.limit]:
        o = f"{a['open_reference']:.2f}" if a["open_reference"] else "-"
        c = f"{a['close_reference']:.2f}" if a["close_reference"] else "-"
        print(
            f"{a['symbol']:<26}{str(a['onchain_outcome']):<7}"
            f"{str(a['derived_outcome']):<9}{o:>11}{c:>11}  {a['verdict']}"
        )
    matched = sum(1 for a in result["audits"] if a["verdict"] == "match")
    print(f"\n  {matched}/{len(result['audits'])} settlements independently verified")
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


if __name__ == "__main__":
    asyncio.run(_main())
