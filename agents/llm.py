"""Optional LLM headline classifier — the "DeAI" half of the scout.

The lexicon in `agents.lexicon` is fast, free and deterministic, but it is
still a keyword model: it cannot read "the SEC's approval was widely expected
and is already priced in" and conclude the surprise is small. This module hands
a batch of headlines to Claude and asks for a calibrated directional read.

It is strictly an *enhancement*. Without `ANTHROPIC_API_KEY` the pipeline runs
entirely on the lexicon, and any failure here leaves the lexicon scores intact.
"""

from __future__ import annotations

import asyncio
import logging

from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .schemas import Headline

log = logging.getLogger("vaticr.llm")

MAX_BATCH = 20

SYSTEM = """You are a markets analyst scoring news headlines for a prediction \
market that trades short-horizon (1 minute to 1 hour) BTC and ETH "will this \
window close at or above its opening price" contracts.

For each headline return:
- sentiment: the expected *directional price impact on the named asset over the \
next hour*, from -1 (strongly bearish) to +1 (strongly bullish).
- salience: how market-moving the item is at all, 0 (noise) to 1 (regime-changing).
- assets: which of BTC, ETH the item bears on. Macro and market-wide items \
bear on both. Items about unrelated altcoins bear on neither — return [].

Score the SURPRISE, not the sentiment of the words. A long-expected ETF approval \
that finally lands is mostly priced in and deserves a modest score. A routine \
"Bitcoin steady" update is salience ~0.1 and sentiment ~0. Recycled or \
speculative stories ("could", "may", "report claims") deserve low salience.

Be conservative: most headlines do not move price over one hour."""


class _Score(BaseModel):
    index: int = Field(description="0-based index of the headline being scored.")
    sentiment: float = Field(ge=-1.0, le=1.0)
    salience: float = Field(ge=0.0, le=1.0)
    assets: list[str] = Field(default_factory=list)
    rationale: str = Field(description="At most 12 words.")


class _Batch(BaseModel):
    scores: list[_Score]


async def classify_batch(
    headlines: list[Headline], settings: Settings | None = None
) -> None:
    """Score `headlines` in place. Silently no-ops when unconfigured."""
    s = settings or get_settings()
    if not s.llm_ready or not headlines:
        return

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key)
    # Batch to keep a single request small and cheap; classification is easy,
    # so this runs at low effort.
    chunks = [
        headlines[i : i + MAX_BATCH] for i in range(0, len(headlines), MAX_BATCH)
    ]
    results = await asyncio.gather(
        *(_classify_chunk(client, chunk, s) for chunk in chunks),
        return_exceptions=True,
    )
    for chunk, outcome in zip(chunks, results):
        if isinstance(outcome, BaseException):
            log.warning("llm chunk failed, keeping lexicon scores: %s", outcome)
            continue
        _apply(chunk, outcome)


async def _classify_chunk(client, chunk: list[Headline], s: Settings) -> _Batch:
    listing = "\n".join(
        f"{i}. [{h.source}] {h.title}" for i, h in enumerate(chunk)
    )
    response = await client.messages.parse(
        model=s.llm_model,
        max_tokens=4096,
        system=SYSTEM,
        output_config={"effort": "low"},
        messages=[
            {
                "role": "user",
                "content": f"Score these {len(chunk)} headlines:\n\n{listing}",
            }
        ],
        output_format=_Batch,
    )
    parsed = response.parsed_output
    if parsed is None:
        raise ValueError("model returned no parsed output")
    return parsed


def _apply(chunk: list[Headline], batch: _Batch) -> None:
    for score in batch.scores:
        if not 0 <= score.index < len(chunk):
            continue
        headline = chunk[score.index]
        assets = [a.upper() for a in score.assets if a.upper() in ("BTC", "ETH")]
        # The model is allowed to *narrow* the asset set (it understands that an
        # altcoin story naming Bitcoin in passing is not a BTC signal), but an
        # empty result on a headline the lexicon tagged keeps the lexicon's view
        # only when the model also called it non-salient.
        if assets or score.salience < 0.2:
            headline.assets = assets
        headline.sentiment = max(-1.0, min(1.0, score.sentiment))
        headline.salience = max(0.0, min(1.0, score.salience))
        headline.scorer = "llm"
        headline.rationale = score.rationale[:120]
