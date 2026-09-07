/** Landing-page primitives: section shell, cards, code, chips. */
import type { CSSProperties, ReactNode } from "react";
import Reveal from "./Reveal";

/** Stagger index for children of a `.stagger` list inside a Reveal. */
export const nth = (n: number): CSSProperties => ({ ["--n" as string]: n }) as CSSProperties;

export const BRAND = { model: "#818cf8", market: "#F0B90B" };
export const STATUS = { up: "#34d399", down: "#fb7185", warn: "#fab219", dim: "#9ca3af" };

export function Section({
  id, eyebrow, title, lead, children, className = "",
}: {
  id: string; eyebrow: string; title: string; lead?: ReactNode;
  children: ReactNode; className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 border-t border-ink-700/70 py-14 sm:py-20 ${className}`}>
      <div className="mx-auto w-full max-w-page px-4 sm:px-6">
        <Reveal>
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="mt-2 text-balance text-2xl font-bold tracking-tight text-gray-100 sm:text-3xl">
            {title}
          </h2>
          {lead ? (
            <div className="mt-3 max-w-3xl text-[15px] leading-relaxed text-gray-400">{lead}</div>
          ) : null}
        </Reveal>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-ink-700 bg-ink-900 p-5 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-gray-600 ${className}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, className = "" }: { children: string; className?: string }) {
  return (
    <pre className={`overflow-x-auto rounded-md border border-ink-700 bg-ink-950 p-3 font-mono text-[13px] leading-relaxed text-gray-200 ${className}`}>
      <code>{children}</code>
    </pre>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`rounded bg-ink-800 px-1 py-0.5 font-mono text-[0.92em] text-gray-200 ${className}`}>{children}</code>;
}

export function Tag({
  children, color = STATUS.dim, className = "",
}: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      style={{ color, borderColor: color + "66", background: color + "14" }}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 font-mono text-xs font-semibold leading-5 ${className}`}
    >
      {children}
    </span>
  );
}

/** A right-aligned numeric cell. Money and probabilities line up or they lie. */
export function Num({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-right font-mono tabular-nums ${className}`}>{children}</td>;
}
