"""FastAPI surface — the seam between the Python brain and the TypeScript bot.

The bot (`bot/src/runner.ts`) owns the wallet, the Bot Kit and every write. It
asks this service one question per cycle: *what is the fair probability of each
live window, and why?* Everything here is read-only with respect to the chain.

    uvicorn agents.server:app --port 8787
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import get_settings
from .pricing import PricePoint, build_forecast, decide
from .resolver import Resolver, commit
from .schemas import CalibrationReport, Forecast, Headline
from .scout import Scout
from .somnia import SomniaReader

log = logging.getLogger("vaticr.server")

SETTINGS = get_settings()
SCOUT = Scout(SETTINGS)
READER = SomniaReader(SETTINGS)
RESOLVER = Resolver(SETTINGS)

# Volatility is expensive to fetch and slow to change; one estimate per asset
# per minute is plenty and keeps the price feed from being hammered.
_VOL_TTL_SEC = 60
_vol_cache: dict[str, tuple[int, list[PricePoint]]] = {}
_level_cache: dict[str, float | None] = {}
_OPEN_TTL_SEC = 3600
_open_cache: dict[str, float] = {}


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(SCOUT.run_forever())
    log.info("vaticr: scout started (%d feeds)", len(SETTINGS.feeds))
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title="Vaticr",
    version="1.0.0",
    description="Autonomous DeAI forecasting for DreamDEX Event Contracts on Somnia.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # read-only public data; the UI is served separately
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


async def _series(
    client: httpx.AsyncClient, asset: str
) -> tuple[list[PricePoint], float | None]:
    """Recent history for `asset`: the vol series, and the current level.

    Two different series, on purpose:

    * **Volatility** is estimated from `spot`, the raw multi-source median.
    * **The level** (and the window's opening price) is read from `mark`, the
      EMA — because that is the series settlement actually compares.

    Estimating volatility from the EMA understates it, and understating
    volatility makes the prior *overconfident*, which is the direction that
    loses money. The two series share the same long-run volatility, so taking
    each quantity from the series that measures it best costs nothing.
    """
    now = int(time.time())
    cached = _vol_cache.get(asset)
    if cached and now - cached[0] < _VOL_TTL_SEC:
        points = cached[1]
    else:
        ticks = await READER.price_series(client, asset, since=now - 2400, limit=1200)
        points = [PricePoint(ts=t.ts, price=t.spot) for t in ticks]
        _vol_cache[asset] = (now, points)
        _level_cache[asset] = ticks[-1].mark if ticks else None

    return points, _level_cache.get(asset)


async def _open_reference(
    client: httpx.AsyncClient, market_id: str, asset: str, trading_start: int
) -> float | None:
    """A window's opening price — the line to beat.

    The indexer publishes `strike: "0"` on these rows, so the line has to be
    recovered from the oracle feed at the window's own `tradingStart`. It never
    changes once the window opens, so it is cached for the window's life.
    """
    if market_id in _open_cache:
        return _open_cache[market_id]
    ref = await READER.reference_at(client, asset, trading_start)
    if ref is not None:
        if len(_open_cache) > 512:
            _open_cache.clear()
        _open_cache[market_id] = ref
    return ref


# --- models -----------------------------------------------------------------
class ForecastEnvelope(BaseModel):
    forecast: Forecast
    expiry: int
    trading_start: int
    interval_sec: int
    status: str
    oracle_question_id: str | None = None
    receipt_url: str | None = None


class CommitRequest(BaseModel):
    market_id: str
    symbol: str
    asset: str
    posterior: float
    prior: float
    expiry: int
    headline_ids: list[str] = []


# --- routes -----------------------------------------------------------------
@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "network": READER.network,
        "indexer": READER.indexer_url,
        "price_feed": READER.price_url,
        "headlines_in_window": len(SCOUT.fresh()),
        "last_scan": SCOUT.last_scan,
        "llm_classifier": "on" if SETTINGS.llm_ready else "off (lexicon only)",
        "feeds": len(SETTINGS.feeds),
    }


@app.get("/headlines", response_model=list[Headline])
async def headlines(
    asset: str | None = Query(default=None), limit: int = Query(default=40, le=200)
) -> list[Headline]:
    return SCOUT.fresh(asset)[:limit]


@app.post("/scan")
async def scan_now() -> dict[str, Any]:
    """Force an immediate feed scan (used by the demo script)."""
    added = await SCOUT.scan()
    await SCOUT.enrich(added)
    return {"added": len(added), "in_window": len(SCOUT.fresh())}


@app.get("/forecasts", response_model=list[ForecastEnvelope])
async def forecasts(
    venue: str | None = Query(default=None),
    asset: str | None = Query(default=None),
    limit: int = Query(default=12, le=50),
) -> list[ForecastEnvelope]:
    """A Bayesian posterior for every live event-contract window.

    This is the endpoint the bot polls each cycle.
    """
    async with httpx.AsyncClient(timeout=SETTINGS.http_timeout_sec) as client:
        try:
            markets = await READER.live_markets(client, venue_id=venue, limit=limit)
        except (httpx.HTTPError, RuntimeError) as exc:
            raise HTTPException(502, f"indexer unavailable: {exc}") from exc

        if asset:
            markets = [m for m in markets if m.asset == asset.upper()]
        if not markets:
            return []

        assets = sorted({m.asset for m in markets})
        by_asset = dict(
            zip(assets, await asyncio.gather(*(_series(client, a) for a in assets)))
        )
        now = int(time.time())
        out: list[ForecastEnvelope] = []

        for m in markets:
            points, spot = by_asset.get(m.asset, ([], None))
            open_ref = await _open_reference(
                client, m.market_id, m.asset, m.trading_start
            )
            if open_ref is None or spot is None:
                continue

            window = float(m.interval_sec or max(1, m.expiry - m.trading_start))
            forecast = build_forecast(
                asset=m.asset,
                open_price=open_ref,
                spot=spot,
                seconds_left=max(0.0, float(m.expiry - now)),
                window_sec=window,
                headlines=SCOUT.fresh(m.asset),
                vol_points=points,
                market_id=m.market_id,
                symbol=m.symbol,
                settings=SETTINGS,
            )
            out.append(
                ForecastEnvelope(
                    forecast=forecast,
                    expiry=m.expiry,
                    trading_start=m.trading_start,
                    interval_sec=m.interval_sec,
                    status=m.status,
                    oracle_question_id=m.oracle_question_id,
                    receipt_url=READER.oracle_receipt_url(m.oracle_question_id),
                )
            )
        return out


@app.get("/intent")
async def intent(
    market_id: str = Query(...),
    best_bid: float | None = Query(default=None),
    best_ask: float | None = Query(default=None),
    venue: str | None = Query(default=None),
    edge_threshold: float = Query(default=0.04),
) -> dict[str, Any]:
    """What to do about one market, given the live book the bot is looking at."""
    envelopes = await forecasts(venue=venue, limit=50)
    match = next(
        (e for e in envelopes if e.forecast.market_id == market_id), None
    )
    if match is None:
        raise HTTPException(404, f"no live forecast for {market_id}")
    decision = decide(
        match.forecast, best_bid, best_ask, edge_threshold=edge_threshold
    )
    return {"forecast": match.forecast.model_dump(), "intent": decision.model_dump()}


@app.post("/commit")
async def commit_forecast(req: CommitRequest) -> dict[str, Any]:
    """Record a forecast before its window closes so it can be scored later."""
    created = commit(
        market_id=req.market_id, symbol=req.symbol, asset=req.asset,
        posterior=req.posterior, prior=req.prior, expiry=req.expiry,
        headline_ids=req.headline_ids,
    )
    return {"recorded": created, "reason": "" if created else "already committed"}


@app.get("/calibration", response_model=CalibrationReport)
async def calibration(venue: str | None = Query(default=None)) -> CalibrationReport:
    async with httpx.AsyncClient(timeout=SETTINGS.http_timeout_sec) as client:
        await RESOLVER.reconcile(client, venue)
    return RESOLVER.calibration()


@app.get("/audit")
async def audit(
    venue: str | None = Query(default=None), limit: int = Query(default=12, le=50)
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=SETTINGS.http_timeout_sec) as client:
        audits = await RESOLVER.audit_settled(client, venue, limit)
    rows = [a.as_dict() for a in audits]
    return {
        "verified": sum(1 for r in rows if r["verdict"] == "match"),
        "total": len(rows),
        "reference": "mark (EMA) — empirically the settlement series; see docs/SDK_FEEDBACK.md",
        "settlements": rows,
    }


@app.get("/backstops")
async def backstops(venue: str | None = Query(default=None)) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=SETTINGS.http_timeout_sec) as client:
        stuck = await RESOLVER.backstops(client, venue)
    return {"count": len(stuck), "markets": stuck}
