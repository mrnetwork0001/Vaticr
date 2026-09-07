"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "./ui";
import type { AuditResponse, Health } from "./types";

const VENUE = process.env.NEXT_PUBLIC_VENUE_ID ?? "";

interface Stats {
  markets: number | null;
  headlines: number | null;
  verified: string | null;
  network: string | null;
}

/**
 * The live strip under the hero.
 *
 * Everything here is real: it reads the same endpoints the dashboard does.
 * When the intelligence layer is not running the numbers fall back to em
 * dashes rather than zeros - a landing page claiming "0 markets verified"
 * would be worse than one admitting it cannot reach the backend.
 *
 * Before the first response lands the cells shimmer instead. An em dash on
 * first paint says "there is no such number", which is a different and wrong
 * claim from "the number has not arrived yet".
 */
/** A non-2xx must surface as offline, not parse into a "healthy" strip. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export default function LiveStats() {
  const [s, setS] = useState<Stats>({
    markets: null, headlines: null, verified: null, network: null,
  });
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = VENUE ? `venue=${VENUE}&` : "";

    const load = async () => {
      try {
        const [health, forecasts, audit] = await Promise.all([
          getJson<Health>("/api/vaticr/health"),
          getJson<unknown[]>(`/api/vaticr/forecasts?${q}limit=24`),
          getJson<AuditResponse>(`/api/vaticr/audit?${q}limit=12`),
        ]);
        if (cancelled) return;
        setS({
          markets: Array.isArray(forecasts) ? forecasts.length : null,
          headlines: health?.headlines_in_window ?? null,
          verified:
            audit?.total > 0 ? `${audit.verified}/${audit.total}` : null,
          // audit.mismatched is the number that would actually be alarming.
          network: health?.network ?? null,
        });
        setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };

    void load();
    const timer = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const loading = online === null;
  const items = [
    { label: "Live windows priced", value: s.markets, hint: "BTC & ETH, 60s–1h" },
    { label: "Settlements verified", value: s.verified, hint: "recomputed independently" },
    { label: "Headlines in window", value: s.headlines, hint: "scored for direction" },
    { label: "Network", value: s.network ? `Somnia ${s.network}` : null, hint: "chain 50312" },
  ];

  return (
    <div
      className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/[0.06] md:grid-cols-4"
      aria-busy={loading}
    >
      {items.map((it) => (
        <div key={it.label} className="bg-ink-900/90 px-5 py-4">
          <div className="mono text-xl font-semibold text-white">
            {loading ? (
              <Skeleton className="h-6 w-16" />
            ) : (
              it.value ?? <span className="text-slate-400" aria-label="unavailable">-</span>
            )}
          </div>
          <div className="mt-1 text-[12px] font-medium text-slate-300">{it.label}</div>
          <div className="text-[11px] text-slate-400">{it.hint}</div>
        </div>
      ))}
      <div
        className="col-span-2 flex items-center gap-2 bg-ink-900/90 px-5 py-2.5 md:col-span-4"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className={`pulse-dot h-1.5 w-1.5 rounded-full ${
            online === false ? "bg-down" : online ? "bg-up" : "bg-slate-400"
          }`}
        />
        <span className="text-[11px] text-slate-300">
          {online === false
            ? "Intelligence layer offline - start it with `npm run api`"
            : online
              ? "Live from Somnia testnet, refreshed every 15s"
              : "Connecting to the intelligence layer…"}
        </span>
      </div>
    </div>
  );
}
