"use client";

/**
 * The market registry, loaded once per tab.
 *
 * `SomniaMarkets` resolves every symbol, tick grid and lot size through
 * `loadMarkets()`, and it must have run before `createOrder`,
 * `priceToPrecision` or `market()` will answer. It is a network round-trip, so
 * it is NOT done at boot: a visitor who only reads the forecasts should never
 * pay for it. Trading UI calls this hook, waits for `ready`, and then uses the
 * symbol API.
 *
 * The in-flight promise is shared across every caller (and cached on
 * `globalThis`, like the exchange itself), so ten mounted trade tickets make one
 * request between them rather than ten.
 */

import { useEffect, useState } from "react";
import { getVaticrExchange } from "./exchange";

const CACHE_KEY = "__vaticr_load_markets__";
type LoadCache = { [CACHE_KEY]?: Promise<unknown> };

/** Kick off (or join) the registry load. Resolves when symbols are available. */
export function loadVaticrMarkets(reload = false): Promise<unknown> {
  const cache = globalThis as unknown as LoadCache;
  if (reload) delete cache[CACHE_KEY];
  cache[CACHE_KEY] ??= getVaticrExchange()
    .loadMarkets(reload)
    .catch((err: unknown) => {
      // A failed load must not be cached as "done" — the next caller has to be
      // able to retry, or a single indexer blip disables trading until reload.
      delete cache[CACHE_KEY];
      throw err;
    });
  return cache[CACHE_KEY]!;
}

export interface MarketsReadyState {
  /** `exchange.markets` / `exchange.symbols` are populated. */
  ready: boolean;
  /** The load is in flight. */
  isLoading: boolean;
  /** Why it failed, verbatim. Not swallowed. */
  error: Error | null;
  /** Force a fresh load — e.g. after a pool is recycled onto a new window. */
  reload: () => void;
}

export function useMarketsReady(): MarketsReadyState {
  const [ready, setReady] = useState(() => getVaticrExchange().symbols.length > 0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setIsLoading(true);
    setError(null);
    loadVaticrMarkets(nonce > 0)
      .then(() => { if (live) { setReady(true); setIsLoading(false); } })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });
    return () => { live = false; };
  }, [nonce]);

  return { ready, isLoading, error, reload: () => setNonce((n) => n + 1) };
}
