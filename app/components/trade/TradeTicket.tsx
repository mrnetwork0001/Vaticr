"use client";

/**
 * Trade at the Vaticr posterior.
 *
 * The whole product is one comparison: the model has a number, the book has a
 * number, and when they disagree there is an edge. So that comparison is the
 * visual centre of this panel - not a footnote under a form. Everything below
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
 *
 *  6. A revert this panel could have PREDICTED is a bug in this panel. It holds
 *     the book, so it already knows whether an IOC can find anything to take and
 *     whether a post-only would cross. Both are checked before the review step
 *     and explained in words, with the two real fixes offered as buttons -
 *     informed, never blocked, and never silently re-priced. Learning "that
 *     could not have filled" by paying gas for `ImmediateOrCancelNoFill` is the
 *     failure this exists to stop.
 *
 *  7. Every money figure printed here is the one that gets signed. The pool
 *     escrows CEIL(price x size) (see `escrowFor`), so this file rounds the same
 *     way and prints the amount to the token's own last digit; a payout that
 *     depends on a fee we could not read says so rather than quoting the gross.
 */

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useWalletClient } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
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
  Hint, JumpLink, MARKET_STATUS, Notice, NoticeAction, ReviewRow, TxLink, WriteError,
  bpsPct, estimateWithBuffer, moneyExact, pct, price as fmtPrice, rawToNumber, signedFixed,
  statusExplanation, statusName,
} from "./shared";

type Outcome = "YES" | "NO";
type Kind = "post" | "ioc";
type Phase = "form" | "review" | "approving" | "sending" | "done";

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
  /** The same price in YES terms - what the pool's book is quoted in. */
  priceYesRaw: bigint;
  /** Size in outcome tokens, lot-aligned (floored - never more than asked). */
  quantityRaw: bigint;
  /** ceil(price × size): the collateral escrowed, and the most that can be lost. */
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
  /** Collateral actually paid for the filled part, in the pool's rounding. */
  spentRaw: bigint;
  /** What the order escrowed up front - the ceiling `spentRaw` was taken from. */
  escrowRaw: bigint;
  decimals: number;
  outcome: Outcome;
  kind: Kind;
}

/**
 * What a buy escrows: **ceil**(price x size), in the leg's own price terms.
 *
 * This must match `BinaryPool`'s own arithmetic exactly - the SDK computes the
 * approval as `(quantity * price + one - 1) / one` for BUY_YES and
 * `(quantity * (one - price) + one - 1) / one` for BUY_NO, which is the same
 * expression in own terms. Flooring instead would under-approve by one wei on
 * every price x size that is not an exact multiple of one unit, and the pool
 * would then pull more than it was allowed: either a revert, or (because the
 * SDK auto-approves behind us) a surprise second wallet prompt for an UNLIMITED
 * allowance nobody asked for. It would also print a total cost one wei under
 * the amount actually taken.
 */
function escrowFor(priceOwnRaw: bigint, quantityRaw: bigint, one: bigint): bigint {
  return (priceOwnRaw * quantityRaw + one - 1n) / one;
}

