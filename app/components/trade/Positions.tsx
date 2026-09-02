"use client";

/**
 * What the connected wallet is actually holding, and what it still has resting.
 *
 * Two framings this panel insists on, because both are easy to get wrong on a
 * binary venue:
 *
 *  - **A complete set is not exposure.** Holding 5 YES and 5 NO in the same
 *     window is worth exactly 5 collateral whichever way it closes. Only the
 *     DIFFERENCE is a bet. So every row splits what is guaranteed from what is
 *     at risk instead of reporting one gross "position" number that overstates
 *     both the upside and the downside.
 *
 *  - **A resting order is spent money.** The escrow left the wallet when the
 *     order was placed; it comes back on cancel, not on expiry. An expired
 *     order that nobody cancelled is therefore collateral sitting idle, and it
 *     is called out as such rather than quietly filtered away.
 *
 * Orders come from two places on purpose. `useLiveUserOrders` sees an order the
 * instant it lands but only for the pool this page is watching; the indexed
 * portfolio sees every pool but lags by seconds. Neither alone would show a
 * user the order they placed ten seconds ago on the window they are looking at.
 */

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { BinarySide } from "@somnia-chain/markets-sdk";
import { useLiveUserOrders, usePortfolio } from "@somnia-chain/markets-sdk/react";
import { Card, PanelState, Pill } from "../ui";
import { COLLATERAL_SYMBOL, useVaticrExchange } from "../wallet";
import { TxLink, WriteError, price as fmtPrice, rawToNumber } from "./shared";

interface Holding {
  marketId: string;
  asset: string;
  interval: string | null;
  status: string;
  expiry: number;
  decimals: number;
  yes: bigint;
  no: bigint;
}

interface Resting {
  key: string;
  pool: Address;
  orderId: string;
  side: BinarySide | null;
  /** Limit price in YES terms, human units. */
  priceYes: number;
  remaining: number;
  filled: number;
  asset: string;
  expiresAtSec: number | null;
  source: "live" | "indexed";
}

const SETTLED = new Set(["Resolved", "Voided", "Finalized"]);

/** A binary side rendered the way a person reads it. */
function sideLabel(side: BinarySide | null): { text: string; tone: "up" | "down" | "neutral" } {
  switch (side) {
    case "BUY_YES": return { text: "buy YES", tone: "up" };
    case "SELL_YES": return { text: "sell YES", tone: "down" };
    case "BUY_NO": return { text: "buy NO", tone: "down" };
    case "SELL_NO": return { text: "sell NO", tone: "up" };
    default: return { text: "order", tone: "neutral" };
  }
}

