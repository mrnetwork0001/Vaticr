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
    # The verb-first form is what a negator actually governs ("will not cut
    # rates"); without it the most common negated-macro headline shape matched
    # nothing at all and scored a flat 0.0.
    "cut rates": 0.80, "cutting rates": 0.75,
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
    "restrict": -0.50,
    # NOTE: "denies"/"rejected" used to live here *and* in the negator set. A
    # word cannot be both the signal and the operator that inverts the signal:
    # "SEC denies Bitcoin ETF" matched -0.50 here, then the global negation rule
    # multiplied the running total by -0.45 and returned +0.225 — the single
    # most bearish headline shape in crypto, read as a buy. Every rejection verb
    # now lives in REJECTORS below and is scored exactly once.
    # Price / structure
    "crash": -0.85, "plunge": -0.80, "plummets": -0.80, "tumbles": -0.65,
    "slumps": -0.60, "sinks": -0.60, "falls": -0.45, "drops": -0.45,
    "selloff": -0.70, "sell-off": -0.70, "capitulation": -0.75, "bearish": -0.60,
    "death cross": -0.55, "outflow": -0.60, "outflows": -0.60, "downgraded": -0.45,
    "correction": -0.45, "slide": -0.45,
    # Macro headwind
    "rate hike": -0.75, "raises rates": -0.80, "raise rates": -0.80,
    "hike rates": -0.75, "hawkish": -0.70,
    "tightening": -0.60, "inflation rises": -0.60, "cpi beat": -0.55,
    "recession": -0.60, "tariff": -0.45, "hot inflation": -0.65,
}

# Words that intensify whatever follows.
INTENSIFIERS = {"massive": 1.4, "record": 1.35, "sharp": 1.25, "surprise": 1.3,
                "unexpected": 1.3, "major": 1.2, "huge": 1.35, "historic": 1.4}

# --- Negation ----------------------------------------------------------------
#
# Negation is *scoped*: a negator inverts the directional term it governs, not
# the headline total. The old global `total *= -0.45` could not tell
# "SEC denies spot ETF" (a rejection of a bullish event) from "exchange denies
# hack" (a denial of a bearish claim) and got the first one backwards.
#
# REJECTORS are transitive rejection verbs. They carry their own bearish weight,
# because "SEC rejects the filing" is a bearish event even when the thing being
# rejected names no term in the tables. HEDGES are pure function words with no
# directional content — they can only invert something else.
REJECTORS: dict[str, float] = {
    "denies": -0.50, "denied": -0.50, "denial": -0.50,
    "rejects": -0.60, "rejected": -0.60, "rejection": -0.60,
    "vetoes": -0.60, "vetoed": -0.60,
    "delays": -0.40, "delayed": -0.40, "postpones": -0.40, "postponed": -0.40,
    "halts": -0.55, "halted": -0.55,
    "scraps": -0.55, "scrapped": -0.55,
    "fails": -0.50, "failed": -0.50,
}
HEDGES: frozenset[str] = frozenset({
    "no", "not", "never", "without", "unlikely", "false", "unfounded",
    "rumor", "rumour", "rumors", "rumours", "unconfirmed",
    "dismisses", "dismissed", "refutes", "refuted",
})

# A negated claim is weaker evidence than the event itself: nothing changed, a
# hoped-for change simply did not happen. 0.45 is the damping the previous
# global rule already used, kept so scores stay comparable across the change.
NEGATION_DAMP = 0.45
# Scope, in tokens. English negation is forward-scoping ("will not cut rates"),
# so the forward window is wide; the backward window covers only the passive
# tail ("ETF approval denied", "rate cut delayed") and is deliberately tight —
# widening it to 3 starts eating "the rally is not over".
NEG_SPAN_FORWARD = 5
NEG_SPAN_BACK = 2
# Negation does not cross a clause boundary.
_CLAUSE_BREAK = re.compile(r"[;:,—]|--")

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