/** A fee rate the indexer gives as a decimal string, or null when it has none. */
function bpsOf(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
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
  const { data: walletClient } = useWalletClient();
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

  // A one-second clock. Two things need it: the "this window is about to close"
  // warning, and the expiry check inside `built` - which, keyed only on the
  // form's own inputs, would otherwise keep answering with the time the ticket
  // was opened however long it sits there.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const nowSec = Math.floor(nowMs / 1000);

  const pool = onchain?.pool;
  useEffect(() => {
    onPool?.(pool);
    return () => onPool?.(undefined);
  }, [pool, onPool]);

  const posterior = forecast.posterior;
  /** The fair value of the leg the user has selected, in that leg's own terms. */
  const fairOwn = outcome === "YES" ? posterior : 1 - posterior;

  // The price box defaults to the model's number - that IS the product - but
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

  // Fee config is frozen into the market at creation, and is null both for
  // markets created before the fee plumbing existed and whenever the indexer
  // read has not landed (or failed). Those two cases have to stay visible: a
  // payout quoted gross when a settlement fee might exist is an overstatement of
  // someone's winnings, which is the one direction this panel must never round.
  const settlementFeeBps = bpsOf(fees.data?.settlementFeeBps);
  const takerFeeBps = bpsOf(fees.data?.takerFeeBps);
  const makerFeeBps = bpsOf(fees.data?.makerFeeBps);
  const payoutPerShare = settlementFeeBps === null ? 1 : 1 - settlementFeeBps / 10_000;
  /** Gross quantity net of the settlement fee, in integer arithmetic. */
  const payoutFor = (quantityRaw: bigint): bigint =>
    settlementFeeBps === null
      ? quantityRaw
      : (quantityRaw * BigInt(10_000 - Math.round(settlementFeeBps))) / 10_000n;

  /* ------------------------------------------------------- plan + guards */

  const tradable = onchain !== null && onchain.status === MARKET_STATUS.Trading;

  /** The pool's tick, as a positive integer, whatever the grid says. */
  const tick = grid && grid.tickSize > 0n ? grid.tickSize : 1n;

  /**
   * The price that would actually be signed right now: the box's number snapped
   * onto the pool's tick, in the selected leg's own terms. `null` when the box
   * does not hold a usable probability, or the grid has not been read yet.
   *
   * Defined once, here, because the plan builder and the crossing guards must
   * never reason about two different prices.
   */
  const priceOwnRaw = useMemo((): bigint | null => {
    if (!grid) return null;
    const p = Number(priceInput);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
    const raw = safeRaw(quantizePrice(p, decimals, tick), decimals);
    if (raw === null || raw <= 0n || raw >= one) return null;
    return raw;
  }, [priceInput, grid, tick, decimals, one]);

  const built = useMemo((): { plan?: Plan; problem?: string } => {
    if (!marketId) return { problem: "This forecast is not bound to an on-chain market yet." };
    if (!canTrade) {
      return {
        problem: !isConnected
          ? "Connect a wallet to trade."
          : !chainOk
            ? "Switch the wallet to Somnia testnet (50312) to trade."
            : "Binding your wallet to the exchange - one moment.",
      };
    }
    if (!onchain) return { problem: "Reading this window's state from chain…" };
    if (!tradable) return { problem: statusExplanation(onchain.status) };
    if (!grid) return { problem: "Reading this pool's price grid from chain…" };

    const p = Number(priceInput);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      return { problem: "Price must be a probability strictly between 0 and 1 - 0.23, not 23." };
    }
    if (priceOwnRaw === null) {
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

    // Ceil, exactly as the pool does - see `escrowFor`.
    const costRaw = escrowFor(priceOwnRaw, quantityRaw, one);
    if (balances.native && balances.native.raw === 0n) {
      return { problem: "This wallet holds no STT, so it cannot pay gas on Somnia testnet." };
    }
    if (balances.collateral && balances.collateral.raw < costRaw) {
      return {
        problem:
          `A buy escrows the full cost up front: this order needs ${moneyExact(costRaw, decimals, COLLATERAL_SYMBOL)}` +
          ` and the wallet holds ${balances.collateral.exact} ${COLLATERAL_SYMBOL}.`,
      };
    }

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
    marketId, canTrade, isConnected, chainOk, onchain, tradable, grid, priceInput, priceOwnRaw,
    sizeInput, decimals, one, outcome, kind, balances.native, balances.collateral, nowSec,
  ]);

  /* --------------------------------------------------- pre-flight guards */

  // While a review sheet is up, the guards must describe the FROZEN plan, not
  // the box - the price box keeps following the model until it is touched, so
  // the two can drift apart while the sheet sits open.
  const reviewing = (phase === "review" || phase === "approving" || phase === "sending") && plan !== null;
  const guardPriceRaw = reviewing && plan ? plan.priceOwnRaw : priceOwnRaw;
  const guardKind: Kind = reviewing && plan ? plan.kind : kind;
  const guardOutcome: Outcome = reviewing && plan ? plan.outcome : outcome;

  /** Nothing below may be asserted from a book that has not answered yet. */
  const bookKnown = book.loaded && book.error === null;
  const guardOffer = offerFor(guardOutcome);
  /** The touch as an exact integer - floats must not decide whether we cross. */
  const guardOfferRaw =
    guardOffer === null ? null : safeRaw(quantizePrice(guardOffer, decimals, 1n), decimals);

  /**
   * Does this order cross the book as it stands? A BUY takes offers at or below
   * its limit, in the leg's own terms, so one comparison answers it for both
   * legs: a NO buy is filled from the YES bids, and `offerFor` has already
   * complemented those.
   */
  const wouldCross =
    guardPriceRaw !== null && guardOfferRaw !== null && guardPriceRaw >= guardOfferRaw;

  /** The touch, snapped UP onto the tick grid: the cheapest limit that crosses. */
  const touchRaw = ((): bigint | null => {
    if (guardOfferRaw === null) return null;
    const down = (guardOfferRaw / tick) * tick;
    const up = down < guardOfferRaw ? down + tick : down;
    return up > 0n && up < one ? up : null;
  })();
  /** One tick under the touch: the best price that is still allowed to rest. */
  const restRaw = touchRaw === null || touchRaw - tick <= 0n ? null : touchRaw - tick;

  /** Crossing at the touch costs more than the model says the share is worth. */
  const touchAboveFair = guardOffer !== null && guardOffer > fairOwn;

  type Guard = "ioc-cannot-fill" | "ioc-empty-book" | "post-would-cross" | null;
  const guard: Guard =
    !bookKnown || guardPriceRaw === null || !tradable
      ? null
      : guardKind === "ioc"
        ? guardOfferRaw === null
          ? "ioc-empty-book"
          : wouldCross
            ? null
            : "ioc-cannot-fill"
        : wouldCross
          ? "post-would-cross"
          : null;

  // Applying a fix always returns to the form: changing the price or the
  // execution style under a review sheet would leave the sheet describing an
  // order that is no longer the one being built.
  const applyPrice = (raw: bigint) => {
    setTouchedPrice(true);
    setPriceInput(formatUnits(raw, decimals));
    setPhase("form");
    setSendError(null);
  };
  const applyKind = (k: Kind) => {
    setKind(k);
    setPhase("form");
    setSendError(null);
  };
  const canAct = phase === "form" || phase === "review";

  const guardPriceLabel = guardPriceRaw === null ? "-" : fmtPrice(rawToNumber(guardPriceRaw, decimals));

  const crossingCost = touchAboveFair && guardOffer !== null && (
    <>
      {" "}Note that crossing at{" "}
      <span className="mono text-amber-300">{fmtPrice(guardOffer)}</span> is{" "}
      <span className="mono text-down">{signedFixed(fairOwn - guardOffer)}</span> per share against
      the model's <span className="mono text-accent">{fmtPrice(fairOwn)}</span> - negative expected
      value, which is the one thing this panel exists to keep you out of.
    </>
  );

  const preflight =
    guard === null ? null : guard === "ioc-empty-book" ? (
      <Notice
        title={`Nothing is offered on ${guardOutcome}, so an IOC has nothing to take`}
        actions={canAct && <NoticeAction primary onClick={() => applyKind("post")}>Rest at {guardPriceLabel} as post-only</NoticeAction>}
      >
        An IOC only fills against orders already resting on the book, and this leg has none. The
        pool would cancel the whole order and revert with{" "}
        <span className="mono">ImmediateOrCancelNoFill</span> - you would pay the gas and own
        nothing. Resting a post-only bid puts your price on the book and waits.
      </Notice>
    ) : guard === "ioc-cannot-fill" ? (
      <Notice
        title="An IOC at this price cannot fill"
        actions={
          canAct && (
            <>
              {touchRaw !== null && (
                <NoticeAction primary={!touchAboveFair} onClick={() => applyPrice(touchRaw)}>
                  Raise the limit to {fmtPrice(rawToNumber(touchRaw, decimals))} and cross
                </NoticeAction>
              )}
              <NoticeAction primary={touchAboveFair} onClick={() => applyKind("post")}>
                Rest at {guardPriceLabel} as post-only
              </NoticeAction>
            </>
          )
        }
      >
        An IOC buy takes offers at or BELOW your limit. The cheapest {guardOutcome} on the book is{" "}
        <span className="mono text-amber-300">{fmtPrice(guardOffer!)}</span> and your limit is{" "}
        <span className="mono">{guardPriceLabel}</span>, so there is nothing it can reach: the pool
        would revert with <span className="mono">ImmediateOrCancelNoFill</span> and the gas would
        buy you nothing. Either raise the limit to the touch and cross now, or keep the price and
        rest on the book with post-only.
        {crossingCost}
      </Notice>
    ) : (
      <Notice
        title="A post-only at this price would be rejected"
        actions={
          canAct && (
            <>
              {restRaw !== null && (
                <NoticeAction primary onClick={() => applyPrice(restRaw)}>
                  Rest at {fmtPrice(rawToNumber(restRaw, decimals))}, a tick under the touch
                </NoticeAction>
              )}
              <NoticeAction onClick={() => applyKind("ioc")}>
                Cross now with an IOC at {guardPriceLabel}
              </NoticeAction>
            </>
          )
        }
      >
        Post-only is only allowed to rest. Your limit of{" "}
        <span className="mono">{guardPriceLabel}</span> is at or above the best {guardOutcome} offer
        of <span className="mono text-amber-300">{fmtPrice(guardOffer!)}</span>, so resting it would
        take liquidity instead - the pool refuses with{" "}
        <span className="mono">PostOnlyWouldCross</span> and nothing is placed. Move a tick under
        the touch to rest, or cross on purpose with an IOC.
        {crossingCost}
      </Notice>
    );

  /* -------------------------------------------------------- near expiry */

  // Judged against the window's OWN length, because this series runs from 60s
  // to a day: it is the last ~15% of a window that reprices, whatever 15%
  // happens to be in seconds. Floored at 20s so a 60s window still gets a
  // warning worth reading, and capped at 3 minutes so a daily window does not
  // spend its last hour shouting.
  const windowSec = Number.isFinite(forecast.window_sec) && forecast.window_sec > 0
    ? forecast.window_sec
    : 0;
  const warnWithinSec = Math.min(180, Math.max(20, Math.round(windowSec * 0.15)));
  const secondsLeft = onchain ? Number(onchain.expiry) - nowSec : Math.floor(forecast.seconds_left);
  const nearExpiry = tradable && secondsLeft > 0 && secondsLeft <= warnWithinSec;
  const bookAgeSec = book.asOf === null ? null : Math.max(0, Math.round((nowMs - book.asOf) / 1000));

  const expiryWarning = !nearExpiry ? null : (
    <Notice title={`This window closes in ${countdown(secondsLeft)} - the book is moving`}>
      The touch above is a snapshot
      {book.source === "live"
        ? " from the live tail"
        : bookAgeSec !== null
          ? ` read from chain ${bookAgeSec}s ago`
          : ""}
      , and in the closing seconds of a {Math.round(windowSec)}s window the resting orders behind it
      can be gone before your transaction is mined. Expect a fill away from the displayed price.
      {guardKind === "ioc" ? (
        <>
          {" "}Your limit is still a hard ceiling: an IOC never pays more than{" "}
          <span className="mono">{guardPriceLabel}</span> per share
          {reviewing && plan && (
            <>
              , so never more than{" "}
              <span className="mono">{moneyExact(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}</span>{" "}
              in total
            </>
          )}
          .
        </>
      ) : (
        <>
          {" "}A post-only resting this late may simply never fill. And an order that reaches its
          expiry does NOT return its escrow by itself - the collateral stays locked in the pool
          until the order is cancelled or swept. If it has not filled by the close, cancel it from
          Positions.
        </>
      )}
    </Notice>
  );

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
            "Nothing was signed - close the ticket and reopen it on the current window.",
        );
      }
      const nowSec = Math.floor(Date.now() / 1000);
      // Capped at the market's own expiry: a binary order must satisfy
      // 0 < expireNs <= pool.marketExpiryNs or the pool rejects it outright.
      const expirySec = Math.min(p.expirySec, Number(fresh.expiry));
      if (expirySec <= nowSec) {
        throw new Error("The window reached expiry while the order was being confirmed. Nothing was signed.");
      }

      // Approve the pool ourselves, for exactly this order's escrow.
      //
      // Left to the SDK this happens implicitly, and it inherits the SDK's
      // default 10,000,000 gas CEILING. A ceiling is not a charge - the unused
      // gas is refunded - but a wallet has no way to know that, so it prices
      // the worst case and shows 10M x gasPrice. On testnet that reads as ~0.083
      // STT for an `approve` that actually costs ~46k gas, and Rabby refuses to
      // sign at all with "gas balance is not enough". The trade is unreachable.
      //
      // So: a realistic limit, and an allowance of exactly what this order
      // escrows rather than the whole balance. It costs one extra transaction
      // per trade and shows the user a number they can actually verify against
      // the review sheet.
      if (p.side === "BUY_YES" || p.side === "BUY_NO") {
        if (!walletClient) throw new Error("The wallet client went away before the approval could be sent.");
        const spender = fresh.pool as Address;
        const owner = address as Address;
        // The reviewed number, not a second derivation of it. `p.costRaw` is
        // what the sheet printed and what the pool will pull; recomputing it
        // here is how the two silently drift apart.
        const need = p.costRaw;
        const viem = exchange.client.getViemClient();
        const allowance = await viem.readContract({
          address: fresh.collateral as Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, spender],
        });
        if (allowance < need) {
          setPhase("approving");
          // ESTIMATE, do not guess. A hardcoded ceiling is wrong in both
          // directions and this code has now been wrong in both: 10,000,000
          // (the SDK default) makes a wallet quote a worst case so large it
          // refuses to sign at all, and 120,000 - a textbook ERC-20 approve -
          // is 11x too small here, because this collateral is not a textbook
          // ERC-20. Measured on the live venue, a COLD approve estimates at
          // 1,389,617 gas, so the tight cap reverted every first-time wallet
          // while the demo wallet, which already held an allowance, sailed past
          // it. Estimate against the real chain and add headroom for the
          // difference between a cold and a warm storage slot.
          const approveGas = await estimateWithBuffer(
            () => viem.estimateContractGas({
              address: fresh.collateral as Address,
              abi: erc20Abi,
              functionName: "approve",
              args: [spender, need],
              account: owner,
            }),
            2_000_000n,
          );
          const approveHash = await walletClient.writeContract({
            address: fresh.collateral as Address,
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, need],
            gas: approveGas,
          });
          const approveReceipt = await viem.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
          if (approveReceipt.status !== "success") {
            throw new Error(`The ${COLLATERAL_SYMBOL} approval reverted (tx ${approveHash}). No order was placed.`);
          }
        }
        setPhase("sending");
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
        // Not estimable ahead of time: the SDK builds this calldata itself and
        // skips simulation, and the cost depends on how many resting levels an
        // IOC sweeps. 6M sits well under the 10M default that makes wallets
        // balk, and well over the ~830k a single-level match was measured at,
        // with room for a deep sweep. Unused gas is refunded.
        gas: 6_000_000n,
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
      // `fillPrice` is always the YES price on a binary pool, whichever leg was
      // bought, so the NO cost per share is its complement. Converting each fill
      // first and averaging after keeps the average and the amount paid derived
      // from ONE number rather than from a price that was flipped twice.
      const notionalOwn = fills.reduce(
        (acc, f) => acc + (p.outcome === "YES" ? f.fillPrice : one - f.fillPrice) * f.quantityFilled,
        0n,
      );
      const avgOwn = filledRaw > 0n ? rawToNumber(notionalOwn / filledRaw, p.decimals) : null;
      setPlaced({
        hash: res.hash,
        filledRaw,
        restingRaw: p.quantityRaw - filledRaw,
        orderId: res.orderId,
        avgOwn,
        // Ceil, the pool's own direction - see `escrowFor`.
        spentRaw: (notionalOwn + one - 1n) / one,
        escrowRaw: p.costRaw,
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
              {offerFor(outcome) === null ? "-" : fmtPrice(offerFor(outcome)!)}
            </p>
            <p className="mono mt-1.5 text-[11px] text-slate-400">
              best offer on {outcome}
              {book.source === "none" &&
                (book.error !== null
                  ? " · book unread"
                  : book.loaded
                    ? " · no resting orders"
                    : " · reading…")}
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
              {edgeFor(outcome) === null ? "-" : signedFixed(edgeFor(outcome)!)}
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
            (offerFor(outcome) !== null
              ? `, best offer ${pct(offerFor(outcome)!)}`
              : book.loaded
                ? ", no resting offer"
                : ", the book has not been read yet")
          }
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent/70" style={{ width: pct(fairOwn) }} />
          {offerFor(outcome) !== null && (
            <div className="absolute inset-y-[-4px] w-0.5 bg-amber-300" style={{ left: pct(offerFor(outcome)!) }} />
          )}
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-300">
          {offerFor(outcome) === null && !book.loaded ? (
            <>
              Reading this pool's book from chain. Vaticr puts {outcome} at{" "}
              <span className="mono text-accent">{pct(fairOwn)}</span>; what the book asks is not
              known yet, so nothing here is a comparison of the two.
            </>
          ) : offerFor(outcome) === null ? (
            <>
              Nothing is offered on {outcome} right now. Vaticr puts it at{" "}
              <span className="mono text-accent">{pct(fairOwn)}</span> - rest a post-only bid there
              and let the book come to you.
            </>
          ) : (edgeFor(outcome) ?? 0) > 0 ? (
            <>
              The model says <span className="mono text-accent">{pct(fairOwn)}</span>, the book asks{" "}
              <span className="mono text-amber-300">{pct(offerFor(outcome)!)}</span> - buying {outcome}{" "}
              here pays <span className="mono text-up">{signedFixed(edgeFor(outcome)!)}</span> under
              fair value, per share.
            </>
          ) : (
            <>
              The book asks <span className="mono text-amber-300">{pct(offerFor(outcome)!)}</span> for{" "}
              {outcome} and the model only puts it at{" "}
              <span className="mono text-accent">{pct(fairOwn)}</span>. Crossing here is{" "}
              <span className="mono text-down">{signedFixed(edgeFor(outcome)!)}</span> per share of
              negative expectation - rest below instead, or look at the other leg.
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
          Book read{" "}
          {book.source === "live"
            ? "from the live tail"
            : book.source === "chain"
              ? `from chain${bookAgeSec === null ? "" : `, ${bookAgeSec}s ago`}`
              : book.loaded
                ? "- both sources empty"
                : "- no read has landed yet"}
          . One book per market, quoted in YES; a NO price is always 1 − YES.
        </p>
        {book.error !== null && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-down">
            The chain read of this book failed, so the numbers above may be stale or missing - do
            not treat an empty side as an empty book. {book.error.message}
          </p>
        )}
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
                      offer {offer === null ? "-" : fmtPrice(offer)} · model {fmtPrice(o === "YES" ? posterior : 1 - posterior)}
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
                Defaults to the Vaticr posterior - the point of the panel.{" "}
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
                {settlementFeeBps === null ? (
                  <>
                    One share pays 1 {COLLATERAL_SYMBOL} if this side wins and 0 if it loses, BEFORE
                    the venue's settlement fee - this market's fee schedule could not be read, so
                    treat 1 as an upper bound rather than the payout.
                  </>
                ) : (
                  <>
                    One share pays {payoutPerShare.toFixed(4)} {COLLATERAL_SYMBOL} if this side wins
                    {settlementFeeBps > 0 ? ` (1 minus the venue's ${bpsPct(settlementFeeBps)} settlement fee)` : ""}
                    , and 0 if it loses.
                  </>
                )}
              </Hint>
            </label>
          </div>

          <fieldset>
            <legend className="text-[11px] font-medium text-slate-400">How it should execute</legend>
            <div className="mt-1.5 space-y-2">
              {([
                ["post", "Post-only - rest on the book", "Never takes. If your price would cross the other side, the pool rejects it and nothing is placed. You wait for someone to come to you, and you pay the maker side of the fee."],
                ["ioc", "IOC - cross now", "Takes whatever is resting at your price or better this instant, then cancels the rest. Nothing is left on the book. Use it when the edge is now."],
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

          {/* Everything the page already knows that a revert would otherwise
              teach at the price of gas. Shown here, before the review step, and
              again on the sheet in case the book moves while it is open. */}
          {preflight}
          {expiryWarning}

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
      {(phase === "review" || phase === "approving" || phase === "sending") && plan && (
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
              label={plan.kind === "ioc" ? "Cost, at most" : "Escrowed now"}
              value={moneyExact(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}
              note={
                plan.kind === "ioc"
                  ? "price × size, rounded up exactly as the pool does. An IOC only takes offers at or below your limit, so this is a ceiling: anything that fills cheaper costs less, and whatever does not fill is released in the same transaction."
                  : "price × size, rounded up exactly as the pool does. Held from the moment the order rests. Cancelling returns it in full - but simply letting the order expire does NOT: the escrow stays locked in the pool until the order is cancelled or swept."
              }
            />
            <ReviewRow
              label="Max loss"
              tone="warn"
              value={moneyExact(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}
              note="if it fills in full and the window closes the other way. A binary contract cannot lose more than it cost - this is the whole risk."
            />
            <ReviewRow
              label={settlementFeeBps === null ? "If it wins, before fees" : "If it wins"}
              tone="up"
              value={moneyExact(payoutFor(plan.quantityRaw), plan.decimals, COLLATERAL_SYMBOL)}
              note={
                settlementFeeBps === null
                  ? "this market's settlement fee could not be read, so this is the gross payout and the real one is at most this. Claimed, not received - settled winnings sit until you claim them."
                  : `${settlementFeeBps > 0 ? `net of the venue's ${bpsPct(settlementFeeBps)} settlement fee. ` : ""}Claimed, not received - settled winnings sit until you claim them.`
              }
            />
            <ReviewRow
              label="Execution"
              value={plan.kind === "post" ? "Post-only" : "IOC"}
              note={plan.kind === "post" ? "rejected rather than filled if it would cross" : "fills what crosses now, cancels the rest"}
            />
            {(plan.kind === "ioc" ? takerFeeBps : makerFeeBps) !== null &&
              (plan.kind === "ioc" ? takerFeeBps! : makerFeeBps!) > 0 && (
                <ReviewRow
                  label={plan.kind === "ioc" ? "Venue taker fee" : "Venue maker fee"}
                  value={bpsPct(plan.kind === "ioc" ? takerFeeBps! : makerFeeBps!)}
                  note="the venue's trading fee on whatever fills. It is charged by the pool on the fill and is not part of the escrow figure above."
                />
              )}
            <ReviewRow
              label="Expires"
              value={new Date(plan.expirySec * 1000).toLocaleTimeString()}
              note="capped at the window's own expiry - the pool rejects any order that would outlive its market"
            />
          </div>

          {(preflight || expiryWarning) && (
            <div className="mt-3 space-y-2">
              {preflight}
              {expiryWarning}
            </div>
          )}

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
              disabled={phase === "sending" || phase === "approving"}
              onClick={() => { setPhase("form"); setSendError(null); }}
              className="rounded-lg border border-white/10 px-3 py-2 text-[13px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              disabled={phase === "sending" || phase === "approving" || !canTrade}
              onClick={() => void send(plan)}
              className="flex-1 rounded-lg border border-accent/40 bg-accent/20 px-4 py-2 text-[13px] font-semibold text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === "approving"
                ? `Approving ${COLLATERAL_SYMBOL}…`
                : phase === "sending"
                  ? "Waiting for your wallet…"
                  : `Sign and place · ${moneyExact(plan.costRaw, plan.decimals, COLLATERAL_SYMBOL)}`}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- result */}
      {phase === "done" && placed && (() => {
        const filled = placed.filledRaw > 0n;
        const rested = placed.orderId !== undefined && placed.restingRaw > 0n;
        // A transaction that neither filled nor rested is not a success, and a
        // green "confirmed" over it would be the panel congratulating someone
        // for paying gas. It gets the amber treatment instead.
        const good = filled || rested;
        return (
        <div className="px-4 py-4">
          <div className={`rounded-lg border px-3 py-3 ${good ? "border-up/30 bg-up/[0.07]" : "border-amber-400/30 bg-amber-400/[0.07]"}`}>
            <p className={`text-[13px] font-semibold ${good ? "text-up" : "text-amber-300"}`}>
              {filled && rested
                ? "Filled and resting on-chain"
                : filled
                  ? `Filled - you own ${rawToNumber(placed.filledRaw, placed.decimals)} ${placed.outcome} shares`
                  : rested
                    ? "Resting on the book"
                    : "Confirmed on-chain, but nothing filled and nothing rested"}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
              {filled && (
                <>
                  Filled{" "}
                  <span className="mono">{rawToNumber(placed.filledRaw, placed.decimals)}</span>{" "}
                  {placed.outcome} shares
                  {placed.avgOwn !== null && <> at an average of <span className="mono">{fmtPrice(placed.avgOwn)}</span></>}
                  , for{" "}
                  <span className="mono">{moneyExact(placed.spentRaw, placed.decimals, COLLATERAL_SYMBOL)}</span>
                  {/* Only a claim about a refund when nothing is still resting:
                      an unfilled remainder that RESTED is still escrowed, and
                      calling that "returned" would be a lie about live money. */}
                  {placed.spentRaw < placed.escrowRaw && !rested && (
                    <>
                      {" "}of the{" "}
                      <span className="mono">{moneyExact(placed.escrowRaw, placed.decimals, COLLATERAL_SYMBOL)}</span>{" "}
                      escrowed - the pool released the rest in the same transaction
                    </>
                  )}
                  {placed.spentRaw < placed.escrowRaw && rested && (
                    <>
                      {" "}of the{" "}
                      <span className="mono">{moneyExact(placed.escrowRaw, placed.decimals, COLLATERAL_SYMBOL)}</span>{" "}
                      escrowed; the balance stays locked behind the resting remainder
                    </>
                  )}
                  .{" "}
                </>
              )}
              {rested && (
                <>
                  <span className="mono">{rawToNumber(placed.restingRaw, placed.decimals)}</span>{" "}
                  shares are resting on the book as order{" "}
                  <span className="mono">#{placed.orderId!.toString()}</span> - cancel it from
                  Positions.{" "}
                </>
              )}
              {placed.kind === "ioc" && placed.restingRaw > 0n && placed.orderId === undefined && (
                <>
                  The remaining{" "}
                  <span className="mono">{rawToNumber(placed.restingRaw, placed.decimals)}</span>{" "}
                  shares were cancelled rather than rested - that is what IOC means. Their escrow
                  was released in the same transaction.
                </>
              )}
              {!filled && !rested && placed.kind === "post" && (
                <>The order was accepted on-chain but nothing rested and nothing filled - no
                collateral was escrowed and you hold no new shares.</>
              )}
            </p>

            {/* Where the position now lives. Without this the journey ends on a
                receipt, and the panels that hold the money are below the fold. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <JumpLink to="positions" emphasis>
                {filled ? "See this position ↓" : "Open Positions ↓"}
              </JumpLink>
              {filled && (
                <JumpLink to="claims" emphasis>
                  Claim panel ↓
                </JumpLink>
              )}
              <span className="text-[11px] text-slate-400">
                <TxLink hash={placed.hash} />
              </span>
            </div>

            {filled && (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                Winnings here are <strong className="text-slate-200">not paid automatically</strong>:
                a settled market pays out only when someone asks it to. If {placed.outcome} wins,
                these shares redeem for{" "}
                <span className="mono">
                  {moneyExact(payoutFor(placed.filledRaw), placed.decimals, COLLATERAL_SYMBOL)}
                </span>
                {settlementFeeBps === null ? " before the venue's settlement fee" : ""} - and that
                amount sits unclaimed until you come back to the Claim panel. If it loses, the
                shares are worth nothing and there is nothing to claim.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setPhase("form"); setPlaced(null); setSendError(null); }}
            className="mt-3 w-full rounded-lg border border-white/10 px-4 py-2 text-[13px] text-slate-300 transition hover:bg-white/5"
          >
            Place another
          </button>
        </div>
        );
      })()}

      <div className="border-t border-white/10 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
        Buying escrows collateral. Selling escrows the outcome tokens themselves and there is no
        naked short here - you can only sell what you hold - so this ticket buys only. To reduce
        exposure before settlement, buy the opposite leg: one YES plus one NO is a complete set,
        always worth exactly 1.
        <span className="mt-1.5 block">
          Everything you own and everything owed to you is further down this page:{" "}
          <JumpLink to="positions">Positions</JumpLink> for open orders and holdings,{" "}
          <JumpLink to="claims">Claim</JumpLink> for settled windows - winnings are paid only when
          someone asks for them.
        </span>
      </div>
    </Card>
  );
}