export default function Positions({
  focusPool, refreshToken, onChanged,
}: {
  /** The pool of the window whose ticket is open, watched for instant order updates. */
  focusPool?: Address;
  /** Bump to force a re-read after a trade lands elsewhere on the page. */
  refreshToken?: number;
  onChanged?: () => void;
}) {
  const { exchange, address, canTrade } = useVaticrExchange();
  const portfolio = usePortfolio(address);
  const liveOrders = useLiveUserOrders(focusPool, address);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState<{ key: string; hash: string } | null>(null);

  // `refreshToken` is a signal, not data: the dashboard bumps it after a trade
  // lands so this panel re-reads instead of showing a portfolio from before the
  // order. `portfolio.refetch` is deliberately not in the dependency list — the
  // hook returns a new function identity on every render, so including it would
  // make this an unbounded refetch loop.
  const refetchPortfolio = portfolio.refetch;
  useEffect(() => {
    if (refreshToken === undefined) return;
    refetchPortfolio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const holdings = useMemo((): Holding[] => {
    const by = new Map<string, Holding>();
    for (const p of portfolio.data?.positions ?? []) {
      const m = p.market;
      const row = by.get(m.id) ?? {
        marketId: m.id,
        asset: m.asset,
        interval: m.interval,
        status: m.status,
        expiry: Number(m.expiry),
        decimals: m.quoteDecimals,
        yes: 0n,
        no: 0n,
      };
      const bal = BigInt(p.balance);
      if (p.outcomeIndex === 0) row.yes += bal;
      else row.no += bal;
      by.set(m.id, row);
    }
    return [...by.values()]
      .filter((h) => h.yes > 0n || h.no > 0n)
      .sort((a, b) => a.expiry - b.expiry);
  }, [portfolio.data]);

  const open = holdings.filter((h) => !SETTLED.has(h.status));
  const settled = holdings.filter((h) => SETTLED.has(h.status));

  const resting = useMemo((): Resting[] => {
    const marketDecimals = new Map<string, { decimals: number; asset: string }>();
    for (const p of portfolio.data?.positions ?? []) {
      marketDecimals.set(p.market.id.toLowerCase(), {
        decimals: p.market.quoteDecimals,
        asset: p.market.asset,
      });
    }
    for (const o of portfolio.data?.openOrders ?? []) {
      marketDecimals.set(o.market.id.toLowerCase(), {
        decimals: o.market.quoteDecimals,
        asset: o.market.asset,
      });
    }

    const rows = new Map<string, Resting>();

    for (const o of portfolio.data?.openOrders ?? []) {
      const d = o.market.quoteDecimals;
      rows.set(o.id.toLowerCase(), {
        key: o.id.toLowerCase(),
        pool: o.market.poolAddress as Address,
        orderId: o.orderId,
        side: o.side,
        priceYes: rawToNumber(BigInt(o.price), d),
        remaining: rawToNumber(BigInt(o.quantityRemaining), d),
        filled: rawToNumber(BigInt(o.filledQuantity), d),
        asset: o.market.asset,
        expiresAtSec: null,
        source: "indexed",
      });
    }

    // The live tail wins on conflict: it sees the fill or the cancel first.
    for (const o of liveOrders) {
      if (o.status !== "Open" || BigInt(o.quantityRemaining) <= 0n) {
        rows.delete(o.id.toLowerCase());
        continue;
      }
      const meta = marketDecimals.get(o.market_id.toLowerCase());
      const d = meta?.decimals ?? 6;
      rows.set(o.id.toLowerCase(), {
        key: o.id.toLowerCase(),
        pool: o.pool,
        orderId: o.orderId,
        side: o.side ?? null,
        priceYes: rawToNumber(BigInt(o.price), d),
        remaining: rawToNumber(BigInt(o.quantityRemaining), d),
        filled: rawToNumber(BigInt(o.filledQuantity), d),
        asset: meta?.asset ?? "—",
        expiresAtSec: Number(BigInt(o.expireTimestampNs) / 1_000_000_000n),
        source: "live",
      });
    }

    return [...rows.values()];
  }, [portfolio.data, liveOrders]);

  async function cancel(row: Resting) {
    setBusy(row.key);
    setCancelError(null);
    setCancelled(null);
    try {
      const res = await exchange.trader.cancelOrder({ pool: row.pool, orderId: row.orderId });
      // A reverted receipt resolves rather than throws on this SDK, so an
      // unchecked cancel would report success on an order that is still resting.
      if (res.receipt?.status === "reverted") {
        throw new Error(
          `The cancel was mined but REVERTED (tx ${res.hash}) — the order may have filled or ` +
            "been cancelled already. Refresh to see its current state.",
        );
      }
      setCancelled({ key: row.key, hash: res.hash });
      setConfirming(null);
      portfolio.refetch();
      onChanged?.();
    } catch (err) {
      setCancelError(err);
    } finally {
      setBusy(null);
    }
  }

  const totals = open.reduce(
    (acc, h) => {
      const guaranteed = h.yes < h.no ? h.yes : h.no;
      const net = h.yes - h.no;
      acc.guaranteed += rawToNumber(guaranteed, h.decimals);
      acc.atRisk += Math.abs(rawToNumber(net, h.decimals));
      return acc;
    },
    { guaranteed: 0, atRisk: 0 },
  );

  return (
    <Card
      id="positions"
      title="Your positions"
      subtitle="Outcome tokens held, and orders still resting on the book"
      right={
        <div className="flex gap-1.5">
          <Pill>{open.length} open window{open.length === 1 ? "" : "s"}</Pill>
          <Pill tone={resting.length > 0 ? "warn" : "neutral"}>{resting.length} resting</Pill>
        </div>
      }
    >
      {portfolio.loading && !portfolio.data && <PanelState state="loading" />}
      {portfolio.error && (
        <PanelState state="error">
          The indexer could not be read: {portfolio.error.message}
        </PanelState>
      )}
      {portfolio.data && holdings.length === 0 && resting.length === 0 && (
        <PanelState
          state="empty"
          empty="No outcome tokens and no resting orders. Place one from the ticket above and it will appear here."
        />
      )}

      {open.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Outcome-token holdings on windows that have not settled, split into the part
              guaranteed by complete sets and the part still at risk.
            </caption>
            <thead className="text-slate-300">
              <tr className="border-b border-white/5">
                <th scope="col" className="px-4 py-2 font-medium">Window</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">YES</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">NO</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Guaranteed</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">At risk</th>
                <th scope="col" className="px-3 py-2 font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {open.map((h) => {
                const yes = rawToNumber(h.yes, h.decimals);
                const no = rawToNumber(h.no, h.decimals);
                const guaranteed = Math.min(yes, no);
                const net = yes - no;
                return (
                  <tr key={h.marketId}>
                    <td className="px-4 py-2">
                      <span className="text-slate-200">{h.asset}</span>
                      {h.interval && <span className="mono ml-1.5 text-[10px] text-slate-500">{h.interval}</span>}
                      <span className="mono ml-1.5 text-[10px] text-slate-500">{h.status}</span>
                    </td>
                    <td className="mono px-3 py-2 text-right text-up">{yes.toFixed(2)}</td>
                    <td className="mono px-3 py-2 text-right text-down">{no.toFixed(2)}</td>
                    <td className="mono px-3 py-2 text-right text-slate-300">{guaranteed.toFixed(2)}</td>
                    <td className="mono px-3 py-2 text-right text-slate-300">{Math.abs(net).toFixed(2)}</td>
                    <td className="px-3 py-2">
                      {Math.abs(net) < 1e-9 ? (
                        <Pill>flat</Pill>
                      ) : (
                        <Pill tone={net > 0 ? "up" : "down"}>
                          <span aria-hidden className="mr-0.5">{net > 0 ? "▲" : "▼"}</span>
                          {net > 0 ? "long Up" : "long Down"}
                        </Pill>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-white/5 px-4 py-2 text-[11px] leading-relaxed text-slate-400">
            <span className="mono">{totals.guaranteed.toFixed(2)}</span> shares are matched YES+NO
            pairs — a complete set is worth exactly 1 {COLLATERAL_SYMBOL} whichever way the window
            closes, so it carries no directional risk.{" "}
            <span className="mono">{totals.atRisk.toFixed(2)}</span> shares are the actual bet: that
            part pays 1 each if the window closes your way and 0 if it does not.
          </p>
        </div>
      )}

      {settled.length > 0 && (
        <div className="border-t border-white/10 px-4 py-3">
          <p className="text-[12px] text-slate-300">
            <span className="mono">{settled.length}</span> settled window
            {settled.length === 1 ? "" : "s"} still hold outcome tokens.
            Settled winnings are <strong className="text-slate-100">claimed, not received</strong> —
            the claim panel below sweeps them.
          </p>
        </div>
      )}

      {/* --------------------------------------------------- resting orders */}
      <div className="border-t border-white/10">
        <div className="flex items-baseline justify-between px-4 py-2.5">
          <h3 className="text-[12px] font-semibold tracking-wide text-slate-200">Resting orders</h3>
          <span className="text-[11px] text-slate-500">
            escrow is returned on cancel, not on expiry
          </span>
        </div>
        {resting.length === 0 ? (
          <p className="px-4 pb-4 text-[12px] text-slate-500">Nothing resting on the book.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {resting.map((row) => {
              const label = sideLabel(row.side);
              const nowSec = Math.floor(Date.now() / 1000);
              const expired = row.expiresAtSec !== null && row.expiresAtSec <= nowSec;
              // The price is quoted in YES terms on the wire; a NO order is more
              // honestly read as its complement, which is what the user typed.
              const own = row.side === "BUY_NO" || row.side === "SELL_NO" ? 1 - row.priceYes : row.priceYes;
              return (
                <li key={row.key} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Pill tone={label.tone}>{label.text}</Pill>
                    <span className="text-[13px] text-slate-200">{row.asset}</span>
                    <span className="mono text-[12px] text-slate-300">
                      {row.remaining.toFixed(2)} @ {fmtPrice(own)}
                    </span>
                    {row.filled > 0 && (
                      <span className="mono text-[11px] text-slate-500">{row.filled.toFixed(2)} filled</span>
                    )}
                    {expired && <Pill tone="warn">expired — cancel to free the escrow</Pill>}
                    <span className="mono text-[10px] text-slate-600">
                      #{row.orderId} · {row.source}
                    </span>
                    <span className="ml-auto">
                      {confirming === row.key ? (
                        <span className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/5"
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            disabled={busy !== null || !canTrade}
                            onClick={() => void cancel(row)}
                            className="rounded-md border border-down/40 bg-down/15 px-2 py-1 text-[11px] font-semibold text-down transition hover:bg-down/25 disabled:opacity-40"
                          >
                            {busy === row.key ? "Signing…" : "Confirm cancel"}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canTrade}
                          onClick={() => { setConfirming(row.key); setCancelError(null); }}
                          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/25 hover:bg-white/5 disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      )}
                    </span>
                  </div>

                  {confirming === row.key && (
                    <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                      Cancels order <span className="mono">#{row.orderId}</span> on pool{" "}
                      <span className="mono">{row.pool.slice(0, 8)}…</span>, releasing the{" "}
                      <span className="mono">{row.remaining.toFixed(2)}</span> unfilled share
                      {row.remaining === 1 ? "" : "s"} of escrow back to your wallet. Already-filled
                      quantity is not affected — it is a position now, not an order.
                    </p>
                  )}

                  {cancelled?.key === row.key && (
                    <p className="mt-2 text-[11px] text-up">
                      Cancelled · <TxLink hash={cancelled.hash} />
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cancelError !== null && (
          <div className="px-4 pb-4">
            <WriteError error={cancelError} />
          </div>
        )}
      </div>
    </Card>
  );
}
