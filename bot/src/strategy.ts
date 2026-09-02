/**
 * Vaticr's decision layer: what to do about one market, given a posterior and
 * a live book.
 *
 * The strategy is built around **mint-a-pair**, the cold-start mechanic of the
 * DreamDEX binary book. Four crossing paths exist; the interesting one is
 * `Buy YES x Buy NO`, where two opposite-side *buyers* need no seller at all —
 * the pool mints a fresh YES/NO pair and hands one leg to each.
 *
 * Two consequences drive everything below:
 *
 * 1. A resting `Buy YES @ p - d` plus `Buy NO @ (1 - p) - d` is a complete
 *    two-sided quote that needs **no inventory and no counterparty maker**.
 *    A conventional maker must hold what it sells; this one never sells.
 * 2. Because Vaticr only ever buys, its inventory is complete sets plus an
 *    imbalance. A complete set is worth exactly 1 collateral at settlement
 *    whatever the outcome, so the *only* risk carried is the net imbalance —
 *    which is what `maxNetInventory` caps.
 */

import { clampProbability } from "@dreamdex-bot-kit/ec-core";
import type { VaticrConfig } from "./config.js";

export type Action = "take_yes" | "take_no" | "quote" | "skip";

export interface Decision {
  action: Action;
  edge: number;
  reason: string;
  /** Probability to buy YES at, in YES terms. */
  yesBid?: number;
  /** Probability to buy NO at, in NO terms (i.e. 1 - yesPrice). */
  noBid?: number;
  /** Size for a taking order. */
  takeSize?: number;
  /** Price for a taking order, in the taken leg's own terms. */
  takePrice?: number;
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
}

/**
 * One tick, in probability. `MM_TICK` is 1000 raw units on the 6-decimal
 * testnet venue and 1e15 on the 18-decimal mainnet one — both 0.001 — but the
 * runner passes the live grid rather than trusting that to stay true.
 */
export const DEFAULT_TICK_PROB = 0.001;

/**
 * Where to cross: the touch plus a buffer, never past fair value.
 *
 * An IOC priced at exactly the touch no-fills whenever the book moves one tick
 * between the read and the send, and a no-fill IOC still costs gas for nothing.
 * The buffer pays for that movement. The cap is what makes it safe to have one
 * at all: a fill above fair value is a losing trade by construction, so the
 * buffer may eat into the edge but can never invert it.
 */
export function takeAt(touch: number, fair: number, buffer: number): number {
  return clampProbability(Math.min(touch + Math.max(0, buffer), fair));
}

/**
 * Turn a posterior plus a book into an action.
 *
 * `netPosition` is YES-minus-NO in shares; past the inventory cap only the leg
 * that flattens is quoted. Fills arrive unevenly, so a two-sided quote does not
 * keep a maker flat by itself.
 */
