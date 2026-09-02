"""Read-only Somnia/DreamDEX data access for the Python agents.

Two GraphQL surfaces, both public and keyless:

* the **markets indexer** — event-contract rows (window geometry, status,
  settlement outcome, oracle question id);
* the **price feed** — the underlying BTC/ETH oracle series at one-second
  resolution, which is the same reference the settlement is computed from.

Writes stay in TypeScript (`bot/`), where the official Bot Kit and
`@somnia-chain/markets-sdk` own signing, nonces and escrow. Python only reads —
which is all the forecasting and audit layer needs, and keeps one key with one
sender, as the Bot Kit's claim docs require.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings, get_settings

log = logging.getLogger("vaticr.somnia")

INDEXERS = {
    "testnet": "https://dev.smk.somnia.host/v1/graphql",
    "mainnet": "https://prd.smk.somnia.host/v1/graphql",
}
PRICE_FEEDS = {
    "testnet": "https://price-feed.dev.oracle.somnia.host/v1/graphql",
    "mainnet": "https://price-feed.prd.oracle.somnia.host/v1/graphql",
}
# The oracle explorer page that shows a settlement's full source pipeline.
ORACLE_EXPLORER = {
    "testnet": "https://dev.oracle.somnia.host",
    "mainnet": "https://prd.oracle.somnia.host",
}

PRICE_DECIMALS = 18

MARKET_FIELDS = """
  marketId asset intervalSec strike tradingStart expiry
  winningOutcome voided clobStatus finalized
  oracleQuestionId resolvedAtTimestamp venueId
  poolAddress yesTokenId noTokenId cumulativeQuoteVolume tradeCount
