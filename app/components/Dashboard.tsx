"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Pill, ProbabilityBar, ago, countdown } from "./ui";
import type {
  AuditResponse, ForecastEnvelope, Headline, Health,
} from "./types";

const VENUE = process.env.NEXT_PUBLIC_VENUE_ID ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/vaticr/${path}`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.hint ?? body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [forecasts, setForecasts] = useState<ForecastEnvelope[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number>(0);

  const venueQuery = VENUE ? `venue=${VENUE}&` : "";

  const refresh = useCallback(async () => {
    try {
      const [h, f, n, a] = await Promise.all([
        get<Health>("health"),
        get<ForecastEnvelope[]>(`forecasts?${venueQuery}limit=12`),
        get<Headline[]>("headlines?limit=14"),
        get<AuditResponse>(`audit?${venueQuery}limit=10`),
      ]);
      setHealth(h); setForecasts(f); setHeadlines(n); setAudit(a);
      setError(null); setUpdated(Date.now());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [venueQuery]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <a
            href="/"
            className="mb-1 inline-flex items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
          >
            <span aria-hidden>&larr;</span> Back to overview
          </a>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Vaticr
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Bayesian forecasting and autonomous market making on DreamDEX Event
            Contracts. A price-process prior, tilted by decayed news evidence,
            quoted against the live on-chain book.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {health && (
            <>
              <Pill tone="up">somnia {health.network}</Pill>
              <Pill>{health.headlines_in_window} headlines</Pill>
              <Pill tone={health.llm_classifier.startsWith("on") ? "up" : "neutral"}>
                classifier {health.llm_classifier.startsWith("on") ? "LLM" : "lexicon"}
              </Pill>
            </>
          )}
          {updated > 0 && (
            <span className="mono text-[11px] text-slate-600">
              updated {new Date(updated).toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-down/30 bg-down/10 px-4 py-3 text-sm text-down">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title="Live windows"
            subtitle="P(closes at or above its opening price)"
            right={<Pill>{forecasts.length} markets</Pill>}
          >
            <div className="divide-y divide-white/5">
              {forecasts.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-slate-500">
                  No live windows in scope.
                </p>
              )}
              {forecasts.map((e) => {
                const f = e.forecast;
                const news = f.evidence_log_odds;
                return (
                  <div key={f.market_id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                    <div className="min-w-[9rem] flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-100">{f.asset}</span>
                        <Pill>{Math.round(f.window_sec)}s window</Pill>
                      </div>
                      <div className="mono mt-1 text-[11px] text-slate-500">
                        open {f.open_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        {" · now "}
                        <span className={f.spot >= f.open_price ? "text-up" : "text-down"}>
                          {f.spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>

                    <ProbabilityBar prior={f.prior} posterior={f.posterior} />

                    <div className="min-w-[5.5rem] text-right">
                      <div className="mono text-xs text-slate-400">
                        {countdown(f.seconds_left)}
                      </div>
                      <div className="mono text-[11px] text-slate-600">
                        vol {(f.annual_vol * 100).toFixed(1)}%
                      </div>
                    </div>

                    <div className="min-w-[4.5rem] text-right">
                      {Math.abs(news) > 0.0005 ? (
                        <Pill tone={news > 0 ? "up" : "down"}>
                          news {news > 0 ? "+" : ""}{news.toFixed(3)}
                        </Pill>
                      ) : (
                        <Pill>no news</Pill>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="mt-5">
            <Card
              title="Settlement audit"
              subtitle="Every settlement recomputed from the public oracle feed"
              right={
                audit && (
                  <div className="flex gap-1.5">
                    <Pill tone={audit.mismatched === 0 ? "up" : "down"}>
                      {audit.verified}/{audit.total} verified
                    </Pill>
                    {audit.inconclusive > 0 && (
                      <Pill tone="warn">{audit.inconclusive} too close to call</Pill>
                    )}
                  </div>
                )
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500">
                    <tr className="border-b border-white/5">
                      <th className="px-4 py-2 font-medium">Window</th>
                      <th className="px-3 py-2 font-medium">Open</th>
                      <th className="px-3 py-2 font-medium">Close</th>
                      <th className="px-3 py-2 font-medium">Margin</th>
                      <th className="px-3 py-2 font-medium">On-chain</th>
                      <th className="px-3 py-2 font-medium">Recomputed</th>
                      <th className="px-3 py-2 font-medium">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {audit?.settlements.map((s) => (
                      <tr key={s.market_id}>
                        <td className="px-4 py-2 text-slate-300">{s.symbol}</td>
                        <td className="mono px-3 py-2 text-slate-500">
                          {s.open_reference?.toFixed(2) ?? "-"}
                        </td>
                        <td className="mono px-3 py-2 text-slate-500">
                          {s.close_reference?.toFixed(2) ?? "-"}
                        </td>
                        <td className="mono px-3 py-2 text-slate-500">
                          {s.margin_bps === null
                            ? "-"
                            : `${s.margin_bps > 0 ? "+" : ""}${s.margin_bps.toFixed(2)}bp`}
                        </td>
                        <td className="px-3 py-2">
                          <Pill tone={s.onchain_outcome === "up" ? "up" : "down"}>
                            {s.onchain_outcome}
                          </Pill>
                        </td>
                        <td className="px-3 py-2">
                          <Pill
                            tone={
                              s.verdict === "match"
                                ? "up"
                                : s.verdict === "MISMATCH"
                                  ? "down"
                                  : "warn"
                            }
                          >
                            {s.verdict}
                          </Pill>
                        </td>
                        <td className="px-3 py-2">
                          {s.receipt_url && (
                            <a
                              className="text-accent hover:underline"
                              href={s.receipt_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              #{s.oracle_question_id}
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {audit && (
                <div className="border-t border-white/5 px-4 py-2 text-[11px] leading-relaxed text-slate-600">
                  <p>reference series: {audit.reference}</p>
                  {audit.inconclusive > 0 && (
                    <p className="mt-1">
                      &ldquo;too close to call&rdquo; means the window was decided by
                      under 1bp &mdash; finer than a reconstruction from the public
                      feed can resolve, since the oracle settles on its own sampled
                      tick. It is not a disputed settlement; open the receipt to see
                      the sources that decided it.
                    </p>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>

        <Card
          title="Headline evidence"
          subtitle="Scored for directional impact on BTC / ETH"
          right={<Pill>{headlines.length}</Pill>}
        >
          <ul className="max-h-[46rem] divide-y divide-white/5 overflow-y-auto">
            {headlines.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-slate-500">
                No scored headlines yet.
              </li>
            )}
            {headlines.map((h) => {
              const tone = h.sentiment > 0.05 ? "up" : h.sentiment < -0.05 ? "down" : "neutral";
              return (
                <li key={h.id} className="px-4 py-3">
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[13px] leading-snug text-slate-200 hover:text-white"
                  >
                    {h.title}
                  </a>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Pill tone={tone}>
                      {h.sentiment > 0 ? "+" : ""}{h.sentiment.toFixed(2)}
                    </Pill>
                    <Pill>sal {h.salience.toFixed(2)}</Pill>
                    {h.assets.map((a) => <Pill key={a}>{a}</Pill>)}
                    <span className="mono text-[10px] text-slate-600">
                      {h.source} · {ago(h.published_at)}
                    </span>
                  </div>
                  {h.rationale && (
                    <p className="mt-1 text-[11px] text-slate-600">{h.rationale}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <footer className="mt-8 text-center text-[11px] text-slate-600">
        Vaticr · Somnia × DreamDEX Event Contracts Hackathon · Apache-2.0 ·
        markets and settlement are DreamDEX protocol; forecasting is Vaticr.
      </footer>
    </main>
  );
}
