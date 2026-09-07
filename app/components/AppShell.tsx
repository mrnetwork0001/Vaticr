"use client";
/**
 * The app shell: a left rail, and a main column that owns one view at a time.
 *
 * The dashboard used to render seven surfaces on a single scroll - the trade
 * ticket, positions, claims, the market list, calibration, the settlement audit
 * and the headline feed - all competing for the same screen. They are not
 * sections of one page; they are destinations, and treating them as such is the
 * fix.
 *
 * The rail has two shapes. On a desktop it is persistent and collapses to icons,
 * because this is a working surface people leave open; the choice is remembered
 * per browser, and the labels stay reachable as tooltips and to screen readers
 * when it is narrow. Below `md` a persistent rail would eat half the viewport,
 * so the same nav becomes a drawer behind a button in the top bar - one list of
 * destinations, rendered once, in two shapes.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  BarChart3, ChevronLeft, ClipboardCheck, LineChart, Menu, Newspaper, Wallet, X,
} from "lucide-react";

export type View = "markets" | "positions" | "evidence" | "audit" | "calibration";

export const VIEWS: {
  id: View; label: string; hint: string; Icon: typeof BarChart3; needsWallet?: boolean;
}[] = [
  { id: "markets", label: "Markets", hint: "Live windows and the trade ticket", Icon: LineChart },
  { id: "positions", label: "Positions", hint: "Holdings, resting orders and claims", Icon: Wallet, needsWallet: true },
  { id: "evidence", label: "Evidence", hint: "Headlines moving each posterior", Icon: Newspaper },
  { id: "audit", label: "Audit", hint: "Every settlement recomputed", Icon: ClipboardCheck },
  { id: "calibration", label: "Calibration", hint: "Brier score against the coin flip", Icon: BarChart3 },
];

const KEY = "vaticr:rail-collapsed";

export default function AppShell({
  view, onView, canTrade, badges, footer, children,
}: {
  view: View;
  onView: (v: View) => void;
  canTrade: boolean;
  /** Optional count/among rendered against a rail item, e.g. claimable. */
  badges?: Partial<Record<View, string | null>>;
  /** Rendered at the foot of the rail. Receives the collapsed state so it can
   *  offer something usable at 68px instead of vanishing. The drawer always
   *  passes `false`, because it is full width whatever the desktop rail is. */
  footer?: (collapsed: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [drawer, setDrawer] = useState(false);

  // Read once on mount rather than during render: localStorage is unavailable
  // on the server, and reading it in render would desync hydration.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* private mode, or storage disabled - the default stands */
    }
    setReady(true);
  }, []);

  // While the drawer is over the content, the content must not scroll under it,
  // and Escape must get you out.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawer]);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { window.localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* not fatal */ }
      return next;
    });
  };

  const railW = collapsed ? "68px" : "232px";
  // The drawer is never in the icons-only shape: it is summoned deliberately and
  // dismissed on selection, so it always shows the labels.
  const narrow = collapsed;

  return (
    <div className="min-h-screen" style={{ "--rail": railW } as CSSProperties}>
      {/* Mobile top bar. The rail carries the lockup on a desktop; below `md`
          there is no rail on screen, so it lives here, with the button that
          summons one. */}
      <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-700/70 bg-ink-950/95 px-4 backdrop-blur md:hidden">
        <a href="/" aria-label="Vaticr - back to the overview" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/vaticr-mark.png" alt="" aria-hidden width={128} height={101} className="h-7 w-auto" />
          <span className="font-mono text-[15px] font-bold tracking-[0.16em] text-gray-100">VATICR</span>
        </a>
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open the menu"
          aria-expanded={drawer}
          aria-controls="app-rail"
          className="ml-auto rounded border border-ink-700 p-2 text-gray-400 transition hover:bg-ink-800 hover:text-gray-100"
        >
          <Menu size={18} aria-hidden />
        </button>
      </div>

      {/* Scrim. Present only while the drawer is, and only below `md`. */}
      {drawer && (
        <button
          type="button"
          aria-label="Close the menu"
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px] md:hidden"
        />
      )}

      <aside
        id="app-rail"
        className={`fixed inset-y-0 left-0 z-50 flex w-[268px] flex-col overflow-y-auto border-r border-ink-700/70 bg-ink-950 transition-transform duration-200 md:z-30 md:w-[var(--rail)] md:translate-x-0 md:transition-[width] ${
          drawer ? "translate-x-0" : "-translate-x-full"
        } ${ready ? "" : "md:invisible"}`}
        aria-label="Sections"
      >
        <div
          className={`flex shrink-0 items-center gap-2 ${
            narrow ? "h-16 px-4 md:h-auto md:flex-col md:px-2 md:pb-2 md:pt-4" : "h-16 px-4"
          }`}
        >
          <a
            href="/"
            aria-label="Vaticr - back to the overview"
            className="group flex min-w-0 flex-1 items-center gap-2.5"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/vaticr-mark.png"
              alt=""
              aria-hidden
              width={128}
              height={101}
              className="h-8 w-auto shrink-0"
            />
            <span className={`min-w-0 ${narrow ? "md:hidden" : ""}`}>
              <span className="block truncate font-mono text-[15px] font-bold tracking-[0.16em] text-gray-100">
                VATICR
              </span>
              <span className="block truncate font-mono text-[9px] tracking-[0.14em] text-gray-600">
                DERIVED ODDS
              </span>
            </span>
          </a>
          {/* Two affordances, one slot: collapse is a desktop idea, dismiss is
              a drawer one. */}
          <button
            type="button"
            onClick={() => setDrawer(false)}
            aria-label="Close the menu"
            className="shrink-0 rounded p-1 text-gray-500 transition hover:bg-ink-800 hover:text-gray-200 md:hidden"
          >
            <X size={17} aria-hidden />
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse"}
            className="hidden shrink-0 rounded p-1 text-gray-600 transition hover:bg-ink-800 hover:text-gray-200 md:block"
          >
            <ChevronLeft
              size={16}
              aria-hidden
              className={`transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-2.5 py-3">
          {VIEWS.map(({ id, label, hint, Icon, needsWallet }) => {
            const active = view === id;
            const locked = Boolean(needsWallet) && !canTrade;
            const badge = badges?.[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (locked) return;
                  onView(id);
                  setDrawer(false);
                }}
                disabled={locked}
                aria-current={active ? "page" : undefined}
                title={narrow ? `${label} - ${hint}` : locked ? "Connect a wallet to use this" : hint}
                className={`flex w-full items-center gap-3 rounded px-2.5 py-2.5 text-left text-[14px] transition md:py-2 md:text-[13.5px] ${
                  active
                    ? "bg-model/15 text-model"
                    : locked
                      ? "cursor-not-allowed text-gray-700"
                      : "text-gray-400 hover:bg-ink-800 hover:text-gray-100"
                }`}
              >
                <Icon size={17} aria-hidden className="shrink-0" />
                <span className={`min-w-0 flex-1 truncate ${narrow ? "md:hidden" : ""}`}>{label}</span>
                {badge && (
                  <span
                    className={`mono shrink-0 rounded bg-up/15 px-1.5 text-[10px] font-bold text-up ${
                      narrow ? "md:hidden" : ""
                    }`}
                  >
                    {badge}
                  </span>
                )}
                {narrow && badge && (
                  <span aria-hidden className="absolute ml-6 hidden h-1.5 w-1.5 rounded-full bg-up md:block" />
                )}
              </button>
            );
          })}
        </nav>

        {footer && (
          <div className="px-2.5 pb-4 md:pb-3">
            {/* The drawer is full width whichever shape the desktop rail is in,
                so it gets the expanded footer regardless. */}
            <div className="md:hidden">{footer(false)}</div>
            <div className="hidden md:block">{footer(collapsed)}</div>
          </div>
        )}
      </aside>

      {/* The offset is applied only from md up, because the rail is only on
          screen from md up. Using a CSS variable with Tailwind's md: prefix
          keeps that breakpoint in CSS rather than in JS, which would flash the
          wrong layout on first paint. */}
      <div className="min-w-0 transition-[margin] duration-200 md:ml-[var(--rail)]">
        {children}
      </div>
    </div>
  );
}
