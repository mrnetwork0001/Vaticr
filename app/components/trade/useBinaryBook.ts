"use client";

/**
 * The resting book for one binary window, in YES probability terms.
 *
 * Two sources, deliberately:
 *
 *   - `useLiveBinaryOrderBookByMarket` is the SDK's zero-round-trip store view.
 *     It updates the instant an order event lands, and it correctly returns an
 *     EMPTY book once the pool has been recycled onto a successor market. But it
 *     only has data once something on the page has hydrated that market's pool
 *     watch, so on a cold mount it is empty and indistinguishable from "no book".
 *
 *   - `client.getBinaryOrderBook(pool)` is a plain `eth_call`. It always answers,
 *     it is head-fresh, and it needs no watch.
 *
 * So the chain read is the floor and the live store is the overlay: whichever
 * has levels wins, with the live one preferred when both do. `source` is
 * reported rather than hidden, because "no book" and "book not loaded yet" are
 * different claims and the ticket must not make the first one prematurely.
 */

import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { BinaryOrderBook } from "@somnia-chain/markets-sdk";
import { useLiveBinaryOrderBookByMarket } from "@somnia-chain/markets-sdk/react";
import { useVaticrExchange } from "../wallet";
import { rawToNumber } from "./shared";

/** One aggregated price level, in human units. */
export interface Level {
  /** Probability in (0, 1). */
  price: number;
  /** Resting size, in shares. */
  size: number;
}

export interface BookView {
  /** Resting YES bids, best (highest) first. */
  bids: Level[];
  /** Resting YES asks, best (lowest) first. */
  asks: Level[];
  /** Best YES bid / ask, or null when that side is empty. */
  bestBid: number | null;
  bestAsk: number | null;
  /** Mid, only when BOTH sides exist - a one-sided book has no mid. */
  mid: number | null;
  /** Where the numbers came from. `"none"` means both sources answered empty. */
  source: "live" | "chain" | "none";
  /**
   * True once at least one source has actually answered.
   *
   * `source === "none"` alone is ambiguous: it is both "this book is empty" and
   * "no read has landed yet". A ticket that reads the first as the second tells
   * someone there is nothing to trade against a book it has not looked at, so
   * the two are separated here rather than guessed at by the caller.
   */
  loaded: boolean;
  /** `Date.now()` of the last successful CHAIN read, or null if none has landed. */
  asOf: number | null;
  isLoading: boolean;
  error: Error | null;
}

const DEPTH = 6;
const CHAIN_POLL_MS = 6_000;

function levels(raw: readonly { price: bigint; quantity: bigint }[], decimals: number): Level[] {
  return raw.map((l) => ({
    price: rawToNumber(l.price, decimals),
    size: rawToNumber(l.quantity, decimals),
  }));
}

const EMPTY: BinaryOrderBook = { yesBids: [], yesAsks: [], noBids: [], noAsks: [] };

export function useBinaryBook(
  marketId: string | null | undefined,
  pool: Address | null | undefined,
  decimals: number,
): BookView {
  const { client } = useVaticrExchange();
  const live = useLiveBinaryOrderBookByMarket(marketId ?? undefined, DEPTH);
  const [chain, setChain] = useState<BinaryOrderBook>(EMPTY);
  const [chainAt, setChainAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!pool) {
      setChain(EMPTY);
      setChainAt(null);
      return;
    }
    // Drop the previous pool's book BEFORE fetching the new one. Without this
    // the old book stays on screen for the whole round-trip, so a ticket that
    // has just switched markets - or a pool that recycled onto the next window -
    // renders one market's prices while pointing at another. A user already
    // filled 0.07/share away from a displayed touch because of a stale book;
    // showing the wrong market's book entirely is the same failure, worse.
    setChain(EMPTY);
    setChainAt(null);

    let alive = true;
    const tick = async () => {
      setIsLoading(true);
      try {
        // `decimals` matters here: it is the scale the SDK inverts the NO side
        // against, and it defaults to 6. On an 18-decimal venue the default
        // would invert against the wrong unit entirely.
        const b = await client.getBinaryOrderBook(pool, { depth: DEPTH, decimals });
        if (alive) {
          setChain(b);
          setChainAt(Date.now());
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (alive) setIsLoading(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), CHAIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, pool, decimals]);

  const liveHas = live.yesBids.length > 0 || live.yesAsks.length > 0;
  const chainHas = chain.yesBids.length > 0 || chain.yesAsks.length > 0;
  const book = liveHas ? live : chain;
  const source: BookView["source"] = liveHas ? "live" : chainHas ? "chain" : "none";

  const bids = levels(book.yesBids, decimals);
  const asks = levels(book.yesAsks, decimals);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    source,
    loaded: liveHas || chainAt !== null,
    asOf: chainAt,
    isLoading,
    error,
  };
}
