"use client";

/**
 * A market's authoritative onchain snapshot, plus the grid its pool enforces.
 *
 * This hook exists because of one rule the protocol is unforgiving about: the
 * INDEXER LAGS THE CHAIN BY SECONDS, and a 15-minute window can leave `Trading`
 * inside that lag. Anything that writes must therefore gate on
 * `client.getMarketOnchain`, not on the indexed status the dashboard renders -
 * and it must do so IMMEDIATELY BEFORE SIGNING, not at mount. So the hook has
 * two halves:
 *
 *   `onchain` - a snapshot refreshed on a timer, used to render the ticket
 *               (what the pool is, what the grid is, when it expires).
 *   `refresh()` - an awaited re-read that THROWS rather than degrades, called
 *               as the last thing before a write. Its result is the generation
 *               the write acts on.
 *
 * The snapshot is also the anti-recycle guard. A BinaryPool is reused by
 * successive markets, so a ticket left open across a roll would otherwise send
 * an order to the right pool for the WRONG market. Every write compares the
 * pool and nonce it reviewed against the pool and nonce it is about to sign for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { BinaryBookParams, MarketOnchain } from "@somnia-chain/markets-sdk";
import { useVaticrExchange } from "../wallet";

export interface OnchainMarket {
  /** The chain's own view of the market. `null` until the first read lands. */
  onchain: MarketOnchain | null;
  /** The pool's tick / lot / minimum-quantity grid. `null` until read. */
  grid: BinaryBookParams | null;
  isLoading: boolean;
  /** Why the read failed, verbatim. Never swallowed into a false "not trading". */
  error: Error | null;
  /**
   * Re-read the snapshot now. THROWS on failure - a write must not proceed on
   * a status it could not confirm.
   */
  refresh: () => Promise<MarketOnchain>;
}

/** How often the rendered snapshot re-reads. Windows are minutes; 15s is ample. */
const REFRESH_MS = 15_000;

export function useOnchainMarket(marketId: string | null | undefined): OnchainMarket {
  const { client } = useVaticrExchange();
  const [onchain, setOnchain] = useState<MarketOnchain | null>(null);
  const [grid, setGrid] = useState<BinaryBookParams | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // The grid is a cached chain read per pool inside the SDK, but we still only
  // want one in flight per pool here.
  const gridFor = useRef<string | null>(null);

  const read = useCallback(async (): Promise<MarketOnchain> => {
    if (!marketId) throw new Error("no market selected");
    const snap = await client.getMarketOnchain(marketId as Hex);
    return snap;
  }, [client, marketId]);

  const refresh = useCallback(async (): Promise<MarketOnchain> => {
    const snap = await read();
    setOnchain(snap);
    setError(null);
    return snap;
  }, [read]);

  useEffect(() => {
    if (!marketId) {
      setOnchain(null);
      setGrid(null);
      setError(null);
      return;
    }
    let live = true;
    const tick = async () => {
      setIsLoading(true);
      try {
        const snap = await read();
        if (!live) return;
        setOnchain(snap);
        setError(null);
        if (gridFor.current !== snap.pool) {
          gridFor.current = snap.pool;
          const g = await client.getBinaryBookParams(snap.pool);
          if (live) setGrid(g);
        }
      } catch (err) {
        // A failed read must NOT read as "not trading" - that would invite the
        // user to think the window closed when the RPC merely hiccuped.
        if (live) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (live) setIsLoading(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, marketId, read]);

  return { onchain, grid, isLoading, error, refresh };
}
