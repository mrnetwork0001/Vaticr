"use client";

/**
 * Trade at the Vaticr posterior.
 *
 * The whole product is one comparison: the model has a number, the book has a
 * number, and when they disagree there is an edge. So that comparison is the
 * visual centre of this panel — not a footnote under a form. Everything below
 * it exists to let someone act on it in as few decisions as possible, and to
 * make sure that before they sign anything they have seen exactly what they are
 * signing.
 *
 * The safety rules this panel is built around, in the order they bite:
 *
 *  1. `canTrade`, not `isConnected`. The exchange's signer is bound in an
 *     effect, so there is at least one render where wagmi says "connected" and
 *     `exchange.trader` still throws `SignerRequiredError`.
 *
 *  2. The on-chain status, not the indexed one. The indexer lags by seconds and
 *     these windows are minutes long, so the status is re-read from chain
 *     IMMEDIATELY before the send and the write is abandoned if it is not
 *     `Trading` (1).
 *
 *  3. The pool is not the market. A BinaryPool is recycled across successive
 *     windows, so the snapshot reviewed and the snapshot signed for are
 *     compared by `(pool, nonce)`; a roll between the two aborts rather than
 *     sending an order into the next window.
 *
 *  4. No float ever reaches the wire. Prices go through `quantizePrice` (which
 *     is correct on a 6dp venue and on an 18dp one, where `toFixed(18)` puts a
 *     price three wei off the tick grid and the pool answers `InvalidPrice`) and
 *     sizes are floored onto the lot grid in integer arithmetic.
 *
 *  5. Nothing auto-submits. Review is a separate, explicit step, and it prints
 *     side, price, size, total cost and max loss before the wallet is opened.
 */

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { BinarySide, PlaceOrderResult } from "@somnia-chain/markets-sdk";
import { ORDER_TYPE } from "@somnia-chain/markets-sdk";
import { useMarketFees } from "@somnia-chain/markets-sdk/react";
import type { Forecast } from "../types";
import { Card, Pill, countdown } from "../ui";
import {
  COLLATERAL_SYMBOL,
  quantizePrice,
  toRaw,
  useBalances,
  useVaticrExchange,
} from "../wallet";
import { useBinaryBook } from "./useBinaryBook";
import { useOnchainMarket } from "./useOnchainMarket";
import {
  Hint, MARKET_STATUS, ReviewRow, TxLink, WriteError,
  money, pct, price as fmtPrice, rawToNumber, signedFixed, statusExplanation, statusName,
} from "./shared";

type Outcome = "YES" | "NO";
type Kind = "post" | "ioc";
type Phase = "form" | "review" | "sending" | "done";

const SIDES: Record<`${Outcome}-buy`, BinarySide> = {
  "YES-buy": "BUY_YES",
  "NO-buy": "BUY_NO",
};

/** Everything a review sheet promises and the send then honours, byte for byte. */
interface Plan {
  outcome: Outcome;
  side: BinarySide;
  kind: Kind;
  orderType: number;
  decimals: number;
  /** Price in the chosen outcome's OWN terms, tick-aligned. */
  priceOwnRaw: bigint;
  /** The same price in YES terms — what the pool's book is quoted in. */
  priceYesRaw: bigint;
  /** Size in outcome tokens, lot-aligned (floored — never more than asked). */
  quantityRaw: bigint;
  /** price × size: the collateral escrowed, and the most that can be lost. */
  costRaw: bigint;
  /** The generation this plan belongs to. A roll invalidates it. */
  pool: Address;
  nonce: bigint;
  expirySec: number;
}

interface Placed {
  hash: string;
  filledRaw: bigint;
  restingRaw: bigint;
  orderId?: bigint;
  avgOwn: number | null;
  decimals: number;
  outcome: Outcome;
  kind: Kind;
}

/** Trim a typed decimal to what the token can actually represent. */
function clampDecimals(input: string, decimals: number): string {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t)) return t;
  const dot = t.indexOf(".");
  if (dot < 0) return t;
  const frac = t.slice(dot + 1);
  return frac.length > decimals ? `${t.slice(0, dot)}.${frac.slice(0, decimals)}` : t;
}

