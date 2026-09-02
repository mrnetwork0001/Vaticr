"use client";

import { ago } from "./ui";
import type { EvidenceItem, ForecastEnvelope, Headline } from "./types";

export function logit(p: number): number {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return Math.log(q / (1 - q));
}

export const signed = (n: number, digits = 3) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

/**
 * Which headlines moved this window's posterior, and by how much.
 *
 * The log-likelihood ratios are printed with their sign and their decay rather
 * than summarised, because the whole claim of the pricing model is that the
 * combination is additive and therefore checkable by hand: the arithmetic line
 * at the bottom is the same sum the engine did.
 */
export function Evidence({
  forecast, headlines, panelId,
}: {
  forecast: ForecastEnvelope["forecast"];
  headlines: Headline[];
  panelId: string;
}) {
  const items = forecast.evidence;
  const raw = items.reduce((t, e) => t + e.log_likelihood_ratio, 0);
  const applied = forecast.evidence_log_odds;
  // The engine caps the total so a burst of correlated stories cannot run the
  // posterior into a corner; say so when the cap actually bit.
  const capped = Math.abs(raw - applied) > 5e-4;
  const peak = Math.max(...items.map((e) => Math.abs(e.log_likelihood_ratio)), 1e-6);

  return (
    <div id={panelId} className="border-t border-white/5 bg-ink-950/40 px-4 py-3">
      {items.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-slate-400">
          No headline cleared the relevance floor for this window, so the
          posterior is the price-process prior unchanged. That is the normal
          state: most windows are not about anything.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((e: EvidenceItem) => {
            const url = headlines.find((h) => h.id === e.headline_id)?.url;
            const up = e.log_likelihood_ratio > 0;
            const width = `${(Math.abs(e.log_likelihood_ratio) / peak) * 100}%`;
            return (
              <li key={e.headline_id} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-[12rem] flex-1">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12.5px] leading-snug text-slate-200 hover:text-white hover:underline"
                    >
                      {e.title}
                    </a>
                  ) : (
                    <span className="text-[12.5px] leading-snug text-slate-200">
                      {e.title}
                    </span>
                  )}
                  <div className="mono mt-0.5 text-[10.5px] text-slate-400">
                    {e.source} · {ago(Math.floor(Date.now() / 1000) - e.age_sec)} · decay{" "}
                    {e.decay.toFixed(2)}
                  </div>
                </div>
                <div className="w-32">
                  {/* The bar is scaled to the largest contribution in this
                      window, so it ranks; the number carries the value. */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                    <div
                      className={`h-full rounded-full ${up ? "bg-up" : "bg-down"}`}
                      style={{ width }}
                    />
                  </div>
                  <div
                    className={`mono mt-0.5 text-right text-[11px] ${up ? "text-up" : "text-down"}`}
                  >
                    {up ? "↑" : "↓"} LLR {signed(e.log_likelihood_ratio)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mono mt-3 border-t border-white/5 pt-2.5 text-[11px] leading-relaxed text-slate-400">
        logit(prior) {signed(logit(forecast.prior))} {" + evidence "}
        {signed(applied)} {" = logit(posterior) "}
        {signed(logit(forecast.posterior))}
        {capped && (
          <span className="ml-1 text-amber-300">
            (raw sum {signed(raw)}, capped)
          </span>
        )}
      </p>
    </div>
  );
}