export function decide(
  posterior: number,
  book: BookTop,
  netPosition: number,
  cfg: VaticrConfig,
  tickProb: number = DEFAULT_TICK_PROB,
): Decision {
  const p = clampProbability(posterior);
  const { bestBid, bestAsk } = book;

  const longCapped = netPosition >= cfg.maxNetInventory;
  const shortCapped = netPosition <= -cfg.maxNetInventory;

  // --- taking: must clear the touch we would actually pay, never the mid ---
  // Lifting the ask costs `bestAsk`; the edge is posterior - bestAsk.
  if (bestAsk !== undefined && !longCapped) {
    const edge = p - bestAsk;
    if (edge > cfg.edgeThreshold) {
      return {
        action: "take_yes",
        edge: round(edge),
        reason: `posterior ${p.toFixed(3)} clears ask ${bestAsk.toFixed(3)} by ${edge.toFixed(3)}`,
        takeSize: cfg.quoteSize,
        takePrice: takeAt(bestAsk, p, cfg.takeBuffer),
      };
    }
  }
  // Hitting the bid means buying NO at 1 - bestBid; the edge is bestBid - posterior.
  if (bestBid !== undefined && !shortCapped) {
    const edge = bestBid - p;
    if (edge > cfg.edgeThreshold) {
      return {
        action: "take_no",
        edge: round(edge),
        reason: `bid ${bestBid.toFixed(3)} clears posterior ${p.toFixed(3)} by ${edge.toFixed(3)}`,
        takeSize: cfg.quoteSize,
        // In NO terms the cost of hitting the YES bid is 1 - bestBid, and NO's
        // own fair value is 1 - p.
        takePrice: takeAt(1 - bestBid, 1 - p, cfg.takeBuffer),
      };
    }
  }

  // --- quoting: two resting buys around the posterior (mint-a-pair) ---
  //
  // THE DEAD BAND. Both legs rest on the ONE YES book: a BUY_YES at y is a bid
  // at y, and a BUY_NO at n is the same resting order as a YES ask at 1 - n
  // (vendor/ec-core `placeLimit` sends `priceYes = one - priceOwn` for NO). So
  // what the book actually sees from an unclamped quote is
  //
  //     bid = p - d                      ask = 1 - ((1 - p) - d) = p + d
  //
  // and post-only rejects the bid when p - d >= bestAsk, the ask when
  // p + d <= bestBid. Rearranged, the quote crosses whenever
  //
  //     p - bestAsk >= d      (YES leg)        bestBid - p >= d      (NO leg)
  //
  // while the taking branch above only fires past `edgeThreshold`:
  //
  //     p - bestAsk >  e      (YES)            bestBid - p >  e      (NO)
  //
  // With the shipped defaults d = VATICR_HALF_SPREAD = 0.03 and
  // e = VATICR_EDGE_THRESHOLD = 0.05 that leaves d <= |p - touch| <= e — a band
  // 0.02 wide — where the bot is too timid to take and too aggressive to rest:
  // the post-only reverts with PostOnlyWouldCross every single cycle, and the
  // bot posts nothing at exactly the prices its own model likes most. On a book
  // tighter than 0.04 the mid and the touch coincide, which is why it shows up
  // as "posterior 0.04-0.05 from the mid".
  //
  // Clamping inside the touch is the fix, not forcing d > e. Forcing d > e does
  // close the band, but only by quoting 0.06+ wide — wider than the threshold
  // at which the bot would rather cross — which gives up the fills the maker
  // exists for. One tick inside the touch is the most aggressive price that
  // still rests, and it is still comfortably inside fair value:
  //
  //     bestAsk - tick  <  bestAsk  <=  p - d  <  p
  //
  // so a clamped quote is never a worse trade than the unclamped one, only a
  // nearer one. Same on the NO side, where the YES best bid IS the NO book's
  // best ask at 1 - bestBid.
  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk);

  const tick = Math.max(0, tickProb);
  const wantYes = p - cfg.halfSpread;
  const wantNo = 1 - p - cfg.halfSpread;
  const capYes = bestAsk === undefined ? Number.POSITIVE_INFINITY : bestAsk - tick;
  const capNo = bestBid === undefined ? Number.POSITIVE_INFINITY : 1 - bestBid - tick;
  const clamped = wantYes > capYes || wantNo > capNo;

  const yesBid = clampProbability(Math.min(wantYes, capYes));
  const noBid = clampProbability(Math.min(wantNo, capNo));

  const decision: Decision = {
    action: "quote",
    edge: mid === undefined ? 0 : round(p - mid),
    reason:
      mid === undefined
        ? "empty book — seeding both sides via mint-a-pair"
        : clamped
          ? `no takeable edge (mid ${mid.toFixed(3)}) — quote clamped one tick inside the touch ` +
            `to rest at ${p.toFixed(3)} +/- ${cfg.halfSpread}`
          : `no takeable edge (mid ${mid.toFixed(3)}) — quoting around ${p.toFixed(3)}`,
  };
  // Past the cap, quote only the leg that brings inventory back toward flat.
  if (!longCapped) decision.yesBid = yesBid;
  if (!shortCapped) decision.noBid = noBid;

  if (decision.yesBid === undefined && decision.noBid === undefined) {
    return {
      action: "skip",
      edge: 0,
      reason: `inventory capped at ${netPosition.toFixed(2)}`,
    };
  }
  return decision;
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;

/**
 * Should this market be touched at all this cycle?
 *
 * Returns a reason to skip, or null to proceed.
 */
export function skipReason(
  posterior: number,
  secondsLeft: number,
  minLeft: number,
  degraded: boolean,
): string | null {
  if (degraded) return "degraded forecast";
  if (secondsLeft < minLeft) {
    return `only ${Math.round(secondsLeft)}s left (need ${Math.round(minLeft)}s)`;
  }
  // A posterior pinned at a bound carries no tradable information — it means
  // the window is already decided, and the book will agree.
  if (posterior <= 0.02 || posterior >= 0.98) {
    return `posterior ${posterior.toFixed(3)} is pinned — window already decided`;
  }
  return null;
}
