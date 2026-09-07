"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import AppShell, { ViewTabs, type View } from "./AppShell";
import CalibrationPanel from "./Calibration";
import { Evidence, signed } from "./Evidence";
import {
  BackendDown, Card, PanelState, Pill, ProbabilityBar, Skeleton, ago, countdown,
} from "./ui";
import type {
  AuditResponse, BookResponse, BookTop, Calibration, ForecastEnvelope,
  Headline, Health,
} from "./types";
import { COLLATERAL_SYMBOL, ConnectButton, useVaticrExchange } from "./wallet";
import ClaimPanel, { type ClaimSummary } from "./trade/ClaimPanel";
import Positions, { type PositionsSummary } from "./trade/Positions";
import TradeTicket from "./trade/TradeTicket";

const VENUE = process.env.NEXT_PUBLIC_VENUE_ID ?? "";

type Phase = "loading" | "ready" | "error";

/** What one panel knows: its data, whether it arrived, and why it did not. */
interface Loaded<T> {
  state: Phase;
  data: T | null;
  detail?: string;
}

const pending = <T,>(): Loaded<T> => ({ state: "loading", data: null });

class ApiError extends Error {
  /** True only when the proxy could not open a socket to the Python service. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable: boolean) {
    super(message);
    this.unreachable = unreachable;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // A 502 alone is ambiguous — FastAPI also answers 502 when the indexer is
    // down but the service itself is fine. The proxy's own marker is the only
    // reliable way to tell "nothing is listening" from "something objected".
    throw new ApiError(
      body.detail ?? body.hint ?? `${res.status} ${res.statusText}`,
      body.error === "intelligence layer unreachable",
    );
  }
  return res.json() as Promise<T>;
}

/** Settle one endpoint into panel state without letting it take the others down. */
function settle<T>(
  result: PromiseSettledResult<T>,
  onDown: () => void,
): Loaded<T> {
  if (result.status === "fulfilled") return { state: "ready", data: result.value };
  const err = result.reason as ApiError;
  if (err?.unreachable) onDown();
  return { state: "error", data: null, detail: err?.message ?? String(result.reason) };
}

/**
 * The best trade the top of book offers on one window, against the model.
 *
 * Buying YES costs the ask, so its edge is `posterior − ask`. Buying NO costs
 * `1 − bid`, so its edge is `(1 − posterior) − (1 − bid)`, which reduces to
 * `bid − posterior`. Both are per share, in collateral.
 */
function opportunity(
  posterior: number,
  top: BookTop | undefined,
): { outcome: "YES" | "NO"; edge: number } | null {
  if (!top) return null;
  const yes = top.best_ask !== null ? posterior - top.best_ask : null;
  const no = top.best_bid !== null ? top.best_bid - posterior : null;
  if (yes === null && no === null) return null;
  if (no === null || (yes !== null && yes >= no)) return { outcome: "YES", edge: yes! };
  return { outcome: "NO", edge: no };
}

/**
 * One figure on the summary strip, and a jump to the section that explains it.
 *
 * These are plain anchors on purpose. A native in-page link is keyboard
 * reachable, right-clickable, survives JavaScript failing, honours the target's
 * `scroll-margin-top` under the sticky strip, and respects the user's
 * reduced-motion setting without asking. `scrollIntoView` from elsewhere on the
 * page lands on the same ids.
 */
function StripStat({
  href, label, value, tone = "neutral", note,
}: {
  href: string;
  label: string;
  value: string;
  tone?: "neutral" | "up";
  note?: string;
}) {
  const money = tone === "up";
  return (
    <a
      href={href}
      className={`flex min-w-[7rem] flex-col rounded-lg border px-3 py-1.5 transition ${
        money
          ? "border-up/40 bg-up/10 hover:bg-up/20"
          : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.07]"
      }`}
    >
      <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      <span
        className={`mono text-[14px] font-semibold leading-tight ${
          money ? "text-up" : "text-slate-100"
        }`}
      >
        {value}
      </span>
      <span className="sr-only">
        {note ? `${note}. ` : ""}Jumps to that section of the dashboard.
      </span>
    </a>
  );
}

/**
 * The one row a trader cannot scroll past.
 *
 * The panels that own these numbers sit further down the page, and the whole
 * reason this exists is that a user with settled winnings could not find them:
 * the payout is CLAIMED, never received, so money the wallet already owns can
 * sit unswept indefinitely while nothing on screen says so. Every figure here
 * is reported upward by the panel that renders it, so the strip can never
 * disagree with the table it links to.
 */
function SummaryStrip({
  positions, claims,
}: {
  positions: PositionsSummary | null;
  claims: ClaimSummary | null;
}) {
  const owed = claims?.total ?? 0;
  const hasMoney = owed > 0;
  // A panel that has not reported yet is indistinguishable from one that is
  // still scanning, and both must read as "a number is coming" rather than as
  // a confident zero — telling someone they have nothing owed when the scan
  // has not finished is the exact failure this strip exists to prevent.
  const num = (unsettled: boolean, render: () => string) => (unsettled ? "—" : render());
  const posPending = positions === null || positions.loading;
  const claimPending = claims === null || claims.loading;

  return (
    <nav
      aria-label="Your account, at a glance"
      className="card sticky top-0 z-30 mb-6 flex flex-wrap items-center gap-2 bg-ink-900/90 px-4 py-2.5"
    >
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
        Your account
      </span>

      <StripStat
        href="#positions"
        label="Open positions"
        value={num(posPending, () => String(positions?.openWindows ?? 0))}
        note="Live windows this wallet holds outcome tokens in"
      />
      <StripStat
        href="#positions"
        label="Net exposure"
        value={num(posPending, () => `${(positions?.netExposure ?? 0).toFixed(2)} sh`)}
        note="Shares that are an actual directional bet, after netting complete sets"
      />
      <StripStat
        href="#positions"
        label="Resting orders"
        value={num(posPending, () => String(positions?.resting ?? 0))}
        note="Orders still on the book with escrow committed"
      />
      <StripStat
        href="#claims"
        label="Claimable"
        tone={hasMoney ? "up" : "neutral"}
        value={num(claimPending, () => `${owed.toFixed(4)} ${COLLATERAL_SYMBOL}`)}
        note={
          hasMoney
            ? "Money this wallet has already won and has not been paid — a payout is claimed, never received"
            : "Nothing settled is waiting to be swept"
        }
      />

      {hasMoney && (
        <a
          href="#claims"
          className="ml-auto rounded-lg border border-up/40 bg-up/20 px-3 py-1.5 text-[12px] font-semibold text-up transition hover:bg-up/30"
        >
          Claim {claims?.count} position{claims?.count === 1 ? "" : "s"}
          <span aria-hidden className="ml-1">↓</span>
        </a>
      )}
    </nav>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<Loaded<Health>>(pending);
  const [forecasts, setForecasts] = useState<Loaded<ForecastEnvelope[]>>(pending);
  const [headlines, setHeadlines] = useState<Loaded<Headline[]>>(pending);
  const [audit, setAudit] = useState<Loaded<AuditResponse>>(pending);
  const [calibration, setCalibration] = useState<Loaded<Calibration>>(pending);
  const [books, setBooks] = useState<Record<string, BookTop>>({});
  const [down, setDown] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [updated, setUpdated] = useState<number>(0);

  // ---- trading surface (only ever mounted for a connected wallet) -------
  const { isConnected, chainOk, canTrade, address, chainId } = useVaticrExchange();
  /** The window the ticket is open on. `null` means no ticket. */
  const [ticket, setTicket] = useState<string | null>(null);
  /** Set once the user closes the ticket, so the auto-pick does not reopen it. */
  const [ticketDismissed, setTicketDismissed] = useState(false);
  /** Bumped after any confirmed write, to pull fresh positions and balances. */
  const [tradeNonce, setTradeNonce] = useState(0);
  /** The pool behind the open ticket, watched live by the positions panel. */
  const [focusPool, setFocusPool] = useState<Address | undefined>(undefined);
  /** Headline figures reported up by the two panels, for the summary strip. */
  const [posSummary, setPosSummary] = useState<PositionsSummary | null>(null);
  // One surface at a time. Every data hook stays mounted above this, so
  // switching views is a render, never a refetch.
  const [view, setView] = useState<View>("markets");
  const [claimSummary, setClaimSummary] = useState<ClaimSummary | null>(null);

  const venueQuery = VENUE ? `venue=${VENUE}&` : "";

  const refresh = useCallback(async () => {
    // A plain `let` here would be narrowed to null by control-flow analysis,
    // because the assignment happens inside a callback TypeScript cannot follow.
    const reach = { down: false };
    const noteDown = () => { reach.down = true; };

    const [h, f, n, a, c] = await Promise.allSettled([
      get<Health>("/api/vaticr/health"),
      get<ForecastEnvelope[]>(`/api/vaticr/forecasts?${venueQuery}limit=12`),
      get<Headline[]>("/api/vaticr/headlines?limit=14"),
      get<AuditResponse>(`/api/vaticr/audit?${venueQuery}limit=10`),
      get<Calibration>(`/api/vaticr/calibration?${venueQuery}`),
    ]);

    // Each panel settles on its own. One endpoint failing used to blank the
    // whole page, which made a single broken query look like a dead app.
    setHealth(settle(h, noteDown));
    setForecasts(settle(f, noteDown));
    setHeadlines(settle(n, noteDown));
    setAudit(settle(a, noteDown));
    setCalibration(settle(c, noteDown));
    setDown(
      reach.down ? "The proxy could not open a socket to the forecasting service." : null,
    );
    setUpdated(Date.now());

    if (f.status === "fulfilled") {
      const ids = f.value.map((e) => e.forecast.market_id).filter(Boolean).join(",");
      if (ids) {
        try {
          const book = await get<BookResponse>(`/api/book?markets=${ids}`);
          setBooks(Object.fromEntries(book.tops.map((t) => [t.market_id, t])));
        } catch {
          // A missing book is a normal state on a quiet testnet venue, and the
          // bar renders "mid —" for it. Not worth an error banner.
          setBooks({});
        }
      }
    }
  }, [venueQuery]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const rows = forecasts.data ?? [];
  const news = headlines.data ?? [];
  const tradable = rows.filter((e) => Boolean(e.forecast.market_id));

  /**
   * When a wallet connects, open the ticket on the window where the model and
   * the book disagree most — that comparison is the whole product, and making
   * someone hunt for it buries it. This only SELECTS a market; nothing is
   * pre-filled beyond the model's own price and nothing is ever submitted.
   */
  useEffect(() => {
    if (!canTrade || ticket !== null || ticketDismissed || tradable.length === 0) return;
    let best: { id: string; edge: number } | null = null;
    for (const e of tradable) {
      const id = e.forecast.market_id!;
      const opp = opportunity(e.forecast.posterior, books[id]);
      if (opp && (best === null || opp.edge > best.edge)) best = { id, edge: opp.edge };
    }
    setTicket(best && best.edge > 0 ? best.id : tradable[0].forecast.market_id!);
  }, [canTrade, ticket, ticketDismissed, tradable, books]);

  // Disconnecting takes the trading surface away with it, including whichever
  // window was selected — leaving a stale ticket behind would invite a click
  // that cannot be signed.
  useEffect(() => {
    if (!isConnected) {
      setTicket(null);
      setTicketDismissed(false);
      // The summaries describe a specific account. Keeping them across a
      // disconnect would show the next wallet the previous wallet's money.
      setPosSummary(null);
      setClaimSummary(null);
    }
  }, [isConnected]);

  const ticketRow = ticket ? tradable.find((e) => e.forecast.market_id === ticket) : undefined;

  // Wider than the landing page on purpose: this is a working surface, and the
  // market list, the book and the model's number all want to be readable on one
  // line. max-w-app is calc(25vw + 60rem) — the side margin a max-w-7xl shell
  // would leave, at three quarters of its width.
  // A wallet that disconnects while on a wallet-only view must not be stranded
  // looking at an empty panel.
  if (!canTrade && view === "positions") setView("markets");

  return (
    <AppShell
      view={view}
      onView={setView}
      canTrade={canTrade}
      badges={{ positions: claimSummary && claimSummary.total > 0 ? "$" : null }}
    >
    <main id="main" className="mx-auto max-w-app px-4 py-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* The lockup IS the way back to the landing page, which is where a
              reader expects a logo to go. A separate "back" link next to a
              non-clickable wordmark taught the opposite. */}
          <a
            href="/"
            aria-label="Vaticr — back to the overview"
            className="group inline-flex items-center gap-2.5 rounded transition"
          >
            <span
              aria-hidden
              className="flex h-9 w-9 items-center justify-center rounded border-2 border-model text-base transition group-hover:border-model/70"
            >
              🔮
            </span>
            <h1 className="font-mono text-2xl font-bold tracking-[0.16em] text-gray-100 transition group-hover:text-white">
              VATICR
            </h1>
          </a>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Bayesian forecasting and autonomous market making on DreamDEX Event
            Contracts. A price-process prior, tilted by decayed news evidence,
            quoted against the live on-chain book.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {health.state === "loading" && (
              <>
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-20" />
              </>
            )}
            {health.state === "ready" && health.data && (
              <>
                <Pill tone="up">somnia {health.data.network}</Pill>
                <Pill>{health.data.headlines_in_window} headlines</Pill>
                <Pill tone={health.data.llm_classifier.startsWith("on") ? "up" : "neutral"}>
                  classifier {health.data.llm_classifier.startsWith("on") ? "LLM" : "lexicon"}
                </Pill>
              </>
            )}
            {updated > 0 && (
              <span className="mono text-[11px] text-slate-400">
                updated {new Date(updated).toLocaleTimeString()}
              </span>
            )}
          </div>
          {/* The only thing on this page that can spend money. Everything above
              and below it renders identically with no wallet attached. */}
          <ConnectButton />
        </div>
      </header>

      {down && (
        <div className="mb-6">
          <BackendDown detail={down} />
        </div>
      )}

      {!isConnected && (
        <div className="mb-6 rounded-xl border border-accent/25 bg-accent/[0.06] px-5 py-4">
          <h2 className="text-sm font-semibold text-accent">
            You are reading. You can also trade.
          </h2>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-300">
            Everything below is a live, read-only view and stays exactly as it is with no
            wallet attached. Connect one and each window gains a ticket that prices your
            order at the Vaticr posterior, states the edge against the resting book before
            you sign, and sweeps the winnings that settled markets will otherwise hold
            indefinitely &mdash; on this protocol a payout is <em className="not-italic text-slate-100">claimed</em>,
            never received.
          </p>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Somnia Shannon testnet (50312) &middot; collateral is tUSDC &middot; every
            transaction is shown in full before it is signed.
          </p>
        </div>
      )}

      {/* Connected, on the right chain, and STILL unable to sign. Without this the
          trade controls simply never appear and the reason is invisible — the
          signer binds in an effect, so a wallet client that never resolves looks
          identical to no wallet at all. Name the failing gate rather than making
          someone guess. */}
      {isConnected && chainOk && !canTrade && (
        <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-5 py-4">
          <h2 className="text-sm font-semibold text-amber-300">
            Wallet connected, but the signer has not bound yet
          </h2>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-300">
            The trading controls stay hidden until the exchange holds a signer for{" "}
            <span className="mono">{address ?? "this account"}</span>. This is normally a
            single render; if it persists, the wallet client never resolved &mdash;
            reconnect from the header, and if that fails, disconnect the site inside the
            wallet itself and connect again.
          </p>
          <div className="mono mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
            <span>connected <span className="text-up">yes</span></span>
            <span>chain <span className="text-up">{chainId ?? "?"}</span></span>
            <span>
              signer <span className="text-down">not bound</span>
            </span>
          </div>
        </div>
      )}

      {isConnected && !chainOk && (
        <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-5 py-4">
          <h2 className="text-sm font-semibold text-amber-300">Wrong network</h2>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-300">
            Vaticr trades only on Somnia Shannon testnet (50312). The forecasts below are
            unaffected, but nothing can be signed until the wallet switches &mdash; use the
            button in the header, which will offer to add the network if your wallet has
            never seen it.
          </p>
        </div>
      )}

      {/* Nothing above the fold used to say a wallet had money waiting. This
          does, and it stays on screen while the page scrolls. */}
      {canTrade && <SummaryStrip positions={posSummary} claims={claimSummary} />}

      <ViewTabs view={view} onView={setView} canTrade={canTrade} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className={`space-y-5 ${view === "markets" ? "lg:col-span-2" : "lg:col-span-3"}`}>
          {/* The ticket, the positions and the claim sweep exist only for a
              wallet that can actually sign. With none attached this column is
              the same read-only console it has always been.

              Order matters here. For a connected trader their OWN money comes
              first — ticket, positions, then the claim sweep — and the market
              list follows. Positions and claims used to sit below a twelve-row
              live-windows table, which put a settled payout below the fold and
              made it invisible. Disconnected, none of this mounts and the
              column opens on "Live windows" exactly as it always has. */}
          {canTrade && view === "markets" && (
            <>
              {ticketRow && (
                <TradeTicket
                  key={ticketRow.forecast.market_id ?? "ticket"}
                  forecast={ticketRow.forecast}
                  onPool={setFocusPool}
                  onPlaced={() => setTradeNonce((n) => n + 1)}
                  onClose={() => { setTicket(null); setTicketDismissed(true); }}
                />
              )}

            </>
          )}

          {canTrade && view === "positions" && (
            <>
              <Positions
                focusPool={focusPool}
                refreshToken={tradeNonce}
                onChanged={() => setTradeNonce((n) => n + 1)}
                onSummary={setPosSummary}
              />

              <ClaimPanel
                onClaimed={() => setTradeNonce((n) => n + 1)}
                onSummary={setClaimSummary}
              />
            </>
          )}

          {view === "markets" && (
          <Card
            id="windows"
            title="Live windows"
            subtitle="P(closes at or above its opening price), against the top of the YES book"
            right={
              forecasts.state === "loading"
                ? <Skeleton className="h-5 w-20" />
                : <Pill>{rows.length} markets</Pill>
            }
          >
            {forecasts.state === "loading" && <PanelState state="loading" />}
            {forecasts.state === "error" && (
              <PanelState state="error">{forecasts.detail}</PanelState>
            )}
            {forecasts.state === "ready" && rows.length === 0 && (
              <PanelState
                state="empty"
                empty="No live windows in scope. Rolling windows are minted per interval — the next one opens shortly."
              />
            )}
            {forecasts.state === "ready" && rows.length > 0 && (
              <div className="divide-y divide-white/5">
                {rows.map((e) => {
                  const f = e.forecast;
                  const id = f.market_id ?? f.symbol ?? String(e.expiry);
                  const panelId = `evidence-${id}`;
                  const isOpen = Boolean(expanded[id]);
                  const drift = f.evidence_log_odds;
                  const top = f.market_id ? books[f.market_id] : undefined;
                  return (
                    <div key={id}>
                      <div className="flex flex-wrap items-center gap-4 px-4 py-3">
                        <div className="min-w-[9rem] flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-100">{f.asset}</span>
                            <Pill>{Math.round(f.window_sec)}s window</Pill>
                          </div>
                          <div className="mono mt-1 text-[11px] text-slate-400">
                            open {f.open_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            {" · now "}
                            <span className={f.spot >= f.open_price ? "text-up" : "text-down"}>
                              {f.spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              <span aria-hidden>{f.spot >= f.open_price ? " ▲" : " ▼"}</span>
                            </span>
                          </div>
                        </div>

                        <ProbabilityBar
                          prior={f.prior}
                          posterior={f.posterior}
                          mid={top?.mid ?? null}
                        />

                        <div className="min-w-[5.5rem] text-right">
                          <div className="mono text-xs text-slate-300">
                            {countdown(f.seconds_left)}
                          </div>
                          <div className="mono text-[11px] text-slate-400">
                            vol {(f.annual_vol * 100).toFixed(1)}%
                          </div>
                        </div>

                        <div className="min-w-[4.5rem] text-right">
                          {Math.abs(drift) > 0.0005 ? (
                            <Pill tone={drift > 0 ? "up" : "down"}>
                              news {signed(drift)}
                            </Pill>
                          ) : (
                            <Pill>no news</Pill>
                          )}
                        </div>

                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          onClick={() =>
                            setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
                          }
                          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/25 hover:bg-white/5 hover:text-white"
                        >
                          <span aria-hidden className="mono mr-1">{isOpen ? "−" : "+"}</span>
                          {f.evidence.length} headline{f.evidence.length === 1 ? "" : "s"}
                          <span className="sr-only">
                            {" "}behind the {f.asset} posterior
                          </span>
                        </button>

                        {/* Only a connected wallet gets this control. Disconnected,
                            the row is byte-for-byte the read-only row it always was. */}
                        {canTrade && f.market_id && (() => {
                          const opp = opportunity(f.posterior, top);
                          const active = ticket === f.market_id;
                          return (
                            <button
                              type="button"
                              aria-pressed={active}
                              onClick={() => {
                                setTicketDismissed(false);
                                setTicket(active ? null : f.market_id);
                              }}
                              className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                                active
                                  ? "border-accent/60 bg-accent/25 text-accent"
                                  : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
                              }`}
                            >
                              {active ? "Trading" : "Trade"}
                              {opp && opp.edge > 0.001 && (
                                <span className="mono ml-1.5 text-up">
                                  +{opp.edge.toFixed(3)} {opp.outcome}
                                </span>
                              )}
                              <span className="sr-only">
                                {" "}the {f.asset} window
                                {opp && opp.edge > 0.001
                                  ? `, where buying ${opp.outcome} is ${opp.edge.toFixed(3)} under the model's price`
                                  : ""}
                              </span>
                            </button>
                          );
                        })()}
                      </div>
                      {isOpen && (
                        <Evidence forecast={f} headlines={news} panelId={panelId} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          )}

          {view === "calibration" && (
            <CalibrationPanel
              cal={calibration.data}
              state={calibration.state}
              detail={calibration.detail}
            />
          )}

          {view === "audit" && (
          <Card
            id="audit"
            title="Settlement audit"
            subtitle="Every settlement recomputed from the public oracle feed"
            right={
              audit.state === "loading" ? (
                <Skeleton className="h-5 w-28" />
              ) : (
                audit.data && (
                  <div className="flex gap-1.5">
                    <Pill tone={audit.data.mismatched === 0 ? "up" : "down"}>
                      {audit.data.verified}/{audit.data.total} verified
                    </Pill>
                    {audit.data.inconclusive > 0 && (
                      <Pill tone="warn">{audit.data.inconclusive} too close to call</Pill>
                    )}
                  </div>
                )
              )
            }
          >
            {audit.state === "loading" && <PanelState state="loading" />}
            {audit.state === "error" && (
              <PanelState state="error">{audit.detail}</PanelState>
            )}
            {audit.state === "ready" && audit.data && audit.data.settlements.length === 0 && (
              <PanelState state="empty" empty="No settled windows to recompute yet." />
            )}
            {audit.state === "ready" && audit.data && audit.data.settlements.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">
                      Settled windows, with the on-chain outcome beside the one
                      recomputed independently from the oracle price feed.
                    </caption>
                    <thead className="text-slate-300">
                      <tr className="border-b border-white/5">
                        <th scope="col" className="px-4 py-2 font-medium">Window</th>
                        <th scope="col" className="px-3 py-2 font-medium">Open</th>
                        <th scope="col" className="px-3 py-2 font-medium">Close</th>
                        <th scope="col" className="px-3 py-2 font-medium">Margin</th>
                        <th scope="col" className="px-3 py-2 font-medium">On-chain</th>
                        <th scope="col" className="px-3 py-2 font-medium">Recomputed</th>
                        <th scope="col" className="px-3 py-2 font-medium">Receipt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {audit.data.settlements.map((s) => (
                        <tr key={s.market_id}>
                          <td className="px-4 py-2 text-slate-200">{s.symbol}</td>
                          <td className="mono px-3 py-2 text-slate-400">
                            {s.open_reference?.toFixed(2) ?? "-"}
                          </td>
                          <td className="mono px-3 py-2 text-slate-400">
                            {s.close_reference?.toFixed(2) ?? "-"}
                          </td>
                          <td className="mono px-3 py-2 text-slate-400">
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
                                <span className="sr-only">
                                  {" "}oracle receipt for {s.symbol}, opens in a new tab
                                </span>
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-white/5 px-4 py-2 text-[11px] leading-relaxed text-slate-400">
                  <p>reference series: {audit.data.reference}</p>
                  {audit.data.inconclusive > 0 && (
                    <p className="mt-1">
                      &ldquo;too close to call&rdquo; means the window was decided by
                      under 1bp &mdash; finer than a reconstruction from the public
                      feed can resolve, since the oracle settles on its own sampled
                      tick. It is not a disputed settlement; open the receipt to see
                      the sources that decided it.
                    </p>
                  )}
                </div>
              </>
            )}
          </Card>
          )}
        </div>

        {(view === "markets" || view === "evidence") && (
        <Card
          id="headlines"
          title="Headline evidence"
          subtitle="Scored for directional impact on BTC / ETH"
          right={
            headlines.state === "loading"
              ? <Skeleton className="h-5 w-8" />
              : <Pill>{news.length}</Pill>
          }
        >
          {headlines.state === "loading" && <PanelState state="loading" />}
          {headlines.state === "error" && (
            <PanelState state="error">{headlines.detail}</PanelState>
          )}
          {headlines.state === "ready" && news.length === 0 && (
            <PanelState
              state="empty"
              empty="No scored headlines in the window yet — the scout scans on a timer."
            />
          )}
          {headlines.state === "ready" && news.length > 0 && (
            <ul className="max-h-[46rem] divide-y divide-white/5 overflow-y-auto">
              {news.map((h) => {
                const tone = h.sentiment > 0.05 ? "up" : h.sentiment < -0.05 ? "down" : "neutral";
                return (
                  <li key={h.id} className="px-4 py-3">
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] leading-snug text-slate-200 hover:text-white hover:underline"
                    >
                      {h.title}
                      <span className="sr-only"> — opens in a new tab</span>
                    </a>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Pill tone={tone}>
                        {/* Direction is spelled out, not only coloured. */}
                        <span aria-hidden className="mr-0.5">
                          {tone === "up" ? "▲" : tone === "down" ? "▼" : "•"}
                        </span>
                        {h.sentiment > 0 ? "+" : ""}{h.sentiment.toFixed(2)}
                      </Pill>
                      <Pill>sal {h.salience.toFixed(2)}</Pill>
                      {h.assets.map((a) => <Pill key={a}>{a}</Pill>)}
                      <span className="mono text-[10px] text-slate-400">
                        {h.source} · {ago(h.published_at)}
                      </span>
                    </div>
                    {h.rationale && (
                      <p className="mt-1 text-[11px] text-slate-400">{h.rationale}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        )}
      </div>

      <footer className="mt-8 text-center text-[11px] text-slate-400">
        Vaticr · Somnia × DreamDEX Event Contracts Hackathon · Apache-2.0 ·
        markets and settlement are DreamDEX protocol; forecasting is Vaticr.
      </footer>
    </main>
    </AppShell>
  );
}
