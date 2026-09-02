"""Query-construction and row-decoding tests for the GraphQL readers.

No network. `_query` is intercepted, so what is asserted is the exact document
and variable map that would have gone over the wire — which is where the bugs
actually live. Hasura is a strict GraphQL validator: a document that declares
`$venue` and never references it is rejected outright, and the indexer returns
that rejection as a 502 rather than a GraphQL error body. That is what took the
live reader down whenever it ran unscoped — the common case, since the venue is
optional on every one of these calls.

Runs standalone (`python -m tests.test_somnia`) or under pytest.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from agents.somnia import MarketRow, SomniaReader, _row

VENUE = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c"

_SIGNATURE = re.compile(r"query\s+\w+\s*\(([^)]*)\)")


class CapturingReader(SomniaReader):
    """A reader whose transport records the request instead of sending it."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def _query(  # type: ignore[override]
        self, client: Any, url: str, query: str,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append((url, query, variables or {}))
        return {}

    def sent(self) -> tuple[str, str, dict[str, Any]]:
        assert self.calls, "no query was built"
        return self.calls[-1]


def build(coro_factory) -> tuple[str, str, dict[str, Any]]:
    """Run one reader method to the point of transport and return the request."""
    reader = CapturingReader()
    asyncio.run(coro_factory(reader))
    return reader.sent()


def declared(query: str) -> set[str]:
    sig = _SIGNATURE.search(query)
    assert sig is not None, f"no operation signature in:\n{query}"
    return set(re.findall(r"\$(\w+)\s*:", sig.group(1)))


def used(query: str) -> set[str]:
    sig = _SIGNATURE.search(query)
    assert sig is not None
    return set(re.findall(r"\$(\w+)", query[sig.end():]))


def assert_variables_balance(query: str, variables: dict[str, Any]) -> None:
    """Declared == used == supplied. Any imbalance is a Hasura rejection.

    Three separate failures share one assertion because Hasura rejects all
    three: a variable declared and not referenced, a variable referenced and not
    declared, and a value supplied for a variable the document never declared
    ("unexpected variables in variableValues").
    """
    d, u, v = declared(query), used(query), set(variables)
    assert d == u, f"declared {d} but used {u} in:\n{query}"
    assert d == v, f"declared {d} but supplied {v} in:\n{query}"


# --- the unscoped case, which is the one that 502'd -------------------------


def test_live_markets_without_a_venue_declares_no_venue_variable() -> None:
    _, query, variables = build(lambda r: r.live_markets(None))
    assert "$venue" not in query, query
    assert "venue" not in variables
    assert set(variables) == {"now", "limit"}
    assert_variables_balance(query, variables)


def test_settled_markets_without_a_venue_declares_no_venue_variable() -> None:
    _, query, variables = build(lambda r: r.settled_markets(None))
    assert "$venue" not in query, query
    assert set(variables) == {"since", "limit"}
    assert_variables_balance(query, variables)


def test_overdue_markets_without_a_venue_declares_no_venue_variable() -> None:
    _, query, variables = build(lambda r: r.overdue_markets(None))
    assert "$venue" not in query, query
    assert set(variables) == {"cutoff", "floor"}
    assert_variables_balance(query, variables)


def test_price_series_without_an_upper_bound_declares_no_until() -> None:
    """Same defect shape on the price feed: `until` is optional too."""
    _, query, variables = build(lambda r: r.price_series(None, "BTC", since=100))
    assert "$until" not in query, query
    assert set(variables) == {"asset", "since", "limit"}
    assert_variables_balance(query, variables)


# --- the scoped case still has to work --------------------------------------


def test_a_supplied_venue_is_both_declared_and_referenced() -> None:
    for factory in (
        lambda r: r.live_markets(None, venue_id=VENUE),
        lambda r: r.settled_markets(None, venue_id=VENUE),
        lambda r: r.overdue_markets(None, venue_id=VENUE),
    ):
        _, query, variables = build(factory)
        assert "venueId: {_eq: $venue}" in query, query
        assert variables["venue"] == VENUE
        assert_variables_balance(query, variables)


def test_both_price_bounds_go_in_one_timestamp_comparator() -> None:
    """Repeating `blockTimestamp` twice in the same object is not valid GraphQL —
    the second key silently wins and the lower bound is lost."""
    _, query, variables = build(
        lambda r: r.price_series(None, "eth", since=100, until=200)
    )
    assert query.count("blockTimestamp: {") == 1, query
    assert "_gte: $since, _lte: $until" in query
    assert variables["until"] == 200
    assert variables["asset"] == "ETH"  # normalised for the feed
    assert_variables_balance(query, variables)


