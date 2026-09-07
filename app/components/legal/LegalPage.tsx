/**
 * The shell for the two prose pages, so privacy and terms cannot drift apart.
 *
 * Same nav and footer as the landing page - a legal page that looks like it
 * came from somewhere else reads as boilerplate someone pasted in, which is
 * exactly the impression it must not give.
 */
import type { ReactNode } from "react";
import Nav from "../landing/Nav";
import Footer from "../landing/Footer";

export function LegalPage({
  title, updated, summary, children,
}: {
  title: string;
  /** ISO date this text last changed. */
  updated: string;
  /** The honest one-paragraph version, for anyone who will not read the rest. */
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <Nav />
      <main id="main" className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-model">Legal</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-100 sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-[12px] text-gray-600">
          Last updated {updated}
        </p>

        <div className="mt-7 rounded-lg border border-model/25 bg-model/[0.06] px-5 py-4 text-[15px] leading-relaxed text-gray-300">
          {summary}
        </div>

        <div className="mt-10">{children}</div>
      </main>
      <Footer />
    </>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-10 text-[19px] font-semibold tracking-tight text-gray-100">
      {children}
    </h2>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-gray-400">{children}</p>;
}

export function List({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-gray-400">
      {children}
    </ul>
  );
}

export function Item({ children }: { children: ReactNode }) {
  return (
    <li className="relative pl-5 before:absolute before:left-0 before:top-[0.62em] before:h-1 before:w-1 before:rounded-full before:bg-model">
      {children}
    </li>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-gray-200">{children}</strong>;
}
