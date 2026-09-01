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
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
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
      };
    }
  }

  // --- quoting: two resting buys around the posterior (mint-a-pair) ---
  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk);

  const yesBid = clampProbability(p - cfg.halfSpread);
  const noBid = clampProbability(1 - p - cfg.halfSpread);

  const decision: Decision = {
    action: "quote",
    edge: mid === undefined ? 0 : round(p - mid),
    reason:
      mid === undefined
        ? "empty book — seeding both sides via mint-a-pair"
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
