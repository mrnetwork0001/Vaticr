/**
 * The one place the app says which chain, which endpoints and which collateral
 * token Vaticr trades against.
 *
 * Everything here is a *browser* constant - it ships to the client, so nothing
 * secret belongs in this file. The bot reads the same facts from `.env` through
 * `vendor/ec-core/src/config.ts`; this is the web mirror of that, deliberately
 * narrowed to the single network the site trades on.
 */

import { somniaChains } from "@somnia-chain/markets-sdk/chains";
import {
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  type SomniaMarketsAddresses,
} from "@somnia-chain/markets-sdk";
import type { Address, Chain } from "viem";

/** Somnia Shannon testnet. The site trades here and nowhere else. */
export const SOMNIA_CHAIN_ID = 50312 as const;

/** The viem chain, straight from the SDK (it carries a WebSocket RPC; viem's own
 *  `somniaTestnet` does not, and the SDK's live tail requires one). */
export const somniaTestnet: Chain = somniaChains[SOMNIA_CHAIN_ID];

/** HTTP RPC - what wagmi's public client and `wallet_addEthereumChain` use. */
export const SOMNIA_HTTP_RPC =
  process.env.NEXT_PUBLIC_SOMNIA_RPC_URL ?? "https://api.infra.testnet.somnia.network";

/** WebSocket RPC - the SDK's single chain transport (reads, writes, live tail). */
export const SOMNIA_WS_RPC =
  process.env.NEXT_PUBLIC_SOMNIA_WS_URL ?? "wss://api.infra.testnet.somnia.network/ws";

/** Envio/Hasura GraphQL endpoint for the markets indexer. */
export const SOMNIA_INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";

export const SOMNIA_EXPLORER = "https://shannon-explorer.somnia.network";

/** Protocol contract addresses for this deployment. */
export const SOMNIA_ADDRESSES: SomniaMarketsAddresses = SOMNIA_TESTNET_ADDRESSES;

/** Underlying BTC/ETH spot + EMA feed. Only the price verbs touch it. */
export const SOMNIA_PRICE_FEED = SOMNIA_TESTNET_PRICE_FEED;

/**
 * The venue's collateral ERC-20 - tUSDC on testnet.
 *
 * Its decimals are read from the chain at runtime (see `useBalances`); this
 * constant is only the fallback for the first paint. Mainnet USDso is 18, so
 * nothing downstream may assume 6.
 */
export const COLLATERAL_ADDRESS: Address =
  (SOMNIA_ADDRESSES.collateral ?? SOMNIA_ADDRESSES.testUsdc) as Address;

/** Fallback decimals until the on-chain `decimals()` read lands. */
export const COLLATERAL_DECIMALS_FALLBACK = 6;

/** Display ticker for the collateral token. */
export const COLLATERAL_SYMBOL = "tUSDC";

/** The DreamDEX venue this site forecasts and trades. */
export const VENUE_ID = (process.env.NEXT_PUBLIC_VENUE_ID ?? "") as `0x${string}` | "";

/** Explorer deep links, so error surfaces can point at the real receipt. */
export const explorerTx = (hash: string): string => `${SOMNIA_EXPLORER}/tx/${hash}`;
export const explorerAddress = (addr: string): string => `${SOMNIA_EXPLORER}/address/${addr}`;

/**
 * The `wallet_addEthereumChain` payload for Somnia testnet.
 *
 * Most wallets have never heard of Somnia, so `wallet_switchEthereumChain`
 * fails with 4902 before it can switch. This is what we add first.
 */
export const SOMNIA_ADD_CHAIN_PARAMS = {
  chainId: `0x${SOMNIA_CHAIN_ID.toString(16)}`,
  chainName: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: [SOMNIA_HTTP_RPC],
  blockExplorerUrls: [SOMNIA_EXPLORER],
} as const;
