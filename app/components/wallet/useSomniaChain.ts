"use client";

/**
 * Getting a wallet onto Somnia testnet.
 *
 * Almost no wallet ships Somnia in its network list, so the ordinary
 * `wallet_switchEthereumChain` path fails before it can switch: the wallet
 * answers 4902 ("Unrecognized chain ID"). The fallback is
 * `wallet_addEthereumChain`, which adds the network and - in every wallet that
 * implements it - offers to switch in the same prompt.
 *
 * wagmi's injected connector already tries this internally, but not every
 * connector does and the internal attempt is silent about which half failed. So
 * the fallback is explicit here, and the error that reaches the UI names the
 * step that actually broke.
 */

import { useCallback, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { SOMNIA_ADD_CHAIN_PARAMS, SOMNIA_CHAIN_ID } from "./chain";

/** A wallet's EIP-1193 surface, as much of it as this file needs. */
type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** 4902 is EIP-3085's "chain not added". Some wallets nest it, some stringify. */
function isUnknownChain(err: unknown): boolean {
  const e = err as { code?: number; cause?: { code?: number }; message?: string };
  if (e?.code === 4902 || e?.cause?.code === 4902) return true;
  const msg = (e?.message ?? "").toLowerCase();
  return (
    msg.includes("unrecognized chain") ||
    msg.includes("chain not added") ||
    msg.includes("not been added") ||
    msg.includes("chainnotconfigured")
  );
}

/** The user closed the wallet prompt. Not an error worth a red banner. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; cause?: { code?: number }; name?: string; message?: string };
  if (e?.code === 4001 || e?.cause?.code === 4001) return true;
  const msg = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return msg.includes("user rejected") || msg.includes("user denied");
}

export interface SomniaChainState {
  /** The chain the wallet reports, or `undefined` when disconnected. */
  chainId: number | undefined;
  /** The wallet is on Somnia testnet. */
  chainOk: boolean;
  /** A switch or add is in flight. */
  isSwitching: boolean;
  /** The last failure, verbatim. `null` once a switch succeeds. */
  error: Error | null;
  /** Switch, adding the network first if the wallet has never heard of it. */
  switchToSomnia: () => Promise<void>;
}

export function useSomniaChain(): SomniaChainState {
  const { chainId, connector, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const switchToSomnia = useCallback(async () => {
    setError(null);
    setIsSwitching(true);
    try {
      try {
        await switchChainAsync({ chainId: SOMNIA_CHAIN_ID });
        return;
      } catch (err) {
        if (isUserRejection(err)) throw err;
        if (!isUnknownChain(err)) throw err;
        // Fall through to the add path below.
      }

      const provider = (await connector?.getProvider()) as Eip1193 | undefined;
      if (!provider?.request) {
        throw new Error(
          "This wallet does not expose a provider we can add a network through. " +
            "Add Somnia Shannon Testnet (chain 50312) manually, then reconnect.",
        );
      }

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [SOMNIA_ADD_CHAIN_PARAMS],
      });

      // Adding usually switches too, but not in every wallet - ask again. If it
      // is already current this resolves immediately.
      await switchChainAsync({ chainId: SOMNIA_CHAIN_ID }).catch((err: unknown) => {
        // The add succeeded; a follow-up switch that the user dismissed is not
        // a failed add, and `chainId` below will still say so.
        if (!isUserRejection(err)) throw err;
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsSwitching(false);
    }
  }, [connector, switchChainAsync]);

  return {
    chainId,
    chainOk: isConnected && chainId === SOMNIA_CHAIN_ID,
    isSwitching,
    error,
    switchToSomnia,
  };
}
