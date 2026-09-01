"use client";

import type { ReactNode } from "react";

export function Card({
  title, subtitle, right, children,
}: {
  title: string; subtitle?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-baseline justify-between gap-4 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** A probability rendered as a bar plus a number — the core visual of the app. */
export function ProbabilityBar({
  prior, posterior, mid,
}: {
  prior: number; posterior: number; mid?: number;
}) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <div className="min-w-[11rem]">
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-ink-700">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent/80"
          style={{ width: pct(posterior) }}
        />
        {/* Prior sits behind as a tick, so the news contribution is visible. */}
        <div
          className="absolute inset-y-0 w-px bg-slate-400/70"
          style={{ left: pct(prior) }}
          title={`prior ${pct(prior)}`}
        />
        {mid !== undefined && (
          <div
            className="absolute inset-y-[-3px] w-0.5 bg-amber-300"
            style={{ left: pct(mid) }}
            title={`book mid ${pct(mid)}`}
          />
        )}
      </div>
      <div className="mono mt-1 flex justify-between text-[11px] text-slate-500">
        <span>prior {pct(prior)}</span>
        <span className="font-semibold text-accent">post {pct(posterior)}</span>
      </div>
    </div>
  );
}

export function Pill({
  tone = "neutral", children,
}: {
  tone?: "up" | "down" | "neutral" | "warn"; children: ReactNode;
}) {
  const tones = {
    up: "bg-up/15 text-up border-up/30",
    down: "bg-down/15 text-down border-down/30",
    warn: "bg-amber-400/15 text-amber-300 border-amber-400/30",
    neutral: "bg-white/5 text-slate-400 border-white/10",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return "closed";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
