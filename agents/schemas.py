"""Shared wire types between the Python agents and the TypeScript bot.

These models are the contract for the FastAPI surface in `agents.server`; the
bot's `bot/src/signal.ts` mirrors them structurally.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Direction = Literal["up", "down", "neutral"]


class Headline(BaseModel):
    """One ingested news item, scored for directional evidence."""

    id: str = Field(description="Stable hash of the source URL.")
    source: str
    title: str
    url: str
    published_at: int = Field(description="Unix seconds.")
    assets: list[str] = Field(
        default_factory=list, description="Assets the headline bears on, e.g. ['BTC']."
    )
    # Directional sentiment in [-1, 1]; +1 maximally bullish.
    sentiment: float = 0.0
    # How market-moving the item is, in [0, 1].
    salience: float = 0.0
    # Source credibility weight in [0, 1].
    credibility: float = 0.5
    scorer: Literal["lexicon", "llm"] = "lexicon"
    rationale: str = ""

    @property
    def direction(self) -> Direction:
        if self.sentiment > 0.05:
            return "up"
        if self.sentiment < -0.05:
            return "down"
        return "neutral"


class EvidenceItem(BaseModel):
    """A single headline's contribution to the posterior, in log-odds."""

    headline_id: str
    title: str
    source: str
    age_sec: int
    log_likelihood_ratio: float = Field(
        description="Signed contribution to the posterior log-odds."
    )
    decay: float = Field(description="Time-decay multiplier applied, in [0, 1].")


class Forecast(BaseModel):
    """The Bayesian posterior for one event-contract window."""

    asset: str
    market_id: str | None = None
    symbol: str | None = None

    # Window geometry
    open_price: float = Field(description="The line to beat (window opening price).")
    spot: float = Field(description="Current underlying price.")
    seconds_left: float
    window_sec: float

    # Volatility used, expressed per-annum for legibility.
    annual_vol: float
    vol_source: Literal["realized", "fallback"] = "realized"

    # The three probabilities
    prior: float = Field(description="P(Up) from the price process alone.")
    posterior: float = Field(description="P(Up) after headline evidence.")
    evidence_log_odds: float = Field(
        description="Total headline evidence applied, in log-odds."
    )

    evidence: list[EvidenceItem] = Field(default_factory=list)
    computed_at: int = Field(description="Unix seconds.")
    # Set when the engine declines to produce a tradable view.
    degraded: bool = False
    note: str = ""


class TradeIntent(BaseModel):
    """What the bot should do about a forecast, given the live book."""

    action: Literal["take_yes", "take_no", "quote", "skip"]
    edge: float = Field(description="posterior - book mid, signed.")
    reason: str
    target_probability: float


class ForecastCommitment(BaseModel):
    """A forecast recorded before settlement, for calibration scoring."""

    market_id: str
    symbol: str
    asset: str
    posterior: float
    prior: float
    committed_at: int
    expiry: int
    headline_ids: list[str] = Field(default_factory=list)
    # Filled in by the resolver once the oracle settles the window.
    outcome: Literal["up", "down", "void"] | None = None
    resolved_at: int | None = None
    brier: float | None = None
    oracle_question_id: str | None = None


class CalibrationReport(BaseModel):
    """How well Vaticr's forecasts have actually tracked reality."""

    scored: int
    brier_score: float | None = None
    # A coin-flip baseline scores 0.25; lower is better.
    baseline_brier: float = 0.25
    skill: float | None = Field(
        default=None, description="1 - brier/baseline. Positive means real edge."
    )
    accuracy: float | None = None
    buckets: list[dict] = Field(default_factory=list)
    pending: int = 0
    voided: int = 0