# Substring matching tagged "whether" as ETH (it contains "ether"), "corporate"
# as macro ("rate") and "security"/"second" as SEC-salient. A mis-tag is worse
# than no tag: `evidence_for` filters on the asset list, so an unrelated story
# silently becomes evidence on a window it has nothing to do with. Anchor every
# table lookup to word boundaries, allowing only the regular inflections a
# headline actually uses ("rates", "hacked", "crashes").
_INFLECTION = r"(?:s|es|ed)?"


def _anchored(terms: tuple[str, ...] | list[str]) -> re.Pattern[str]:
    body = "|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True))
    return re.compile(rf"\b(?:{body}){_INFLECTION}\b")


_ASSET_RE = {asset: _anchored(terms) for asset, terms in ASSET_TERMS.items()}
_MACRO_RE = _anchored(MACRO_TERMS)
_SALIENCE_RE = {term: _anchored((term,)) for term in SALIENCE_TERMS}


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _token_spans(text: str) -> list[tuple[str, int, int]]:
    """Tokens with their character offsets — negation needs the positions."""
    return [(m.group(), m.start(), m.end()) for m in _WORD.finditer(text)]


def credibility_for(url: str) -> float:
    """Source weight, anchored to a real domain boundary.

    `host.endswith(domain)` handed CoinDesk's 0.85 to "notcoindesk.com" and
    Reuters' 0.95 to "fake-reuters.com"; credibility multiplies straight into
    the evidence weight, so a name nobody vetted got a top-tier outlet's pull.
    The userinfo split matters too: "https://coindesk.com@evil.co/x" puts a
    trusted string where a host looks like it should be.
    """
    host = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", url.strip().lower()).split("/")[0]
    host = host.split("?")[0].split("#")[0]
    host = host.split("@")[-1].split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    for domain, weight in SOURCE_CREDIBILITY.items():
        if host == domain or host.endswith("." + domain):
            return weight
    return 0.5


def assets_for(title: str) -> list[str]:
    low = title.lower()
    hits = [a for a, rx in _ASSET_RE.items() if rx.search(low)]
    if hits:
        return hits
    if _MACRO_RE.search(low):
        return ["BTC", "ETH"]  # macro moves the whole risk complex
    return []


def salience_for(title: str) -> float:
    low = title.lower()
    best = 0.15
    for term, weight in SALIENCE_TERMS.items():
        if _SALIENCE_RE[term].search(low):
            best = max(best, weight)
    return round(best, 3)


def _match_terms(low: str, spans: list[tuple[str, int, int]]) -> list[list]:
    """Every directional hit as [label, weight, token_index, start, end]."""
    tokset = {t for t, _, _ in spans}
    first_span = {}
    for tok, s, e in spans:
        first_span.setdefault(tok, (s, e))

    out: list[list] = []
    for table in (BULLISH, BEARISH):
        for term, weight in table.items():
            if " " in term or "-" in term:
                hit = re.search(re.escape(term), low)
                if hit is None:
                    continue
                start, end = hit.span()
            elif term in tokset:
                start, end = first_span[term]
            else:
                continue
            out.append([term, weight, _tok_index(spans, start), start, end])

    for pattern, weight, label in PATTERNS:
        hit = pattern.search(low)
        if hit is not None:
            start, end = hit.span()
            out.append([label, weight, _tok_index(spans, start), start, end])
    return out


def _tok_index(spans: list[tuple[str, int, int]], char_start: int) -> int:
    for i, (_, s, _e) in enumerate(spans):
        if s >= char_start:
            return i
    return len(spans)