# --- filters and routing ----------------------------------------------------


def test_each_reader_talks_to_the_right_endpoint() -> None:
    reader = CapturingReader()
    asyncio.run(reader.live_markets(None))
    asyncio.run(reader.price_series(None, "BTC", since=1))
    assert reader.calls[0][0] == reader.indexer_url
    assert reader.calls[1][0] == reader.price_url
    assert reader.indexer_url != reader.price_url


def test_market_queries_select_the_settlement_state_they_claim_to() -> None:
    """The three market reads are distinguished only by their where clause."""
    _, live, _ = build(lambda r: r.live_markets(None))
    _, settled, _ = build(lambda r: r.settled_markets(None))
    _, overdue, _ = build(lambda r: r.overdue_markets(None))

    assert "expiry: {_gt: $now}" in live
    assert "winningOutcome: {_is_null: false}" in settled
    # Overdue means expired, unresolved and not already voided.
    assert "winningOutcome: {_is_null: true}" in overdue
    assert "voided: {_eq: false}" in overdue
    for q in (live, settled, overdue):
        assert 'marketType: {_eq: "BINARY"}' in q


def test_overdue_query_is_bounded_below_so_dead_venues_do_not_pile_up() -> None:
    """Retired venues leave permanently unresolved rows; without a floor they
    would bury the one market that actually needs a poke today."""
    _, query, variables = build(lambda r: r.overdue_markets(None, max_age_sec=3600))
    assert "expiry: {_lt: $cutoff, _gte: $floor}" in query
    assert variables["cutoff"] - variables["floor"] == 3600 - 300  # grace default


# --- row decoding -----------------------------------------------------------


def node(**over: Any) -> dict[str, Any]:
    base = {
        "marketId": "0xAA", "asset": "btc", "intervalSec": "900", "strike": "0",
        "tradingStart": "1700000000", "expiry": "1700000900",
        "winningOutcome": 0, "voided": False, "clobStatus": "RESOLVED",
        "finalized": True, "oracleQuestionId": "0xq",
        "resolvedAtTimestamp": "1700000904", "venueId": VENUE,
        "cumulativeQuoteVolume": "1500000", "tradeCount": "7",
    }
    base.update(over)
    return base


def test_winning_outcome_zero_is_up_and_one_is_down() -> None:
    """The whole audit hinges on this mapping. Outcome 0 is YES, i.e. Up."""
    assert _row(node(winningOutcome=0)).outcome == "up"
    assert _row(node(winningOutcome=1)).outcome == "down"


def test_an_unresolved_market_has_no_outcome() -> None:
    """None is "not settled yet", which is not the same as a loss."""
    assert _row(node(winningOutcome=None)).outcome is None


def test_a_voided_market_outranks_its_winning_outcome() -> None:
    """A void carries a null winner, but the flag is what decides.

    Reading the winner first would report a voided window as unresolved and
    leave its forecast pending forever.
    """
    assert _row(node(voided=True, winningOutcome=None)).outcome == "void"
    assert _row(node(voided=True, winningOutcome=0)).outcome == "void"


def test_row_decoding_normalises_the_indexers_string_numerics() -> None:
    """Every numeric arrives as a string, and `strike` is always "0"."""
    row = _row(node())
    assert isinstance(row, MarketRow)
    assert row.asset == "BTC"                    # uppercased for lookups
    assert row.interval_sec == 900 and row.expiry == 1_700_000_900
    assert row.resolved_at == 1_700_000_904
    assert row.trade_count == 7
    assert row.quote_volume == 1.5               # 6-decimal USDC minor units
    assert row.symbol == "BTC 900s @1700000900"


def test_row_decoding_survives_missing_and_unparsable_fields() -> None:
    """A partial row must degrade to defaults, not take the whole sweep down."""
    row = _row({})
    assert row.market_id == "" and row.asset == ""
    assert row.expiry == 0 and row.quote_volume == 0.0
    assert row.outcome is None and row.voided is False
    assert _row(node(intervalSec="n/a")).interval_sec == 0


def test_receipt_url_is_only_built_when_there_is_a_question_to_show() -> None:
    reader = SomniaReader()
    assert reader.oracle_receipt_url(None) is None
    assert reader.oracle_receipt_url("") is None
    assert reader.oracle_receipt_url("0xq") == f"{reader.explorer}/questions/0xq?view=graph"


def run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    run()
