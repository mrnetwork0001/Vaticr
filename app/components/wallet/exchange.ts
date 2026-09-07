/**
 * The one `SomniaMarkets` exchange this browser tab owns.
 *
 * The SDK's own guidance for browser apps is to build the exchange ONCE at boot
 * for public reads, then bind the user's wallet to it with `setSigner` when
 * they connect (`SomniaMarkets.setSigner` docstring). That is what this module
 * makes possible: a single instance, reachable from both the React provider
 * (which needs `exchange.client` for the live-tail hooks) and from
 * `useVaticrExchange` (which needs the exchange itself for writes).
 *
 * A second instance would be a second WebSocket, a second live-tail store, and
 * - worse - a signer bound to one of them and not the other. So the instance is
 * cached on `globalThis` rather than in a module-local `let`: Next's dev-mode
 * hot reload re-evaluates modules, and a module-local would silently fork.
 */

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import {
  SOMNIA_ADDRESSES,
  SOMNIA_INDEXER_URL,
  SOMNIA_PRICE_FEED,
  SOMNIA_WS_RPC,
  somniaTestnet,
} from "./chain";

const CACHE_KEY = "__vaticr_exchange__";

type ExchangeCache = { [CACHE_KEY]?: SomniaMarkets };

/**
 * The shared exchange, constructed on first call.
 *
 * Safe to call during server rendering: the constructor only builds config
 * objects - the WebSocket is opened lazily on the first chain read - so no
 * socket is ever opened on the server.
 *
 * It is deliberately built with NO signer. Reads work immediately for a visitor
 * who never connects a wallet; `useVaticrExchange` upgrades it in place.
 */
export function getVaticrExchange(): SomniaMarkets {
  const cache = globalThis as unknown as ExchangeCache;
  cache[CACHE_KEY] ??= new SomniaMarkets({
    indexerUrl: SOMNIA_INDEXER_URL,
    chain: somniaTestnet,
    wsRpcUrl: SOMNIA_WS_RPC,
    addresses: SOMNIA_ADDRESSES,
    priceFeed: SOMNIA_PRICE_FEED,
    // No `privateKey` / `account` / `walletClient` on purpose. See above.
  });
  return cache[CACHE_KEY]!;
}
