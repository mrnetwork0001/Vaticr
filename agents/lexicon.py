"""Deterministic, dependency-free directional scoring for financial headlines.

This is the fallback scorer and the reference implementation: it runs with no
API key, no model download, and no network. `agents.llm` can override its
output when an Anthropic key is present, but the lexicon always produces a
usable score so the pipeline degrades gracefully rather than going dark.

Weights are signed sentiment in [-1, 1] and are applied to the *risk asset*
(BTC/ETH). Macro terms are already polarity-corrected for that frame: a rate
cut is bullish for crypto, a hike is bearish.
"""

from __future__ import annotations

import re

# --- Directional term weights ------------------------------------------------
BULLISH: dict[str, float] = {
    # Flows / adoption
    "etf approval": 0.95, "etf inflow": 0.80, "spot etf": 0.55, "inflows": 0.60,
    "record inflow": 0.85, "institutional adoption": 0.70, "adds bitcoin": 0.70,
    "buys bitcoin": 0.70, "treasury allocation": 0.65, "accumulation": 0.55,
    "whale accumulation": 0.60, "reserve": 0.45, "strategic reserve": 0.80,
    # Price / structure
    "all-time high": 0.85, "record high": 0.85, "breakout": 0.65, "rally": 0.60,
    "surge": 0.65, "soars": 0.70, "jumps": 0.55, "climbs": 0.45, "gains": 0.40,
    "rebound": 0.50, "recovery": 0.45, "short squeeze": 0.70, "golden cross": 0.55,
    "bullish": 0.60, "upgraded": 0.45, "outperform": 0.45,
    # Regulatory / macro tailwind
    "approves": 0.60, "approved": 0.60, "greenlight": 0.65, "clarity": 0.40,
    "rate cut": 0.75, "cuts rates": 0.80, "dovish": 0.70, "easing": 0.60,
    "stimulus": 0.55, "liquidity injection": 0.65, "pause hikes": 0.55,
    "inflation cools": 0.60, "cpi miss": 0.55, "soft landing": 0.50,
    # Tech
    "mainnet launch": 0.50, "upgrade complete": 0.45, "partnership": 0.35,
    "integration": 0.30, "halving": 0.40,
}

BEARISH: dict[str, float] = {
    # Security / failure
    "hack": -0.90, "hacked": -0.90, "exploit": -0.85, "exploited": -0.85,
    "rug pull": -0.85, "insolvency": -0.90, "bankruptcy": -0.90, "collapse": -0.85,
    "halts withdrawals": -0.85, "depeg": -0.80, "liquidated": -0.60,
    "liquidations": -0.60, "breach": -0.70, "stolen": -0.75, "drained": -0.80,
    # Regulatory headwind
    "lawsuit": -0.65, "sues": -0.65, "sec charges": -0.75, "indicted": -0.70,
    "crackdown": -0.75, "ban": -0.80, "bans": -0.80, "banned": -0.80,
    "investigation": -0.55, "subpoena": -0.55, "fine": -0.45, "delisting": -0.65,
    "rejected": -0.60, "denies": -0.50, "restrict": -0.50,
    # Price / structure
    "crash": -0.85, "plunge": -0.80, "plummets": -0.80, "tumbles": -0.65,
    "slumps": -0.60, "sinks": -0.60, "falls": -0.45, "drops": -0.45,
    "selloff": -0.70, "sell-off": -0.70, "capitulation": -0.75, "bearish": -0.60,
    "death cross": -0.55, "outflow": -0.60, "outflows": -0.60, "downgraded": -0.45,
    "correction": -0.45, "slide": -0.45,
    # Macro headwind
    "rate hike": -0.75, "raises rates": -0.80, "hawkish": -0.70,
    "tightening": -0.60, "inflation rises": -0.60, "cpi beat": -0.55,
    "recession": -0.60, "tariff": -0.45, "hot inflation": -0.65,
}

# Words that intensify or negate whatever follows.
INTENSIFIERS = {"massive": 1.4, "record": 1.35, "sharp": 1.25, "surprise": 1.3,
                "unexpected": 1.3, "major": 1.2, "huge": 1.35, "historic": 1.4}
NEGATORS = {"no", "not", "denies", "denied", "false", "rumor", "rumour",
            "unconfirmed", "delayed", "postponed", "fails", "failed", "halted"}

# How market-moving a topic is, independent of direction.
SALIENCE_TERMS = {
    "etf": 0.9, "sec": 0.8, "fed": 0.95, "fomc": 0.95, "cpi": 0.9, "rate": 0.85,
    "hack": 0.9, "exploit": 0.9, "bankruptcy": 0.9, "halving": 0.7,
    "all-time high": 0.85, "crash": 0.85, "regulation": 0.7, "lawsuit": 0.6,
    "inflation": 0.8, "treasury": 0.7, "blackrock": 0.75, "microstrategy": 0.6,
}

