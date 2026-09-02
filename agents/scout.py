"""Subsystem 1 — the Headline-to-Signal Factory.

Scans live financial and Web3 news feeds, normalises every item into a
`Headline`, and scores it for directional evidence on BTC/ETH.

Design note (why this is not a "contract factory"):
DreamDEX Event Contracts are protocol-created rolling Up/Down windows on BTC
and ETH price — `BinaryMarketsModule` mints them per window and there is no
permissionless "create a market from this question" entry point. So Vaticr does
not deploy markets from headlines; it converts headlines into a *tradable view*
on the windows the protocol is already running. See docs/ARCHITECTURE.md.

The scout is deliberately keyless: the default feed list is public RSS, so a
clean clone produces real signal with no configuration.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from .config import Settings, get_settings
from .lexicon import assets_for, credibility_for, salience_for, score_sentiment
from .schemas import Headline

log = logging.getLogger("vaticr.scout")

# RSS and Atom in one pass.
_TITLE = ("title", "{http://www.w3.org/2005/Atom}title")
_LINK = ("link", "{http://www.w3.org/2005/Atom}link")
_SOURCE = ("source", "{http://www.w3.org/2005/Atom}source")
_DATE = (
    "pubDate",
    "published",
    "updated",
    "{http://www.w3.org/2005/Atom}published",
    "{http://www.w3.org/2005/Atom}updated",
    "{http://purl.org/dc/elements/1.1/}date",
)


def _first_text(node: ET.Element, names: tuple[str, ...]) -> str:
    for name in names:
        el = node.find(name)
        if el is None:
            continue
        if (el.text or "").strip():
            return (el.text or "").strip()
        # Atom links carry the URL on href rather than as text.
        href = el.get("href")
        if href:
            return href.strip()
    return ""


# An item whose date we cannot read must not masquerade as breaking news.
# Defaulting to now() is the dangerous choice: evidence decays on a 30 min
# half-life, so one feed with a format `parsedate_to_datetime` chokes on gets
# full weight on every scan, forever, and the engine treats week-old copy as a
# reason to cross the spread. Four half-lives back is the safe default — the
# item still sits inside the 24 h window and is still visible in /headlines,
# but it enters at 2^-4 = 6% weight and can corroborate without deciding.
# (Dropping it outright would silently delete a whole feed over a date bug.)
_UNDATED_AGE_SEC = 7_200


def _attribution(entry: ET.Element) -> tuple[str, str]:
    """(originating outlet URL, display name) for aggregator feeds that name it.

    A search aggregator republishes everything under its own host, so every item
    it carries — Reuters or a content farm — would enter at the 0.5 default
    weight because the aggregator itself is not in SOURCE_CREDIBILITY. RSS
    `<source url>` names the real publisher, so credibility can be graded again.
    Absent on ordinary feeds, where the link host is already the publisher.
    """
    for name in _SOURCE:
        el = entry.find(name)
        if el is None:
            continue
        url = (el.get("url") or "").strip()
        if url:
            return url, (el.text or "").strip()
    return "", ""


def _parse_ts(raw: str) -> int:
    """Unix seconds for a feed date, never in the future, never falsely fresh."""
    now = int(time.time())
    if not raw:
        return now - _UNDATED_AGE_SEC
    parsed: int | None = None
    try:
        parsed = int(parsedate_to_datetime(raw).timestamp())
    except (TypeError, ValueError):
        try:
            parsed = int(
                datetime.fromisoformat(raw.replace("Z", "+00:00"))
                .astimezone(timezone.utc)
                .timestamp()
            )
        except ValueError:
            parsed = None
    if parsed is None:
        return now - _UNDATED_AGE_SEC
    # A future pubDate — a timezone the publisher got backwards, or a CMS clock
    # that drifted — otherwise never ages: `_prune` keeps it (published_at is
    # always >= cutoff) and the decay term reads a negative age, so a single bad
    # row would pin itself at full weight in the window permanently. Clamping to
    # now keeps the item usable and lets it decay like everything else.
    return min(parsed, now)


def _entries(xml_text: str) -> list[ET.Element]:
    root = ET.fromstring(xml_text)
    items = root.findall(".//item")
    if items:
        return items
    return root.findall(".//{http://www.w3.org/2005/Atom}entry")


def score_headline(
    title: str, url: str, source: str, published_at: int, attribution: str = ""
) -> Headline:
    """Turn a raw news item into a scored `Headline` (lexicon path).

    `attribution`, when given, is the originating outlet's URL and is what
    credibility is read from; `url` stays the link the reader follows and the
    identity the dedupe hash is built on.
    """
    sentiment, rationale = score_sentiment(title)
    return Headline(
        id=hashlib.sha256(url.encode("utf-8")).hexdigest()[:16],
        source=source,
        title=title,
        url=url,
        published_at=published_at,
        assets=assets_for(title),
        sentiment=sentiment,
        salience=salience_for(title),
        credibility=credibility_for(attribution or url),
        scorer="lexicon",
        rationale=rationale,
    )


async def _fetch_feed(client: httpx.AsyncClient, url: str) -> list[Headline]:
    try:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
        entries = _entries(resp.text)
    except (httpx.HTTPError, ET.ParseError) as exc:
        # A dead feed must never take the scout down — the others still vote.
        log.warning("feed failed %s: %s", url, exc)
        return []

    feed_host = url.split("/")[2] if "//" in url else url
    out: list[Headline] = []
    for entry in entries:
        title = _first_text(entry, _TITLE)
        link = _first_text(entry, _LINK)
        if not title or not link:
            continue
        attribution, outlet = _attribution(entry)
        # Aggregators append " - Outlet" to every title. That tail is not part
        # of the claim and its tokens reach the scorer: "…rejects the deal -
        # Fortune" would put an outlet name inside a negator's scope.
        if outlet and title.endswith(f" - {outlet}"):
            title = title[: -len(outlet) - 3].rstrip()
        source = attribution.split("/")[2] if "//" in attribution else feed_host
        out.append(
            score_headline(
                title, link, source, _parse_ts(_first_text(entry, _DATE)), attribution
            )
        )
    return out


async def _fetch_cryptopanic(
    client: httpx.AsyncClient, token: str
) -> list[Headline]:
    url = "https://cryptopanic.com/api/v1/posts/"
    params = {"auth_token": token, "currencies": "BTC,ETH", "kind": "news"}
    try:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("cryptopanic failed: %s", exc)
        return []

    out: list[Headline] = []
    for post in payload.get("results", []):
        title = (post.get("title") or "").strip()
        link = post.get("url") or post.get("source", {}).get("url") or ""
        if not title or not link:
            continue
        out.append(
            score_headline(
                title, link, "cryptopanic.com", _parse_ts(post.get("published_at", ""))
            )
        )
    return out


class Scout:
    """Maintains a rolling, de-duplicated window of scored headlines."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._by_id: dict[str, Headline] = {}
        self._last_scan: int = 0
        self._last_error: str = ""

    # -- state ---------------------------------------------------------------
    @property
    def last_scan(self) -> int:
        return self._last_scan

    def _prune(self) -> None:
        cutoff = time.time() - self.settings.headline_ttl_sec
        self._by_id = {
            k: h for k, h in self._by_id.items() if h.published_at >= cutoff
        }

    def fresh(self, asset: str | None = None) -> list[Headline]:
        """Live headlines, newest first, optionally filtered to one asset."""
        self._prune()
        items = list(self._by_id.values())
        if asset:
            items = [h for h in items if asset.upper() in h.assets]
        return sorted(items, key=lambda h: h.published_at, reverse=True)

    # -- ingestion -----------------------------------------------------------
    async def scan(self) -> list[Headline]:
        """Fetch every source once and merge new items into the window."""
        s = self.settings
        timeout = httpx.Timeout(s.http_timeout_sec)
        headers = {"User-Agent": "Vaticr/1.0 (+https://github.com/mrnetwork0001/Vaticr)"}

        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            tasks = [_fetch_feed(client, u) for u in s.feeds]
            if s.cryptopanic_token:
                tasks.append(_fetch_cryptopanic(client, s.cryptopanic_token))
            batches = await asyncio.gather(*tasks, return_exceptions=True)

        added: list[Headline] = []
        failures = 0
        for batch in batches:
            if isinstance(batch, BaseException):
                failures += 1
                continue
            for headline in batch:
                if headline.id in self._by_id:
                    continue
                # Only keep items that bear on a tradable asset.
                if not headline.assets:
                    continue
                self._by_id[headline.id] = headline
                added.append(headline)

        self._last_scan = int(time.time())
        self._last_error = f"{failures} source(s) failed" if failures else ""
        self._prune()

        if added:
            log.info(
                "scout: +%d new headline(s) (%d in window)", len(added), len(self._by_id)
            )
        return added

    async def enrich(self, headlines: list[Headline]) -> None:
        """Upgrade lexicon scores with the LLM classifier, when configured."""
        if not headlines or not self.settings.llm_ready:
            return
        try:
            from .llm import classify_batch

            await classify_batch(headlines, self.settings)
        except Exception as exc:  # noqa: BLE001 — never let the LLM break ingestion
            log.warning("llm enrichment skipped: %s", exc)

    async def run_forever(self) -> None:
        """Background loop used by the FastAPI lifespan."""
        while True:
            try:
                added = await self.scan()
                await self.enrich(added)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.exception("scout cycle failed: %s", exc)
            await asyncio.sleep(self.settings.scout_poll_sec)


async def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    scout = Scout()
    await scout.scan()
    await scout.enrich(scout.fresh())
    items = scout.fresh()
    print(f"\n{len(items)} live headline(s) bearing on BTC/ETH:\n")
    for h in items[:25]:
        age = int(time.time() - h.published_at)
        arrow = {"up": "^", "down": "v", "neutral": "-"}[h.direction]
        print(
            f" {arrow} s={h.sentiment:+.2f} sal={h.salience:.2f} "
            f"cred={h.credibility:.2f} {age//60:>3}m {','.join(h.assets):<8} "
            f"[{h.scorer}] {h.title[:88]}"
        )


if __name__ == "__main__":
    asyncio.run(_main())
