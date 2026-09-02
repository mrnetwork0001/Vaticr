"""Behaviour tests for the deterministic news scorer.

The lexicon is the floor the whole evidence path stands on: with no API key it
is the *only* scorer, and every headline that reaches `evidence_for` carries a
sign it produced. A sign error here does not degrade the forecast, it inverts
it — the engine will confidently buy the wrong side of a window.

Runs standalone (`python -m tests.test_lexicon`) or under pytest.
"""

from __future__ import annotations

from agents.lexicon import (
    assets_for,
    credibility_for,
    salience_for,
    score_sentiment,
)


def sign_of(title: str) -> float:
    return score_sentiment(title)[0]


def why(title: str) -> str:
    return score_sentiment(title)[1]


# --- direction ---------------------------------------------------------------


def test_plain_bullish_and_bearish_headlines_get_the_right_sign() -> None:
    """The baseline: unambiguous news must not be scored near zero or inverted."""
    assert sign_of("Bitcoin ETF approval clears final hurdle") > 0.5
    assert sign_of("Fed signals dovish turn, rate cut on the table") > 0.5
    assert sign_of("Bitcoin plunges after exchange hack drains $200M") < -0.5
    assert sign_of("SEC charges major exchange in crypto crackdown") < -0.5
    # Nothing directional at all is 0.0, not a small random number — a neutral
    # headline must contribute exactly no log-odds.
    flat, note = score_sentiment("Conference announces speaker lineup for June")
    assert flat == 0.0 and note == "no directional terms"


def test_strongest_term_leads_and_corroboration_is_discounted() -> None:
    """Keyword stuffing must not outrun a single decisive term."""
    one = sign_of("Bitcoin ETF approval")
    stuffed = sign_of("Bitcoin ETF approval sparks rally, breakout, surge, gains")
    assert stuffed > one           # corroboration still adds
    assert stuffed <= 1.0          # but the score stays inside [-1, 1]


def test_intensifiers_amplify_without_changing_sign() -> None:
    plain = sign_of("Bitcoin ETF inflow reported")
    loud = sign_of("Massive Bitcoin ETF inflow reported")
    assert loud > plain > 0


# --- negation ----------------------------------------------------------------
#
# This is the highest-value block in the file. `denies`/`denied` live in BOTH
# the BEARISH table and NEGATORS, so a naive "negation flips the total" rule
# double-counts: the term contributes its own negative score, then the negation
# multiplies that negative by a negative and hands back a BULLISH number. A
# regulator refusing an ETF is the single most bearish crypto headline shape
# there is, and it was reading as a buy signal.


def test_denial_of_a_bullish_event_is_bearish() -> None:
    """"SEC denies Bitcoin ETF" is a rejection, not an approval."""
    assert sign_of("SEC denies Bitcoin ETF") < 0, score_sentiment("SEC denies Bitcoin ETF")
    assert sign_of("SEC denies spot Bitcoin ETF application") < 0
    assert sign_of("Bitcoin ETF approval denied") < 0


def test_negated_bullish_macro_is_bearish() -> None:
    """A cut that is NOT coming is a headwind, not the absence of news."""
    assert sign_of("Fed will not cut rates") < 0, score_sentiment("Fed will not cut rates")
    assert sign_of("Fed says no rate cut this year") < 0


def test_negation_dampens_as_well_as_flips() -> None:
    """A denial is weaker evidence than the event itself would have been.

    A denied approval is bearish, but it is not as bearish as an approval is
    bullish — nothing changed, a hoped-for change simply did not happen.
    """
    approved = sign_of("Bitcoin ETF approval")
    denied = sign_of("Bitcoin ETF approval denied")
    assert approved > 0 > denied
    assert abs(denied) < abs(approved)


def test_negation_does_not_fire_on_clean_headlines() -> None:
    """Guards the other direction: over-eager negation would invert good news."""
    assert sign_of("SEC approves spot Bitcoin ETF") > 0.5
    assert sign_of("Fed cuts rates by 50bp") > 0.3
    # "banned" is bearish on its own merits and must stay bearish.
    assert sign_of("Country banned crypto mining outright") < -0.4


