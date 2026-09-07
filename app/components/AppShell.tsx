"use client";
/**
 * The app shell: a collapsible left rail, and a main column that owns one view
 * at a time.
 *
 * The dashboard used to render seven surfaces on a single scroll — the trade
 * ticket, positions, claims, the market list, calibration, the settlement audit
 * and the headline feed — all competing for the same screen. They are not
 * sections of one page; they are destinations, and treating them as such is the
 * fix.
 *
 * The rail collapses to icons because this is a working surface people leave
 * open. The choice is remembered per browser, and the labels stay reachable as
 * tooltips and to screen readers when it is narrow.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  BarChart3, ChevronLeft, ClipboardCheck, LineChart, Newspaper, Wallet,
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
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  // Read once on mount rather than during render: localStorage is unavailable
  // on the server, and reading it in render would desync hydration.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* private mode, or storage disabled — the default stands */
    }
    setReady(true);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { window.localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* not fatal */ }
      return next;
    });
  };

  const railW = collapsed ? "68px" : "232px";

  return (
    <div className="min-h-screen">
      <aside
        style={{ width: railW }}
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col overflow-y-auto border-r border-ink-700/70 bg-ink-950 transition-[width] duration-200 md:flex ${
          ready ? "" : "invisible"
        }`}
        aria-label="Sections"
      >
        <div className="flex h-16 items-center gap-2.5 px-4">
          <a href="/" aria-label="Vaticr — back to the overview" className="group flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded border-2 border-model text-base transition group-hover:border-model/70"
            >
              🔮
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate font-mono text-[15px] font-bold tracking-[0.16em] text-gray-100">
                  VATICR
                </span>
                <span className="block truncate font-mono text-[9px] tracking-[0.14em] text-gray-600">
                  DERIVED ODDS
                </span>
              </span>
            )}
          </a>
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
                onClick={() => !locked && onView(id)}
                disabled={locked}
                aria-current={active ? "page" : undefined}
                title={collapsed ? `${label} — ${hint}` : locked ? "Connect a wallet to use this" : hint}
                className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left text-[13.5px] transition ${
                  active
                    ? "bg-model/15 text-model"
                    : locked
                      ? "cursor-not-allowed text-gray-700"
                      : "text-gray-400 hover:bg-ink-800 hover:text-gray-100"
                }`}
              >
                <Icon size={17} aria-hidden className="shrink-0" />
                {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
                {!collapsed && badge && (
                  <span className="mono shrink-0 rounded bg-up/15 px-1.5 text-[10px] font-bold text-up">
                    {badge}
                  </span>
                )}
                {collapsed && badge && (
                  <span aria-hidden className="absolute ml-6 h-1.5 w-1.5 rounded-full bg-up" />
                )}
                {collapsed && <span className="sr-only">{label}</span>}
              </button>
            );
          })}
        </nav>

        {footer && !collapsed && <div className="px-2.5 pb-3">{footer}</div>}

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          className="flex h-11 items-center gap-2 border-t border-ink-700/70 px-4 text-gray-500 transition hover:text-gray-200"
        >
          <ChevronLeft
            size={16}
            aria-hidden
            className={`shrink-0 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
          />
          {!collapsed && <span className="font-mono text-[11px]">Collapse</span>}
        </button>
      </aside>

      {/* The offset is applied only from md up, because the rail itself only
          exists from md up. Using a CSS variable with Tailwind's md: prefix
          keeps that breakpoint in CSS rather than in JS, which would flash the
          wrong layout on first paint. */}
      <div
        className="min-w-0 transition-[margin] duration-200 md:ml-[var(--rail)]"
        style={{ "--rail": railW } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

/** The rail is desktop-only; narrow screens get a horizontal switcher instead. */
export function ViewTabs({
  view, onView, canTrade,
}: { view: View; onView: (v: View) => void; canTrade: boolean }) {
  return (
    <div className="-mx-4 mb-5 flex gap-1 overflow-x-auto px-4 md:hidden" role="tablist" aria-label="Sections">
      {VIEWS.map(({ id, label, needsWallet }) => {
        const locked = Boolean(needsWallet) && !canTrade;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            disabled={locked}
            onClick={() => !locked && onView(id)}
            className={`shrink-0 rounded px-3 py-1.5 text-[13px] transition ${
              view === id
                ? "bg-model/15 text-model"
                : locked
                  ? "cursor-not-allowed text-gray-700"
                  : "text-gray-400 hover:bg-ink-800 hover:text-gray-100"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
