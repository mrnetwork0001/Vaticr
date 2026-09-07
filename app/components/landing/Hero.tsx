import HeroScene from "./HeroScene";
import { Tag } from "./Section";

export default function Hero() {
  return (
    <header id="top" className="hero-grid border-b border-ink-700/70">
      <div className="mx-auto grid w-full max-w-page gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_1fr] lg:items-center">
        <div>
          <div className="hero-in">
            <Tag color="#34d399">somnia × dreamdex event contracts</Tag>
          </div>

          <h1 className="hero-in mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight text-gray-50 sm:text-5xl">
            Price the window.
            <br />
            Trade the gap.
          </h1>

          <p className="hero-in mt-5 max-w-xl text-pretty text-[16px] leading-relaxed text-gray-400">
            A DreamDEX event contract asks one question: does this window close at
            or above the price it opened at? That makes the fair value of its YES
            token a real probability — so Vaticr derives it from the price process,
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
              ["+0.3791", "backtested skill", "900 forecasts"],
              ["114", "tests", "python · ts · solidity"],
              ["12/12", "settlements", "independently recomputed"],
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
