"""Runtime configuration for the Vaticr agent layer.

Everything is env-driven so the bot, the API and the CLI agents agree on one
source of truth. Values mirror the DreamDEX testnet deployment documented at
https://docs.dreamdex.io/developers/event-contracts.
"""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ---- Network -----------------------------------------------------------
    network: str = Field(default="testnet", alias="NETWORK")
    somnia_rpc: str = Field(
        default="https://api.infra.testnet.somnia.network", alias="RPC_URL"
    )

    # ---- Vaticr API --------------------------------------------------------
    api_host: str = Field(default="127.0.0.1", alias="VATICR_API_HOST")
    api_port: int = Field(default=8787, alias="VATICR_API_PORT")

    # ---- Scout (headline ingestion) ---------------------------------------
    # Comma-separated RSS/Atom feeds. All keyless by default so a fresh clone
    # produces real signal with zero configuration.
    news_feeds: str = Field(
        default=",".join(
            [
                "https://www.coindesk.com/arc/outboundfeeds/rss/",
                "https://cointelegraph.com/rss",
                "https://decrypt.co/feed",
                "https://bitcoinmagazine.com/feed",
                "https://www.federalreserve.gov/feeds/press_monetary.xml",
            ]
        ),
        alias="VATICR_NEWS_FEEDS",
    )
    # Optional keyed sources; skipped silently when the key is absent.
    cryptopanic_token: str | None = Field(default=None, alias="CRYPTOPANIC_TOKEN")

    scout_poll_sec: int = Field(default=45, alias="VATICR_SCOUT_POLL_SEC")
    # How long a headline stays in the rolling window. Kept wide on purpose:
    # recency is priced by the exponential decay below, not by a hard cliff, so
    # a cutoff here would only throw away evidence the engine already discounts.
    headline_ttl_sec: int = Field(default=86_400, alias="VATICR_HEADLINE_TTL_SEC")
    # Half-life of headline evidence, in seconds. At one half-life a headline
    # carries half its original log-odds weight.
    evidence_half_life_sec: float = Field(
        default=1_800.0, alias="VATICR_EVIDENCE_HALF_LIFE_SEC"
    )
    http_timeout_sec: float = Field(default=12.0, alias="VATICR_HTTP_TIMEOUT")

    # ---- LLM classifier (optional) ----------------------------------------
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    llm_model: str = Field(default="claude-opus-5", alias="VATICR_LLM_MODEL")
    llm_enabled: bool = Field(default=True, alias="VATICR_LLM_ENABLED")

    # ---- Bayesian engine ---------------------------------------------------
    # Global scaling on headline evidence, in log-odds. Tuned so a single
    # maximally-bullish top-tier headline moves a 0.50 prior to ~0.62.
    evidence_kappa: float = Field(default=0.50, alias="VATICR_EVIDENCE_KAPPA")
    # Hard cap on total headline evidence (log-odds), both directions. Stops a
    # burst of correlated headlines from running the posterior to a corner.
    evidence_cap: float = Field(default=1.20, alias="VATICR_EVIDENCE_CAP")
    # Posterior is never allowed outside these bounds.
    prob_floor: float = Field(default=0.02, alias="VATICR_PROB_FLOOR")
    prob_ceil: float = Field(default=0.98, alias="VATICR_PROB_CEIL")
    # Fallback annualised vol when the tick history is too thin to estimate.
    fallback_annual_vol: float = Field(default=0.35, alias="VATICR_FALLBACK_VOL")
    # Grid the oracle series is resampled onto before differencing. The feed is
    # an EMA at 1s resolution; differencing it raw measures the smoothing rather
    # than the volatility. See `realized_vol_per_sec`.
    vol_sample_step_sec: int = Field(default=30, alias="VATICR_VOL_STEP_SEC")

    # ---- Storage -----------------------------------------------------------
    state_dir: str = Field(default=".vaticr", alias="VATICR_STATE_DIR")

    @property
    def feeds(self) -> list[str]:
        return [f.strip() for f in self.news_feeds.split(",") if f.strip()]

    @property
    def llm_ready(self) -> bool:
        return bool(self.llm_enabled and self.anthropic_api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def state_path(*parts: str) -> str:
    s = get_settings()
    root = os.path.abspath(s.state_dir)
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, *parts)
