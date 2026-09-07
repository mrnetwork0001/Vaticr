"use client";
/**
 * The hero's live panel: one real window, the model's price beside the book's,
 * and the gap between them.
 *
 * This is the product in a single frame, so it uses real data or it says
 * nothing. A hero that invents a plausible-looking number to look busy is
 * exactly the kind of thing the rest of this site argues against.
 */
import { useEffect, useState } from "react";

const VENUE = process.env.NEXT_PUBLIC_VENUE_ID ?? "";

interface Row {
  asset: string;
  windowSec: number;
  secondsLeft: number;
  posterior: number;
  bid: number | null;
  ask: number | null;
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

export default function HeroScene() {
  const [row, setRow] = useState<Row | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "off">("loading");

  useEffect(() => {
    let cancelled = false;
    const q = VENUE ? `venue=${VENUE}&` : "";

    const load = async () => {
      try {
        const fc = await json<any[]>(`/api/vaticr/forecasts?${q}limit=12`);
        const live = fc.filter((e) => e.forecast?.market_id && e.forecast.seconds_left > 120);
        if (!live.length) throw new Error("no live windows");
        const ids = live.map((e) => e.forecast.market_id).join(",");
        const { tops } = await json<{ tops: any[] }>(`/api/book?markets=${ids}`);
        const byId = new Map(tops.map((t) => [t.market_id, t]));

        // Show the window where the model and the book disagree most - that
        // gap is the entire argument, and picking the first row would bury it.
        let best: Row | null = null;
        let bestEdge = -1;
        for (const e of live) {
          const f = e.forecast;
          const t = byId.get(f.market_id) ?? {};
          const bid = t.best_bid ?? null;
          const ask = t.best_ask ?? null;
          const edge = Math.max(
            ask !== null ? f.posterior - ask : -1,
            bid !== null ? bid - f.posterior : -1,
          );
          if (edge > bestEdge) {
            bestEdge = edge;
            best = {
              asset: f.asset, windowSec: f.window_sec, secondsLeft: f.seconds_left,
              posterior: f.posterior, bid, ask,
            };
          }
        }
        if (!cancelled && best) { setRow(best); setState("ok"); }
      } catch {
        if (!cancelled) setState("off");
      }
    };
    void load();
    const t = setInterval(load, 12_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const mid = row && row.bid !== null && row.ask !== null ? (row.bid + row.ask) / 2 : null;
  const edge = row && row.ask !== null ? row.posterior - row.ask : null;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900">
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <span
          className={`hero-pulse h-1.5 w-1.5 rounded-full ${
            state === "ok" ? "bg-up" : state === "off" ? "bg-down" : "bg-gray-600"
          }`}
        />
        <span className="font-mono text-[11px] text-gray-400">
          {state === "ok" && row
            ? `vaticr · pricing ${row.asset} ${row.windowSec}s · ${Math.floor(row.secondsLeft / 60)}m ${Math.floor(row.secondsLeft % 60)}s left`
            : state === "off"
              ? "vaticr · intelligence layer offline - run npm run api"
              : "vaticr · connecting"}
        </span>
      </div>

      {state === "ok" && row ? (
        <div className="px-4 py-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-market">the book</div>
              <div className="mono mt-0.5 text-2xl font-bold text-market">
                {row.ask !== null ? pct(row.ask) : "-"}
              </div>
              <div className="mono text-[10px] text-gray-500">best offer on YES</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-500">gap</div>
              <div className={`mono mt-0.5 text-2xl font-bold ${edge !== null && edge > 0 ? "text-up" : "text-gray-400"}`}>
                {edge !== null ? `${edge > 0 ? "+" : ""}${edge.toFixed(3)}` : "-"}
              </div>
              <div className="mono text-[10px] text-gray-500">per share</div>
            </div>
            <div className="text-right">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-model">vaticr</div>
              <div className="mono mt-0.5 text-2xl font-bold text-model">{pct(row.posterior)}</div>
              <div className="mono text-[10px] text-gray-500">posterior on YES</div>
            </div>
          </div>

          <div className="relative mt-4 h-2 w-full overflow-hidden rounded bg-ink-700">
            <div
              className="hero-fill absolute inset-y-0 left-0 rounded bg-model/80"
              style={{ width: pct(row.posterior) }}
            />
            {mid !== null && (
              <div
                className="absolute inset-y-[-3px] w-0.5 bg-market"
                style={{ left: pct(mid) }}
                title={`book mid ${pct(mid)}`}
              />
            )}
          </div>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-gray-500">
            model <span className="text-model">{pct(row.posterior)}</span> · book{" "}
            <span className="text-market">{mid !== null ? pct(mid) : "-"}</span>
            {edge !== null && edge > 0 ? (
              <> · buying YES pays <span className="text-up">{edge.toFixed(3)}</span> under fair value</>
            ) : (
              <> · no takeable edge on this window right now</>
            )}
          </p>
        </div>
      ) : (
        <div className="px-4 py-8 text-center font-mono text-[11px] text-gray-600">
          {state === "off" ? "no live data" : "reading the book…"}
        </div>
      )}
    </div>
  );
}
