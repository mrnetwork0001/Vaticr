/**
 * The wallet layer's public surface. Stage-2 trading UI should import from
 * `@/app/components/wallet` (or `"./wallet"` from `app/components`) and nothing
 * deeper, so the internals stay free to move.
 */

export { default as ConnectButton } from "./ConnectButton";

export { useVaticrExchange, type VaticrExchange } from "./useVaticrExchange";
export {
  useBalances,
  DEFAULT_BALANCE_REFRESH_MS,
  type TokenBalance,
  type VaticrBalances,
} from "./useBalances";
export { useSomniaChain, isUserRejection, type SomniaChainState } from "./useSomniaChain";
export {
  useMarketsReady,
  loadVaticrMarkets,
  type MarketsReadyState,
} from "./useMarketsReady";

export { getVaticrExchange } from "./exchange";
export { getWagmiConfig, walletConnectEnabled } from "./wagmi";

export {
  SOMNIA_CHAIN_ID,
  SOMNIA_ADDRESSES,
  SOMNIA_EXPLORER,
  SOMNIA_HTTP_RPC,
  SOMNIA_WS_RPC,
  SOMNIA_INDEXER_URL,
  SOMNIA_PRICE_FEED,
  SOMNIA_ADD_CHAIN_PARAMS,
  COLLATERAL_ADDRESS,
  COLLATERAL_DECIMALS_FALLBACK,
  COLLATERAL_SYMBOL,
  VENUE_ID,
  somniaTestnet,
  explorerTx,
  explorerAddress,
} from "./chain";

export {
  truncateAddress,
  exactAmount,
  shortAmount,
  toRaw,
  quantizePrice,
  type ShortAmount,
} from "./format";