# --- productive patterns -----------------------------------------------------


def test_accumulation_pattern_catches_quantities_between_verb_and_asset() -> None:
    """Phrase tables cannot see "buys 1,800 more Bitcoin"; the regex must."""
    score, note = score_sentiment("MicroStrategy buys 1,800 more Bitcoin")
    assert score > 0.3, (score, note)
    assert "accumulation" in note
    assert sign_of("Public company adds $370 million of ETH to its treasury") > 0.3


def test_exchange_inflow_pattern_is_bearish() -> None:
    """Coins moving onto an exchange is supply arriving at the order book."""
    score, note = score_sentiment("Whale moves 5,000 BTC to Binance")
    assert score < 0, (score, note)
    assert "exchange-inflow" in note
    # The mirror case must NOT trip it: an exchange outflow is not an inflow.
    assert sign_of("Investor buys 5,000 BTC from Binance") > 0


def test_percentage_move_patterns_carry_their_own_direction() -> None:
    assert sign_of("Ether jumps 7% on the session") > 0
    assert sign_of("Bitcoin falls 5% in Asian trading") < 0


# --- asset tagging -----------------------------------------------------------


def test_asset_tagging_finds_the_named_asset() -> None:
    assert assets_for("Bitcoin dips below $60k") == ["BTC"]
    assert assets_for("Ethereum upgrade ships on schedule") == ["ETH"]
    assert set(assets_for("BTC and ETH both rally")) == {"BTC", "ETH"}


def test_asset_tagging_does_not_false_positive_on_substrings() -> None:
    """`"eth" in low` matches inside "tether" and "method".

    A mis-tagged headline is worse than an untagged one: `evidence_for` filters
    on this list, so a Tether story silently becomes ETH evidence and moves an
    ETH window it has nothing to do with.
    """
    assert "ETH" not in assets_for("Tether mints $1B USDT on Tron"), assets_for(
        "Tether mints $1B USDT on Tron"
    )
    assert assets_for("New payment method launches for merchants") == []
    assert "BTC" not in assets_for("Debtcoin startup raises a seed round")


def test_macro_news_tags_both_majors() -> None:
    """Macro moves the whole risk complex even when neither coin is named."""
    assert set(assets_for("Fed holds rates steady after FOMC")) == {"BTC", "ETH"}
    assert set(assets_for("CPI comes in hotter than expected")) == {"BTC", "ETH"}


# --- salience and credibility ------------------------------------------------


def test_salience_ranks_market_moving_topics_above_noise() -> None:
    assert salience_for("FOMC decision due Wednesday") > 0.9
    assert salience_for("Local meetup schedule announced") == 0.15


def test_credibility_is_anchored_to_the_domain_not_a_suffix() -> None:
    """A typosquat must not inherit a trusted outlet's weight.

    `host.endswith(domain)` is true for "notreuters.com" and "fake-reuters.com".
    Credibility multiplies straight into the evidence weight, so an attacker —
    or an aggregator with an unlucky domain — gets a 0.95 outlet's pull from a
    name nobody vetted. Anchoring means host == domain or host ends with
    "." + domain.
    """
    assert credibility_for("https://www.reuters.com/markets/x") == 0.95
    assert credibility_for("https://reuters.com/markets/x") == 0.95
    assert credibility_for("https://feeds.reuters.com/x") == 0.95  # real subdomain

    assert credibility_for("https://notreuters.com/markets/x") == 0.5, credibility_for(
        "https://notreuters.com/markets/x"
    )
    assert credibility_for("https://fake-reuters.com/x") == 0.5
    assert credibility_for("https://reuters.com.evil.co/x") == 0.5
    # An unknown but honest domain sits at the neutral default, not at zero.
    assert credibility_for("https://some-blog.example/post") == 0.5


def run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    run()