def _dedupe_overlaps(matched: list[list]) -> list[list]:
    """Keep the strongest reading of any span of text, never two of them.

    "spot ETF approval" fires both `spot etf` (+0.55) and `etf approval`
    (+0.95) on the same three words. That double-count is what let the weaker
    term survive a negator aimed at the stronger one and flip the headline back
    to bullish ("spot ETF approval delayed" scored +0.42).
    """
    kept: list[list] = []
    for m in sorted(matched, key=lambda m: abs(m[1]), reverse=True):
        if any(m[3] < k[4] and k[3] < m[4] for k in kept):
            continue
        kept.append(m)
    return kept


def _governed_by(matched: list[list], governed: set[int], neg_i: int,
                 low: str, neg_span: tuple[int, int]) -> int | None:
    """Index of the term a negator at token `neg_i` governs, if any."""
    best: tuple[float, int] | None = None
    for j, m in enumerate(matched):
        if j in governed:
            continue
        tok_j = m[2]
        if neg_i < tok_j <= neg_i + NEG_SPAN_FORWARD:
            rank, gap = float(tok_j - neg_i), (neg_span[1], m[3])
        elif neg_i - NEG_SPAN_BACK <= tok_j < neg_i:
            # Backward attachment is the passive tail, so it loses ties.
            rank, gap = (neg_i - tok_j) + 0.5, (m[4], neg_span[0])
        else:
            continue
        if _CLAUSE_BREAK.search(low[gap[0]:gap[1]]):
            continue
        if best is None or rank < best[0]:
            best = (rank, j)
    return None if best is None else best[1]


def _apply_negation(matched: list[list], spans: list[tuple[str, int, int]],
                    low: str) -> list[list]:
    governed: set[int] = set()
    for i, (tok, s, e) in enumerate(spans):
        intrinsic = REJECTORS.get(tok)
        if intrinsic is None and tok not in HEDGES:
            continue
        # A negator swallowed by a phrase it helped match ("halts withdrawals")
        # is that phrase's signal, not an operator on it. This is the guard that
        # keeps an inherently bearish construction from being counted twice.
        if any(m[3] <= s and e <= m[4] and (m[4] - m[3]) > (e - s) for m in matched):
            continue

        target = _governed_by(matched, governed, i, low, (s, e))
        if target is None:
            # A rejection with no term in scope is still a rejection: "SEC
            # denies Bitcoin ETF" names no table term, and reading it as 0.0
            # would be as wrong as reading it as +0.225.
            if intrinsic is not None:
                matched.append([tok, intrinsic, i, s, e])
            continue

        governed.add(target)
        weight = matched[target][1]
        flipped = -weight * NEGATION_DAMP
        if intrinsic is not None and weight > 0:
            # Rejecting a bullish event is a bearish event in its own right, so
            # the verb reads at least as strongly as its own weight. Counted
            # once, in whichever role reads stronger — never in both.
            flipped = min(flipped, intrinsic)
        matched[target][1] = flipped
        matched[target][0] = f"{tok} {matched[target][0]}"
    return matched


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


def score_sentiment(title: str) -> tuple[float, str]:
    """Signed sentiment in [-1, 1] plus a short human-readable rationale.

    Multi-word phrases are matched against the raw string; single words are
    matched against tokens so `ban` does not fire inside `bank`. Negation is
    then applied to the term it governs rather than to the running total.
    """
    low = title.lower()
    spans = _token_spans(low)

    matched = _dedupe_overlaps(_match_terms(low, spans))
    matched = _apply_negation(matched, spans, low)

    if not matched:
        return 0.0, "no directional terms"

    # Strongest signal leads; weaker corroborating terms add at a discount so a
    # keyword-stuffed headline cannot dominate.
    matched.sort(key=lambda m: abs(m[1]), reverse=True)
    total = matched[0][1] + sum(m[1] for m in matched[1:]) * 0.30

    boost = max((INTENSIFIERS[t] for t, _, _ in spans if t in INTENSIFIERS), default=1.0)
    total = max(-1.0, min(1.0, total * boost))
    terms = ", ".join(m[0] for m in matched[:3])
    return round(total, 3), f"matched: {terms}"