ASSET_TERMS: dict[str, tuple[str, ...]] = {
    "BTC": ("bitcoin", "btc", "xbt", "satoshi"),
    "ETH": ("ethereum", "ether", "eth", "vitalik", "erc-20", "the merge"),
}
# Macro and market-wide news moves both majors even when neither is named.
MACRO_TERMS = ("fed", "fomc", "federal reserve", "cpi", "inflation", "rate",
               "powell", "treasury yield", "jobs report", "payrolls", "pce",
               "recession", "tariff", "ecb",
               # Market-wide crypto terms — these move BTC and ETH together.
               "crypto market", "crypto markets", "digital asset", "digital assets",
               "crypto rally", "crypto selloff", "crypto sell-off", "risk assets",
               "total market cap", "liquidations", "stablecoin")

SOURCE_CREDIBILITY = {
    "federalreserve.gov": 1.0, "coindesk.com": 0.85, "cointelegraph.com": 0.7,
    "decrypt.co": 0.75, "bitcoinmagazine.com": 0.65, "reuters.com": 0.95,
    "bloomberg.com": 0.95, "wsj.com": 0.9, "ft.com": 0.9, "cnbc.com": 0.8,
}

_WORD = re.compile(r"[a-z0-9$\-']+")

# Phrase tables cannot catch productive constructions like "buys 1,800 Bitcoin"
# or "adds $370 million of BTC" — the quantity sits between the verb and the
# asset. These patterns cover the categories that literal matching misses.
PATTERNS: tuple[tuple[re.Pattern[str], float, str], ...] = (
    # Corporate / institutional accumulation — a dominant bullish category.
    (re.compile(r"\b(buy|buys|bought|purchas\w+|acquir\w+|adds?|added|accumulat\w+)\b"
                r"[^.]{0,40}?\b(bitcoin|btc|ether(?:eum)?|eth)\b"), 0.60, "accumulation"),
    (re.compile(r"\b(bitcoin|btc|ether(?:eum)?|eth)\b[^.]{0,30}?"
                r"\b(purchase|buying|accumulation|treasury|holdings? (?:rise|grow|increase))\b"),
     0.45, "accumulation"),
    (re.compile(r"\blargest\b[^.]{0,30}\b(purchase|buy|acquisition)\b"), 0.55, "large-buy"),
    # Distribution — the mirror image.
    (re.compile(r"\b(sell|sells|sold|dump\w*|offload\w*|transfers?|moves?)\b"
                r"[^.]{0,40}?\b(bitcoin|btc|ether(?:eum)?|eth)\b[^.]{0,30}"
                r"\b(to|into)\b[^.]{0,20}\b(exchange|coinbase|binance|kraken)\b"),
     -0.55, "exchange-inflow"),
    (re.compile(r"\b(sell|sells|sold|dump\w*|offload\w*)\b[^.]{0,40}?"
                r"\b(bitcoin|btc|ether(?:eum)?|eth)\b"), -0.50, "distribution"),
    # Directional price moves with an explicit percentage.
    (re.compile(r"\b(rise|rises|rose|up|gain\w*|surge\w*|jump\w*)\b\s*\d+(\.\d+)?%"),
     0.50, "pct-up"),
    (re.compile(r"\b(fall|falls|fell|down|drop\w*|slid\w*|los\w+)\b\s*\d+(\.\d+)?%"),
     -0.50, "pct-down"),
)


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def credibility_for(url: str) -> float:
    host = re.sub(r"^https?://(www\.)?", "", url.lower()).split("/")[0]
    for domain, weight in SOURCE_CREDIBILITY.items():
        if host.endswith(domain):
            return weight
    return 0.5


def assets_for(title: str) -> list[str]:
    low = title.lower()
    hits = [a for a, terms in ASSET_TERMS.items() if any(t in low for t in terms)]
    if hits:
        return hits
    if any(t in low for t in MACRO_TERMS):
        return ["BTC", "ETH"]  # macro moves the whole risk complex
    return []


def salience_for(title: str) -> float:
    low = title.lower()
    best = 0.15
    for term, weight in SALIENCE_TERMS.items():
        if term in low:
            best = max(best, weight)
    return round(best, 3)


def score_sentiment(title: str) -> tuple[float, str]:
    """Signed sentiment in [-1, 1] plus a short human-readable rationale.

    Multi-word phrases are matched against the raw string; single words are
    matched against tokens so `ban` does not fire inside `bank`.
    """
    low = title.lower()
    toks = _tokens(low)
    tokset = set(toks)
    matched: list[tuple[str, float]] = []

    for table in (BULLISH, BEARISH):
        for term, weight in table.items():
            hit = term in low if " " in term or "-" in term else term in tokset
            if hit:
                matched.append((term, weight))

    for pattern, weight, label in PATTERNS:
        if pattern.search(low):
            matched.append((label, weight))

    if not matched:
        return 0.0, "no directional terms"

    # Strongest signal leads; weaker corroborating terms add at a discount so a
    # keyword-stuffed headline cannot dominate.
    matched.sort(key=lambda kv: abs(kv[1]), reverse=True)
    total = matched[0][1] + sum(w for _, w in matched[1:]) * 0.30

    boost = max((INTENSIFIERS[t] for t in toks if t in INTENSIFIERS), default=1.0)
    total *= boost
    if tokset & NEGATORS:
        total *= -0.45  # a denial flips and dampens the claim

    total = max(-1.0, min(1.0, total))
    terms = ", ".join(t for t, _ in matched[:3])
    return round(total, 3), f"matched: {terms}"
