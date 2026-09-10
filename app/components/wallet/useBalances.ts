"use client";

/**
 * The two balances that decide whether a visitor can do anything here: native
 * STT (gas) and the venue's collateral, tUSDC.
 *
 * Two rules this file keeps:
 *
 *  1. **Decimals are read, never assumed.** tUSDC on testnet is 6; USDso on
 *     mainnet is 18. A hardcoded 6 would render a mainnet balance a trillion
 *     times too large - and a trade sized off it would be a trillion times too
 *     large too. The `decimals()` read is cached indefinitely (a token's
 *     decimals are immutable) and only falls back to 6 while it is in flight.
 *
 *  2. **Shortened numbers round down.** See `format.ts`. Every balance also
 *     carries its exact string, so a surface that has room can show the truth.
 */

import { useCallback } from "react";
import { erc20Abi, type Address } from "viem";
import { useBalance, useReadContract, useReadContracts } from "wagmi";
import {
  COLLATERAL_ADDRESS,
  COLLATERAL_DECIMALS_FALLBACK,
  COLLATERAL_SYMBOL,
  SOMNIA_CHAIN_ID,
} from "./chain";
import { exactAmount, shortAmount } from "./format";

/** How often balances re-read from chain. Somnia blocks in ~100ms; 12s is a
 *  dashboard refresh rate, not a trading loop - writes should refetch on
 *  success rather than wait for this. */
export const DEFAULT_BALANCE_REFRESH_MS = 12_000;

export interface TokenBalance {
  /** Raw onchain units. The only value safe to do arithmetic on. */
  raw: bigint;
  decimals: number;
  symbol: string;
  /** Exact decimal string, trailing zeros trimmed (e.g. `"12.3456"`). */
  exact: string;
  /** Short form for a pill, rounded DOWN (e.g. `"12.3456"`, or `"< 0.0001"`). */
  short: string;
  /** True when `short` dropped digits - pair it with `exact` in a title. */
  isTruncated: boolean;
}

export interface VaticrBalances {
  /** Native STT - gas. `undefined` until the first read lands. */
  native: TokenBalance | undefined;
  /** tUSDC - what orders escrow and what settlement pays out in. */
  collateral: TokenBalance | undefined;
  /** Collateral decimals as read from chain (falls back to 6 while loading). */
  collateralDecimals: number;
  isLoading: boolean;
  /** True when at least one of the reads failed. Never silently zero. */
  isError: boolean;
  /** The first real error, for display. Not swallowed. */
  error: Error | null;
  /** Re-read both balances now - call this after a trade or a claim. */
  refetch: () => void;
}

function toBalance(
  raw: bigint | undefined,
  decimals: number,
  symbol: string,
  places: number,
): TokenBalance | undefined {
  if (raw === undefined) return undefined;
  const s = shortAmount(raw, decimals, places);
  return {
    raw,
    decimals,
    symbol,
    exact: exactAmount(raw, decimals),
    short: s.text,
    isTruncated: s.truncated,
  };
}

export function useBalances(
  address: Address | undefined,
  options: { refreshMs?: number } = {},
): VaticrBalances {
  const refreshMs = options.refreshMs ?? DEFAULT_BALANCE_REFRESH_MS;
  const enabled = Boolean(address);

  // Decimals are immutable for a deployed ERC-20, so this is read once and kept
  // forever rather than re-polled with the balance.
  const decimalsQuery = useReadContract({
    chainId: SOMNIA_CHAIN_ID,
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
    query: { staleTime: Infinity, gcTime: Infinity, retry: 2 },
  });
  const collateralDecimals = decimalsQuery.data ?? COLLATERAL_DECIMALS_FALLBACK;

  const nativeQuery = useBalance({
    address,
    chainId: SOMNIA_CHAIN_ID,
    query: { enabled, refetchInterval: enabled ? refreshMs : false },
  });

  const collateralQuery = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        chainId: SOMNIA_CHAIN_ID,
        address: COLLATERAL_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address ?? "0x0000000000000000000000000000000000000000"],
      },
    ],
    query: { enabled, refetchInterval: enabled ? refreshMs : false },
  });

  const refetch = useCallback(() => {
    void nativeQuery.refetch();
    void collateralQuery.refetch();
  }, [nativeQuery, collateralQuery]);

  const native = toBalance(
    nativeQuery.data?.value,
    nativeQuery.data?.decimals ?? 18,
    nativeQuery.data?.symbol ?? "STT",
    4,
  );

  const collateral = toBalance(
    collateralQuery.data?.[0],
    collateralDecimals,
    COLLATERAL_SYMBOL,
    // Collateral is money: show cents, and let `exact` carry the rest.
    2,
  );

  const error =
    (nativeQuery.error as Error | null) ??
    (collateralQuery.error as Error | null) ??
    (decimalsQuery.error as Error | null) ??
    null;

  return {
    native,
    collateral,
    collateralDecimals,
    isLoading: enabled && (nativeQuery.isLoading || collateralQuery.isLoading),
    isError: Boolean(nativeQuery.isError || collateralQuery.isError),
    error,
    refetch,
  };
}
