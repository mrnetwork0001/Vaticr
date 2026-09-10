import HeroScene from "./HeroScene";

const API = (process.env.VATICR_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

/**
 * The settlement tally, read at request time.
 *
 * This was typed into the page as "12/12" and went stale the moment a
 * settlement disagreed - the hero claimed perfect agreement while the audit
 * view three clicks away showed a mismatch. A number that changes has to be
 * computed, or it becomes a claim the product itself contradicts.
 *
 * The audit recomputes every settlement from the oracle feed, which takes
 * about three seconds - too slow to block a page load on. So it is revalidated
 * at most once a minute and served from cache in between: at worst a minute
 * stale, against the months of staleness a typed number accumulated.
 *
 * On any failure the tile drops the count rather than inventing one.
 */
async function settlementTally(): Promise<[string, string] | null> {
  try {
    // No AbortSignal here: Next's patched fetch will not cache a request that
    // carries one, and the throw lands in the catch below - which is what put
    // the tile on its fallback while the call underneath was succeeding.
    const res = await fetch(`${API}/audit`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const d = (await res.json()) as { verified?: number; total?: number };
    if (typeof d.verified !== "number" || typeof d.total !== "number" || d.total === 0) return null;
    return [`${d.verified}/${d.total}`, "independently recomputed"];
  } catch {
    return null;
  }
}

export default async function Hero() {
  const tally = await settlementTally();
  return (
    <header id="top" className="hero-grid border-b border-ink-700/70">
      <div className="mx-auto grid w-full max-w-page gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_1fr] lg:items-center">
        <div>
          {/* The two verbs carry the two voices the whole app is coloured by:
              the model prices, the market is where you trade. Nothing else in
              the line is tinted, so neither colour is spent on decoration. */}
          <h1 className="hero-in mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight text-gray-50 sm:text-5xl">
            <span className="text-model">Price</span> the window.
            <br />
            <span className="text-market">Trade</span> the gap.
          </h1>

          <p className="hero-in mt-5 max-w-xl text-pretty text-[16px] leading-relaxed text-gray-400">
            A DreamDEX event contract asks one question: does this window close at
            or above the price it opened at? That makes the fair value of its YES
            token a real probability - so Vaticr derives it from the price process,
            tilts it with live news, and lets you trade the difference.
          </p>

          <div className="hero-in mt-8 flex flex-wrap items-center gap-3">
            <a
              href="/dashboard"
              className="rounded bg-model px-5 py-2.5 font-mono text-sm font-bold text-ink-950 transition hover:bg-model/90"
            >
              Launch app →
            </a>
            <a
              href="#evidence"
              className="rounded border border-ink-700 px-5 py-2.5 font-mono text-sm text-gray-200 transition hover:border-gray-600 hover:bg-ink-800"
            >
              Does it work?
            </a>
          </div>

          <dl className="mt-10 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-ink-700 bg-ink-700">
            {[
              // Frozen artefact, so correctly static: docs/evidence/backtest-2026-09-04.json
              ["+0.3791", "backtested skill", "900 forecasts"],
              // The claim no other entry can make - the forecast was public and
              // immutable while the outcome was still unknown.
              ["318s", "committed early", "onchain, before settlement"],
              // Live, because it moves.
              tally
                ? [tally[0], "settlements", tally[1]]
                : ["every", "settlement", "recomputed from the feed"],
            ].map(([v, k, s]) => (
              <div key={k} className="bg-ink-900 px-4 py-3">
                <dt className="mono text-lg font-bold text-gray-100">{v}</dt>
                <dd className="mt-0.5 text-[11px] font-medium text-gray-400">{k}</dd>
                <dd className="font-mono text-[10px] text-gray-600">{s}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="hero-in">
          <HeroScene />
          <p className="mt-3 text-center font-mono text-[10px] text-gray-600">
            live from somnia testnet · refreshed every 12s
          </p>
        </div>
      </div>
    </header>
  );
}