/** `parseUnits`, but a bad string is a `null` rather than a thrown render. */
function safeRaw(input: string, decimals: number): bigint | null {
  try {
    const v = toRaw(input, decimals);
    return v;
  } catch {
    return null;
  }
}

export default function TradeTicket({
  forecast, onPlaced, onClose, onPool,
}: {
  forecast: Forecast;
  /** Fired after a confirmed placement, so the dashboard can re-read balances. */
  onPlaced?: () => void;
  onClose?: () => void;
  /**
   * Reports this window's pool as soon as it resolves. The positions panel uses
   * it to open a live watch on exactly this pool, which is how an order placed
   * here shows up there before the indexer has caught up with it.
   */
  onPool?: (pool: Address | undefined) => void;
}) {
  const marketId = forecast.market_id ?? undefined;
  const { exchange, address, canTrade, isConnected, chainOk } = useVaticrExchange();
  const { onchain, grid, error: statusError, refresh } = useOnchainMarket(marketId);
  const decimals = onchain?.decimals ?? 6;
  const one = useMemo(() => 10n ** BigInt(decimals), [decimals]);
  const book = useBinaryBook(marketId, onchain?.pool, decimals);
  const balances = useBalances(chainOk ? address : undefined);
  const fees = useMarketFees(marketId);

  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [kind, setKind] = useState<Kind>("post");
  const [priceInput, setPriceInput] = useState("");
  const [sizeInput, setSizeInput] = useState("10");
  const [touchedPrice, setTouchedPrice] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);

  const pool = onchain?.pool;
  useEffect(() => {
    onPool?.(pool);
    return () => onPool?.(undefined);
  }, [pool, onPool]);

  const posterior = forecast.posterior;
  /** The fair value of the leg the user has selected, in that leg's own terms. */
  const fairOwn = outcome === "YES" ? posterior : 1 - posterior;

  // The price box defaults to the model's number — that IS the product — but
  // stops following it the moment the user types, so an edit is never clobbered
  // by the next 10-second forecast refresh.
  useEffect(() => {
    if (touchedPrice) return;
    setPriceInput(quantizePrice(fairOwn, decimals, grid?.tickSize ?? 1n));
  }, [fairOwn, decimals, grid?.tickSize, touchedPrice]);

  /* ------------------------------------------------------------ the edge */

  const bestAskYes = book.bestAsk;
  const bestBidYes = book.bestBid;
  /** What each leg costs to BUY at the touch. NO is bought against the YES bid. */
  const offerFor = (o: Outcome): number | null =>
    o === "YES" ? bestAskYes : bestBidYes === null ? null : 1 - bestBidYes;
  const edgeFor = (o: Outcome): number | null => {
    const offer = offerFor(o);
    if (offer === null) return null;
    return (o === "YES" ? posterior : 1 - posterior) - offer;
  };
  const yesEdge = edgeFor("YES");
  const noEdge = edgeFor("NO");
  const bestSide: Outcome | null =
    yesEdge !== null && (noEdge === null || yesEdge >= noEdge)
      ? yesEdge > 0 ? "YES" : null
      : noEdge !== null && noEdge > 0 ? "NO" : null;

  const settlementFeeBps = fees.data?.settlementFeeBps ? Number(fees.data.settlementFeeBps) : null;
  const payoutPerShare = settlementFeeBps === null ? 1 : 1 - settlementFeeBps / 10_000;

  /* ------------------------------------------------------- plan + guards */

  const tradable = onchain !== null && onchain.status === MARKET_STATUS.Trading;

  const built = useMemo((): { plan?: Plan; problem?: string } => {
    if (!marketId) return { problem: "This forecast is not bound to an on-chain market yet." };
    if (!canTrade) {
      return {
        problem: !isConnected
          ? "Connect a wallet to trade."
          : !chainOk
            ? "Switch the wallet to Somnia testnet (50312) to trade."
            : "Binding your wallet to the exchange — one moment.",
      };
    }
    if (!onchain) return { problem: "Reading this window's state from chain…" };
    if (!tradable) return { problem: statusExplanation(onchain.status) };
    if (!grid) return { problem: "Reading this pool's price grid from chain…" };

    const p = Number(priceInput);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      return { problem: "Price must be a probability strictly between 0 and 1 — 0.23, not 23." };
    }
    const priceOwnRaw = safeRaw(quantizePrice(p, decimals, grid.tickSize), decimals);
    if (priceOwnRaw === null || priceOwnRaw <= 0n || priceOwnRaw >= one) {
      return { problem: "That price falls off the venue's tick grid once snapped. Nudge it a tick." };
    }

    const sizeRaw = safeRaw(clampDecimals(sizeInput, decimals), decimals);
    if (sizeRaw === null || sizeRaw <= 0n) return { problem: "Enter a size in shares." };
    const lot = grid.lotSize > 0n ? grid.lotSize : 1n;
    const quantityRaw = (sizeRaw / lot) * lot;
    const floor = grid.minQuantity > lot ? grid.minQuantity : lot;
    if (quantityRaw < floor) {
      return {
        problem: `This pool's smallest order is ${rawToNumber(floor, decimals)} shares.`,
      };
    }

    const costRaw = (priceOwnRaw * quantityRaw) / one;
    if (balances.native && balances.native.raw === 0n) {
      return { problem: "This wallet holds no STT, so it cannot pay gas on Somnia testnet." };
    }
    if (balances.collateral && balances.collateral.raw < costRaw) {
      return {
        problem:
          `A buy escrows the full cost up front: this order needs ${money(costRaw, decimals, COLLATERAL_SYMBOL)}` +
          ` and the wallet holds ${balances.collateral.exact} ${COLLATERAL_SYMBOL}.`,
      };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expirySec = Number(onchain.expiry);
    if (expirySec <= nowSec) {
      return { problem: "This window has already reached its expiry." };
    }

    return {
      plan: {
        outcome,
        side: SIDES[`${outcome}-buy`],
        kind,
        orderType: kind === "post" ? ORDER_TYPE.POST_ONLY : ORDER_TYPE.MARKET,
        decimals,
        priceOwnRaw,
        // The book is quoted in YES terms whichever leg you trade, so a NO
        // price goes on the wire as its complement. Integer subtraction, so an
        // on-grid price stays on-grid (every venue's tick divides one unit).
        priceYesRaw: outcome === "YES" ? priceOwnRaw : one - priceOwnRaw,
        quantityRaw,
        costRaw,
        pool: onchain.pool,
        nonce: onchain.nonce,
        expirySec,
      },
    };
  }, [
    marketId, canTrade, isConnected, chainOk, onchain, tradable, grid, priceInput, sizeInput,
    decimals, one, outcome, kind, balances.native, balances.collateral,
  ]);

  /* ------------------------------------------------------------- the send */

  async function send(p: Plan) {
    setPhase("sending");
    setSendError(null);
    try {
      // THE GATE. The indexer lags; this does not. Everything below acts on
      // `fresh`, never on the snapshot the review sheet was built from.
      const fresh = await refresh();
      if (fresh.status !== MARKET_STATUS.Trading) {
        throw new Error(
          `The window is now '${statusName(fresh.status)}', not 'Trading'. ` +
            `${statusExplanation(fresh.status)} Nothing was signed.`,
        );
      }
      if (fresh.pool.toLowerCase() !== p.pool.toLowerCase() || fresh.nonce !== p.nonce) {
        throw new Error(
          "This pool has rolled onto a different window since you reviewed the order. " +
            "Nothing was signed — close the ticket and reopen it on the current window.",
        );
      }
      const nowSec = Math.floor(Date.now() / 1000);
      // Capped at the market's own expiry: a binary order must satisfy
      // 0 < expireNs <= pool.marketExpiryNs or the pool rejects it outright.
      const expirySec = Math.min(p.expirySec, Number(fresh.expiry));
      if (expirySec <= nowSec) {
        throw new Error("The window reached expiry while the order was being confirmed. Nothing was signed.");
      }

      const res: PlaceOrderResult = await exchange.trader.placeOrder({
        pool: fresh.pool,
        side: p.side,
        price: p.priceYesRaw,
        quantity: p.quantityRaw,
        outcomeToken: fresh.outcomeToken,
        yesId: fresh.yesId,
        noId: fresh.noId,
        collateral: fresh.collateral,
        orderType: p.orderType,
        expireTimestampNs: BigInt(expirySec) * 1_000_000_000n,
      });

      // The SDK signs with fixed fees and does not simulate, so a REVERTED
      // receipt resolves rather than throws. Unchecked, a failed order would
      // render here as a success with a transaction hash attached to it.
      if (res.receipt?.status === "reverted") {
        throw new Error(
          `The transaction was mined but REVERTED on-chain (tx ${res.hash}). No order was placed. ` +
            "Open the receipt for the decoded reason.",
        );
      }

      const fills = res.fills ?? [];
      const filledRaw = fills.reduce((acc, f) => acc + f.quantityFilled, 0n);
      const notional = fills.reduce((acc, f) => acc + f.fillPrice * f.quantityFilled, 0n);
      const avgYes = filledRaw > 0n ? rawToNumber(notional / filledRaw, p.decimals) : null;
      setPlaced({
        hash: res.hash,
        filledRaw,
        restingRaw: p.quantityRaw - filledRaw,
        orderId: res.orderId,
        avgOwn: avgYes === null ? null : p.outcome === "YES" ? avgYes : 1 - avgYes,
        decimals: p.decimals,
        outcome: p.outcome,
        kind: p.kind,
      });
      setPhase("done");
      balances.refetch();
      onPlaced?.();
    } catch (err) {
      setSendError(err);
      setPhase("review");
    }
  }

  /* ------------------------------------------------------------- render */

  const closing = countdown(forecast.seconds_left);
  const subtitle =
    `${forecast.asset} · ${Math.round(forecast.window_sec)}s window · closes in ${closing}`;

  return (
    <Card
      id="ticket"
      title="Trade at the Vaticr posterior"
      subtitle={subtitle}
      right={
        <div className="flex items-center gap-1.5">
          {onchain && (
            <Pill tone={tradable ? "up" : "warn"}>{statusName(onchain.status)}</Pill>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
            >
              Close
            </button>
          )}
        </div>
      }
    >
      {/* ---------------------------------------------------- the comparison */}
      <div className="border-b border-white/10 px-4 py-4">
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              The book
            </p>
            <p className="mono mt-1 text-3xl font-semibold leading-none text-slate-100">
              {offerFor(outcome) === null ? "—" : fmtPrice(offerFor(outcome)!)}
            </p>
            <p className="mono mt-1.5 text-[11px] text-slate-400">
              best offer on {outcome}
              {book.source === "none" && " · no resting orders"}
            </p>
          </div>

          <div className="text-center">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Edge
            </p>
            <p
              className={`mono mt-1 text-3xl font-semibold leading-none ${
                (edgeFor(outcome) ?? 0) > 0 ? "text-up" : (edgeFor(outcome) ?? 0) < 0 ? "text-down" : "text-slate-400"
              }`}
            >
              {edgeFor(outcome) === null ? "—" : signedFixed(edgeFor(outcome)!)}
            </p>
            <p className="mt-1.5 text-[11px] text-slate-400">per share, buying {outcome}</p>
          </div>

          <div className="sm:text-right">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-accent">
              Vaticr
            </p>
            <p className="mono mt-1 text-3xl font-semibold leading-none text-accent">
              {fmtPrice(fairOwn)}
            </p>
            <p className="mono mt-1.5 text-[11px] text-slate-400">
              posterior on {outcome}
            </p>
          </div>
        </div>

        {/* Both numbers on one rail, so the gap is a distance and not a subtraction. */}
        <div className="relative mt-4 h-2 w-full rounded-full bg-ink-700" role="img"
          aria-label={
            `Vaticr posterior on ${outcome} ${pct(fairOwn)}` +
            (offerFor(outcome) !== null ? `, best offer ${pct(offerFor(outcome)!)}` : ", no resting offer")
          }
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent/70" style={{ width: pct(fairOwn) }} />
          {offerFor(outcome) !== null && (
            <div className="absolute inset-y-[-4px] w-0.5 bg-amber-300" style={{ left: pct(offerFor(outcome)!) }} />
          )}
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-300">
          {offerFor(outcome) === null ? (
            <>
              Nothing is offered on {outcome} right now. Vaticr puts it at{" "}
              <span className="mono text-accent">{pct(fairOwn)}</span> — rest a post-only bid there
              and let the book come to you.
            </>
          ) : (edgeFor(outcome) ?? 0) > 0 ? (
            <>
              The model says <span className="mono text-accent">{pct(fairOwn)}</span>, the book asks{" "}
              <span className="mono text-amber-300">{pct(offerFor(outcome)!)}</span> — buying {outcome}{" "}
              here pays <span className="mono text-up">{signedFixed(edgeFor(outcome)!)}</span> under
              fair value, per share.
            </>
          ) : (
            <>
              The book asks <span className="mono text-amber-300">{pct(offerFor(outcome)!)}</span> for{" "}
              {outcome} and the model only puts it at{" "}
              <span className="mono text-accent">{pct(fairOwn)}</span>. Crossing here is{" "}
              <span className="mono text-down">{signedFixed(edgeFor(outcome)!)}</span> per share of
              negative expectation — rest below instead, or look at the other leg.
            </>
          )}
        </p>

        {bestSide && bestSide !== outcome && (
          <p className="mt-2 text-[12px] text-slate-400">
            The other leg is the cheaper one right now:{" "}
            <button
              type="button"
              onClick={() => { setOutcome(bestSide); setTouchedPrice(false); }}
              className="font-semibold text-accent underline underline-offset-2 hover:text-white"
            >
              buy {bestSide} at {fmtPrice(offerFor(bestSide)!)} for {signedFixed(edgeFor(bestSide)!)} of edge
            </button>
            .
          </p>
        )}

        {/* The ladder, so "best offer" is visibly the top of something. */}
        {(book.bids.length > 0 || book.asks.length > 0) && (
          <div className="mono mt-4 grid grid-cols-2 gap-x-6 text-[11px]">
            <div>
              <p className="mb-1 text-slate-500">YES bids</p>
              {book.bids.length === 0 && <p className="text-slate-600">none</p>}
              {book.bids.slice(0, 3).map((l) => (
                <p key={`b${l.price}`} className="flex justify-between text-up/80">
                  <span>{fmtPrice(l.price)}</span>
                  <span className="text-slate-500">{l.size.toFixed(2)}</span>
                </p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-slate-500">YES asks</p>
              {book.asks.length === 0 && <p className="text-slate-600">none</p>}
              {book.asks.slice(0, 3).map((l) => (
                <p key={`a${l.price}`} className="flex justify-between text-down/80">
                  <span>{fmtPrice(l.price)}</span>
                  <span className="text-slate-500">{l.size.toFixed(2)}</span>
                </p>
              ))}
            </div>
          </div>
        )}
        <p className="mt-2 text-[10.5px] text-slate-600">
          Book read {book.source === "live" ? "from the live tail" : book.source === "chain" ? "from chain" : "— both sources empty"}
          . One book per market, quoted in YES; a NO price is always 1 − YES.
        </p>
      </div>

      {/* ------------------------------------------------------------- form */}
      {phase === "form" && (
        <div className="space-y-4 px-4 py-4">
          <div>
            <span className="text-[11px] font-medium text-slate-400">Which side</span>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(["YES", "NO"] as Outcome[]).map((o) => {
                const active = outcome === o;
                const offer = offerFor(o);
                return (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { setOutcome(o); setTouchedPrice(false); }}
                    className={`rounded-lg border px-3 py-2 text-left transition ${
                      active
                        ? o === "YES"
                          ? "border-up/50 bg-up/10"
                          : "border-down/50 bg-down/10"
                        : "border-white/10 bg-white/[0.02] hover:border-white/25"
                    }`}
                  >
                    <span className={`text-[13px] font-semibold ${o === "YES" ? "text-up" : "text-down"}`}>
                      Buy {o}
                    </span>
                    <span className="mono mt-0.5 block text-[11px] text-slate-400">
                      {o === "YES" ? "closes at or above open" : "closes below open"}
                    </span>
                    <span className="mono mt-1 block text-[11px] text-slate-400">
                      offer {offer === null ? "—" : fmtPrice(offer)} · model {fmtPrice(o === "YES" ? posterior : 1 - posterior)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-medium text-slate-400">
                Price ({outcome} probability)
              </span>
              <input
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => { setTouchedPrice(true); setPriceInput(e.target.value); }}
                className="mono mt-1.5 w-full rounded-lg border border-white/10 bg-ink-950/70 px-3 py-2 text-[14px] text-slate-100 outline-none focus:border-accent/60"
              />
              <Hint>
                Defaults to the Vaticr posterior — the point of the panel.{" "}
                {touchedPrice && (
                  <button
                    type="button"
                    onClick={() => setTouchedPrice(false)}
                    className="text-accent underline underline-offset-2"
                  >
                    reset to {fmtPrice(fairOwn)}
                  </button>
                )}
              </Hint>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-slate-400">Size (shares)</span>
              <input
                inputMode="decimal"
                value={sizeInput}
                onChange={(e) => setSizeInput(clampDecimals(e.target.value, decimals))}
                className="mono mt-1.5 w-full rounded-lg border border-white/10 bg-ink-950/70 px-3 py-2 text-[14px] text-slate-100 outline-none focus:border-accent/60"
              />
              <Hint>
                One share pays {payoutPerShare.toFixed(4)} {COLLATERAL_SYMBOL} if this side wins
                {settlementFeeBps !== null && settlementFeeBps > 0
                  ? ` (1 minus the venue's ${(settlementFeeBps / 100).toFixed(2)}% settlement fee)`
                  : ""}
                , and 0 if it loses.
              </Hint>
            </label>
          </div>

          <fieldset>
            <legend className="text-[11px] font-medium text-slate-400">How it should execute</legend>
            <div className="mt-1.5 space-y-2">
              {([
                ["post", "Post-only — rest on the book", "Never takes. If your price would cross the other side, the pool rejects it and nothing is placed. You wait for someone to come to you, and you pay the maker side of the fee."],
                ["ioc", "IOC — cross now", "Takes whatever is resting at your price or better this instant, then cancels the rest. Nothing is left on the book. Use it when the edge is now."],
              ] as const).map(([value, title, body]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 transition ${
                    kind === value ? "border-accent/50 bg-accent/[0.07]" : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <input
                    type="radio"
                    name="order-kind"
                    className="mt-1 accent-indigo-400"
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  <span>
                    <span className="block text-[12.5px] font-medium text-slate-200">{title}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">{body}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {statusError && (
            <p className="text-[11.5px] leading-relaxed text-down">
              Could not read this window from chain: {statusError.message}
            </p>
          )}
          {built.problem && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11.5px] leading-relaxed text-slate-300">
              {built.problem}
            </p>
          )}

          <button
            type="button"
            disabled={!built.plan}
            onClick={() => { setPlan(built.plan ?? null); setSendError(null); setPhase("review"); }}
            className="w-full rounded-lg border border-accent/40 bg-accent/15 px-4 py-2.5 text-[13px] font-semibold text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review order
          </button>
          <p className="text-center text-[10.5px] text-slate-600">
            Nothing is signed until you confirm on the next screen.
          </p>
        </div>
      )}

      {/* ----------------------------------------------------------- review */}
      {(phase === "review" || phase === "sending") && plan && (
        <div className="px-4 py-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Confirm before signing
          </h3>
          <div className="mt-2 divide-y divide-white/5 rounded-lg border border-white/10 bg-ink-950/50 px-3 py-1">
            <ReviewRow
              label="Order"
              tone={plan.outcome === "YES" ? "up" : "down"}
              value={`BUY ${plan.outcome}`}
              note={plan.outcome === "YES" ? `${forecast.asset} closes at or above its opening price` : `${forecast.asset} closes below its opening price`}
            />
            <ReviewRow
              label="Price"
              value={fmtPrice(rawToNumber(plan.priceOwnRaw, plan.decimals))}
              note={`in ${plan.outcome} terms; sent to the book as ${fmtPrice(rawToNumber(plan.priceYesRaw, plan.decimals))} in YES terms`}
            />
            <ReviewRow
              label="Size"
              value={`${rawToNumber(plan.quantityRaw, plan.decimals)} shares`}
              note="floored onto the pool's lot grid, so never larger than you asked for"
            />
            <ReviewRow
              label="Total cost"
              value={money(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}
              note="escrowed from your wallet the moment the order is placed"
            />
            <ReviewRow
              label="Max loss"
              tone="warn"
              value={money(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}
              note="a binary contract cannot lose more than it cost — this is the whole risk, and you lose all of it if the window closes the other way"
            />
            <ReviewRow
              label="If it wins"
              tone="up"
              value={money(
                (plan.quantityRaw * BigInt(Math.round(payoutPerShare * 1e6))) / 1_000_000n,
                plan.decimals,
                COLLATERAL_SYMBOL,
              )}
              note="claimed, not received — settled winnings sit until you claim them"
            />
            <ReviewRow
              label="Execution"
              value={plan.kind === "post" ? "Post-only" : "IOC"}
              note={plan.kind === "post" ? "rejected rather than filled if it would cross" : "fills what crosses now, cancels the rest"}
            />
            <ReviewRow
              label="Expires"
              value={new Date(plan.expirySec * 1000).toLocaleTimeString()}
              note="capped at the window's own expiry — the pool rejects any order that would outlive its market"
            />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            The window's on-chain status is re-read one more time immediately before this is
            signed. If it has left <span className="mono">Trading</span>, or the pool has rolled onto
            the next window, the order is abandoned rather than sent.
          </p>

          {sendError !== null && (
            <div className="mt-3">
              <WriteError error={sendError} />
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={phase === "sending"}
              onClick={() => { setPhase("form"); setSendError(null); }}
              className="rounded-lg border border-white/10 px-3 py-2 text-[13px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              disabled={phase === "sending" || !canTrade}
              onClick={() => void send(plan)}
              className="flex-1 rounded-lg border border-accent/40 bg-accent/20 px-4 py-2 text-[13px] font-semibold text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === "sending" ? "Waiting for your wallet…" : `Sign and place · ${money(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}`}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- result */}
      {phase === "done" && placed && (
        <div className="px-4 py-4">
          <div className="rounded-lg border border-up/30 bg-up/[0.07] px-3 py-3">
            <p className="text-[13px] font-semibold text-up">Order confirmed on-chain</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
              {placed.filledRaw > 0n && (
                <>
                  Filled{" "}
                  <span className="mono">{rawToNumber(placed.filledRaw, placed.decimals)}</span>{" "}
                  {placed.outcome} shares
                  {placed.avgOwn !== null && <> at an average of <span className="mono">{fmtPrice(placed.avgOwn)}</span></>}.{" "}
                </>
              )}
              {placed.restingRaw > 0n && placed.orderId !== undefined && (
                <>
                  <span className="mono">{rawToNumber(placed.restingRaw, placed.decimals)}</span>{" "}
                  shares are resting on the book as order{" "}
                  <span className="mono">#{placed.orderId.toString()}</span> — it appears in Positions
                  below, where you can cancel it.
                </>
              )}
              {placed.kind === "ioc" && placed.restingRaw > 0n && placed.orderId === undefined && (
                <>
                  The remaining{" "}
                  <span className="mono">{rawToNumber(placed.restingRaw, placed.decimals)}</span>{" "}
                  shares were cancelled rather than rested — that is what IOC means. The escrow for
                  them never left your wallet.
                </>
              )}
              {placed.filledRaw === 0n && placed.orderId === undefined && placed.kind === "post" && (
                <>The order was accepted on-chain but nothing rested and nothing filled.</>
              )}
            </p>
            <p className="mt-2 text-[11px]">
              <TxLink hash={placed.hash} />
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setPhase("form"); setPlaced(null); setSendError(null); }}
            className="mt-3 w-full rounded-lg border border-white/10 px-4 py-2 text-[13px] text-slate-300 transition hover:bg-white/5"
          >
            Place another
          </button>
        </div>
      )}

      <div className="border-t border-white/10 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
        Buying escrows collateral. Selling escrows the outcome tokens themselves and there is no
        naked short here — you can only sell what you hold — so this ticket buys only. To reduce
        exposure before settlement, buy the opposite leg: one YES plus one NO is a complete set,
        always worth exactly 1.
      </div>
    </Card>
  );
}
