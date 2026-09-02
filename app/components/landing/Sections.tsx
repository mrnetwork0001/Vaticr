import type { ReactNode } from "react";

export const GITHUB = "https://github.com/mrnetwork0001/Vaticr";
export const HACKATHON = "https://dorahacks.io/hackathon/event-contracts/detail";
export const DREAMDEX_DOCS = "https://docs.dreamdex.io/developers/event-contracts";
export const BOT_KIT = "https://github.com/somnia-chain/dreamdex-bot-kit";

export function Section({
  id, eyebrow, title, lede, children,
}: {
  id?: string; eyebrow: string; title: string; lede?: string; children?: ReactNode;
}) {
  // A <section> is only a landmark once it has an accessible name, so every
  // section names itself with its own heading rather than adding a second one.
  const headingId = `${(id ?? title).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="mx-auto max-w-6xl px-5 py-20">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={headingId} className="mt-3 max-w-3xl text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {title}
      </h2>
      {lede && (
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-slate-400">
          {lede}
        </p>
      )}
      {children}
    </section>
  );
}

export function Step({
  n, title, children,
}: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-3">
        <span className="mono flex h-7 w-7 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-xs font-semibold text-accent">
          {n}
        </span>
        <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      </div>
      <div className="mt-4 space-y-3 text-[13.5px] leading-relaxed text-slate-400">
        {children}
      </div>
    </div>
  );
}

/** A finding: something measured that changed the implementation. */
export function Finding({
  title, problem, evidence, fix,
}: { title: string; problem: string; evidence: ReactNode; fix: string }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-white/10 px-6 py-4">
        <h3 className="text-[15px] font-semibold text-white">{title}</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-400">{problem}</p>
      </div>
      <div className="bg-ink-950/50 px-6 py-4">{evidence}</div>
      <div className="border-t border-white/10 px-6 py-3.5">
        <p className="text-[13px] leading-relaxed text-slate-400">
          <span className="font-semibold text-up">Fix. </span>
          {fix}
        </p>
      </div>
    </div>
  );
}

export function Row({
  k, v, note,
}: { k: string; v: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/5 py-2.5 last:border-0">
      <span className="mono text-[12.5px] text-slate-300">{k}</span>
      <span className="text-right text-[12.5px] text-slate-400">
        {v}
        {note && <span className="ml-2 text-slate-400">{note}</span>}
      </span>
    </div>
  );
}
