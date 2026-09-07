"use client";

import type { ReactNode } from "react";

export function Card({
  title, subtitle, right, children, id,
}: {
  title: string; subtitle?: string; right?: ReactNode; children: ReactNode; id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="card min-w-0 overflow-hidden" aria-labelledby={headingId}>
      <header className="flex items-baseline justify-between gap-4 border-b border-white/10 px-4 py-3">
        <div>
          <h2 id={headingId} className="text-sm font-semibold tracking-wide text-slate-100">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/**
 * A probability rendered as a bar plus a number - the core visual of the app.
 *
 * Every quantity on the bar is also printed as text underneath. The bar is
 * decoration; the numbers are the content. That is what keeps it readable for
 * someone who cannot separate the accent violet from the amber mid marker.
 */
export function ProbabilityBar({
  prior, posterior, mid,
}: {
  prior: number; posterior: number; mid?: number | null;
}) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const label =
    `posterior ${pct(posterior)}, prior ${pct(prior)}` +
    (mid != null ? `, book mid ${pct(mid)}` : ", no book mid");
  return (
    <div className="min-w-[11rem]">
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-ink-700"
        role="img"
        aria-label={label}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent/80"
          style={{ width: pct(posterior) }}
        />
        {/* Prior sits behind as a tick, so the news contribution is visible. */}
        <div
          className="absolute inset-y-0 w-px bg-slate-200/80"
          style={{ left: pct(prior) }}
        />
        {mid != null && (
          <div
            className="absolute inset-y-[-3px] w-0.5 bg-amber-300"
            style={{ left: pct(mid) }}
          />
        )}
      </div>
      <div className="mono mt-1 flex flex-wrap justify-between gap-x-2 text-[11px] text-slate-400">
        <span>prior {pct(prior)}</span>
        {/* The mid is named in text, not only marked in amber. */}
        <span className={mid != null ? "text-amber-300" : "text-slate-400"}>
          mid {mid != null ? pct(mid) : "-"}
        </span>
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
    neutral: "bg-white/5 text-slate-300 border-white/10",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * A shimmering placeholder. Its only job is to say "a number is coming" rather
 * than "there is nothing here" - the two read identically once a panel has
 * already committed to an em dash.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton block rounded ${className}`} aria-hidden />;
}

/**
 * The three states every fetched panel needs to tell apart. Collapsing loading
 * into empty is the bug that makes a working app look broken on first paint.
 */
export function PanelState({
  state, empty, children,
}: {
  state: "loading" | "empty" | "error";
  empty?: string;
  children?: ReactNode;
}) {
  if (state === "loading") {
    return (
      <div className="px-4 py-8" role="status" aria-live="polite">
        <span className="sr-only">Loading</span>
        <div className="space-y-2.5">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="px-4 py-6 text-sm text-down" role="status" aria-live="polite">
        {children}
      </div>
    );
  }
  return (
    <p className="px-4 py-8 text-center text-sm text-slate-400">
      {empty ?? "Nothing here yet."}
    </p>
  );
}

/**
 * The unreachable-backend state, said the same way in both places it can
 * happen: name the process, then give the exact command that starts it.
 */
export function BackendDown({ detail }: { detail?: string }) {
  return (
    <div
      className="rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-5 py-4"
      role="status"
      aria-live="polite"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        Intelligence layer unreachable
      </h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-300">
        The dashboard is a view onto the Python forecasting service. Nothing
        below can be filled in until it is running. Start it with:
      </p>
      <pre className="mono mt-3 w-fit rounded-lg border border-white/10 bg-ink-950/70 px-4 py-2.5 text-[12.5px] text-slate-200">
        npm run api
      </pre>
      {detail && (
        <p className="mono mt-3 text-[11px] leading-relaxed text-slate-400">{detail}</p>
      )}
    </div>
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