"""


@dataclass(frozen=True)
class PriceTick:
    """One oracle observation. `mark` is what settlement compares."""

    ts: int
    spot: float
    mark: float


@dataclass(frozen=True)
class MarketRow:
    market_id: str
    asset: str
    interval_sec: int
    trading_start: int
    expiry: int
    status: str
    winning_outcome: int | None
    voided: bool
    finalized: bool
    oracle_question_id: str | None
    resolved_at: int | None
    venue_id: str | None
    quote_volume: float
    trade_count: int

    @property
    def symbol(self) -> str:
        return f"{self.asset} {self.interval_sec}s @{self.expiry}"

    @property
    def outcome(self) -> str | None:
        """'up' (YES), 'down' (NO), 'void', or None while unresolved."""
        if self.voided:
            return "void"
        if self.winning_outcome is None:
            return None
        return "up" if self.winning_outcome == 0 else "down"


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _row(node: dict[str, Any]) -> MarketRow:
    return MarketRow(
        market_id=node.get("marketId") or "",
        asset=(node.get("asset") or "").upper(),
        interval_sec=_as_int(node.get("intervalSec")),
        trading_start=_as_int(node.get("tradingStart")),
        expiry=_as_int(node.get("expiry")),
        status=node.get("clobStatus") or "",
        winning_outcome=(
            None if node.get("winningOutcome") is None
            else _as_int(node.get("winningOutcome"))
        ),
        voided=bool(node.get("voided")),
        finalized=bool(node.get("finalized")),
        oracle_question_id=node.get("oracleQuestionId"),
        resolved_at=(
            None if node.get("resolvedAtTimestamp") is None
            else _as_int(node.get("resolvedAtTimestamp"))
        ),
        venue_id=node.get("venueId"),
        quote_volume=float(node.get("cumulativeQuoteVolume") or 0) / 1e6,
        trade_count=_as_int(node.get("tradeCount")),
    )


class SomniaReader:
    """Async reader over the two public GraphQL endpoints."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        net = self.settings.network if self.settings.network in INDEXERS else "testnet"
        self.network = net
        self.indexer_url = INDEXERS[net]
        self.price_url = PRICE_FEEDS[net]
        self.explorer = ORACLE_EXPLORER[net]

    def oracle_receipt_url(self, question_id: str | None) -> str | None:
        """Deep link to the settlement's own source-by-source audit page."""
        if not question_id:
            return None
        return f"{self.explorer}/questions/{question_id}?view=graph"

    async def _query(
        self, client: httpx.AsyncClient, url: str, query: str,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resp = await client.post(
            url, json={"query": query, "variables": variables or {}}
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            raise RuntimeError(f"graphql error: {payload['errors'][:1]}")
        return payload.get("data") or {}

    # -- markets -------------------------------------------------------------
    async def live_markets(
        self, client: httpx.AsyncClient, venue_id: str | None = None, limit: int = 25
    ) -> list[MarketRow]:
        """Currently trading binary markets, soonest expiry first."""
        import time as _t

        where = ['marketType: {_eq: "BINARY"}', "expiry: {_gt: $now}"]
        # Hasura rejects a declared-but-unused variable ("unexpected variables in
        # variableValues: venue"), so the signature is built to match exactly
        # what the where clause references — same pattern as `price_series`.
        signature = "$now: numeric!, $limit: Int!"
        variables: dict[str, Any] = {"now": int(_t.time()), "limit": limit}
        if venue_id:
            where.append("venueId: {_eq: $venue}")
            signature += ", $venue: String!"
            variables["venue"] = venue_id
        query = f"""
        query Live({signature}) {{
          Market(where: {{{", ".join(where)}}},
                 order_by: {{expiry: asc}}, limit: $limit) {{ {MARKET_FIELDS} }}
        }}
        """
        data = await self._query(client, self.indexer_url, query, variables)
        return [_row(n) for n in data.get("Market", [])]

    async def settled_markets(
        self, client: httpx.AsyncClient, venue_id: str | None = None,
        limit: int = 50, since: int = 0,
    ) -> list[MarketRow]:
        """Recently settled binary markets, newest first."""
        where = [
            'marketType: {_eq: "BINARY"}',
            "expiry: {_gte: $since}",
            "winningOutcome: {_is_null: false}",
        ]
        signature = "$since: numeric!, $limit: Int!"
        variables: dict[str, Any] = {"since": since, "limit": limit}
        if venue_id:
            where.append("venueId: {_eq: $venue}")
            signature += ", $venue: String!"
            variables["venue"] = venue_id
        query = f"""
        query Settled({signature}) {{
          Market(where: {{{", ".join(where)}}},
                 order_by: {{expiry: desc}}, limit: $limit) {{ {MARKET_FIELDS} }}
        }}
        """
        data = await self._query(client, self.indexer_url, query, variables)
        return [_row(n) for n in data.get("Market", [])]

    async def overdue_markets(
        self, client: httpx.AsyncClient, grace_sec: int = 300,
        venue_id: str | None = None, max_age_sec: int = 86_400,
    ) -> list[MarketRow]:
        """Expired markets the oracle has not resolved inside the grace window.

        These are the ones where the permissionless backstops apply:
        `pokeOracle(questionId)` pulls a posted answer, and once the settlement
        window lapses anyone may call `voidExpired()`.

        Bounded below by `max_age_sec`: retired venues leave permanently
        unresolved rows behind, and reporting those as "overdue" forever would
        bury the one market that actually needs a poke today.
        """
        import time as _t

        now = int(_t.time())
        where = [
            'marketType: {_eq: "BINARY"}',
            "expiry: {_lt: $cutoff, _gte: $floor}",
            "winningOutcome: {_is_null: true}",
            "voided: {_eq: false}",
        ]
        signature = "$cutoff: numeric!, $floor: numeric!"
        variables: dict[str, Any] = {
            "cutoff": now - grace_sec, "floor": now - max_age_sec
        }
        if venue_id:
            where.append("venueId: {_eq: $venue}")
            signature += ", $venue: String!"
            variables["venue"] = venue_id
        query = f"""
        query Overdue({signature}) {{
          Market(where: {{{", ".join(where)}}},
                 order_by: {{expiry: desc}}, limit: 25) {{ {MARKET_FIELDS} }}
        }}
        """
        data = await self._query(client, self.indexer_url, query, variables)
        return [_row(n) for n in data.get("Market", [])]

    # -- price feed ----------------------------------------------------------
    #
    # The feed publishes two series per asset: `spot` (the raw multi-source
    # median) and `mark` (its EMA). Settlement resolves against the MARK.
    #
    # Determined empirically, because the protocol docs say only "a multi-source
    # price reference": over the eight most recently settled BTC/ETH windows on
    # the testnet venue, comparing close-vs-open on `mark` reproduced the
    # on-chain winner 8/8, while `spot` reproduced it 6/8 — the two
    # disagreements being exactly the windows where spot and mark drifted apart
    # in direction. Pricing a contract off `spot` therefore mis-prices every
    # window that closes near its own opening price, which is precisely the
    # region where the probability is most sensitive. See docs/SDK_FEEDBACK.md.

    async def price_series(
        self, client: httpx.AsyncClient, asset: str, since: int, until: int | None = None,
        limit: int = 900,
    ) -> list[PriceTick]:
        """Ascending tick series for `asset` over a window."""
        variables: dict[str, Any] = {
            "asset": asset.upper(), "since": since, "limit": limit
        }
        # Hasura rejects a declared-but-unused variable, so the signature is
        # built to match exactly what the where clause references. Both bounds
        # go in ONE `blockTimestamp` comparator — repeating the key twice in the
        # same object is not valid GraphQL.
        signature = "$asset: String!, $since: numeric!, $limit: Int!"
        bounds = "_gte: $since"
        if until is not None:
            bounds += ", _lte: $until"
            signature += ", $until: numeric!"
            variables["until"] = until
        clauses = [
            "base: {_eq: $asset}",
            'quote: {_eq: "USDC"}',
            f"blockTimestamp: {{{bounds}}}",
        ]
        query = f"""
        query Series({signature}) {{
          PricePoint(where: {{{", ".join(clauses)}}},
                     order_by: {{blockTimestamp: desc}}, limit: $limit) {{
            spot mark blockTimestamp
          }}
        }}
        """
        data = await self._query(client, self.price_url, query, variables)
        points = [
            PriceTick(
                ts=_as_int(p["blockTimestamp"]),
                spot=float(p["spot"]) / 10**PRICE_DECIMALS,
                mark=float(p["mark"]) / 10**PRICE_DECIMALS,
            )
            for p in data.get("PricePoint", [])
            if p.get("spot") is not None and p.get("mark") is not None
        ]
        return sorted(points, key=lambda t: t.ts)

    async def tick_at(
        self, client: httpx.AsyncClient, asset: str, ts: int, window: int = 120
    ) -> PriceTick | None:
        """The oracle tick closest to `ts`."""
        points = await self.price_series(
            client, asset, since=ts - window, until=ts + window, limit=400
        )
        if not points:
            return None
        return min(points, key=lambda p: abs(p.ts - ts))

    async def reference_at(
        self, client: httpx.AsyncClient, asset: str, ts: int, window: int = 120
    ) -> float | None:
        """The SETTLEMENT reference (mark) closest to `ts`."""
        tick = await self.tick_at(client, asset, ts, window)
        return tick.mark if tick else None

    async def latest_tick(
        self, client: httpx.AsyncClient, asset: str
    ) -> PriceTick | None:
        import time as _t

        points = await self.price_series(
            client, asset, since=int(_t.time()) - 300, limit=50
        )
        return points[-1] if points else None
