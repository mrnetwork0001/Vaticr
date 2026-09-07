"use client";

/**
 * The bridge between the visitor's wallet and the SDK exchange.
 *
 * The SDK documents exactly one shape for this, on `SomniaMarkets.setSigner`:
 *
 *   "Browser apps construct the exchange at boot for public reads, then call
 *    this when the user's wallet connects - and again with `{}` on disconnect,
 *    which returns the exchange to unauthenticated reads."
 *
 * So there is ONE exchange for the tab's lifetime (see `exchange.ts`) and this
 * hook only ever rebinds its signer. It never constructs a second one, because
 * a second one would mean a second WebSocket and a second live-tail store - and
 * a signer bound to whichever of the two the caller happened to hold.
 *
 * The case that is easy to get wrong is not connect or disconnect but the
 * ACCOUNT SWITCH: the user picks a different address in MetaMask without ever
 * disconnecting. `useWalletClient` hands back a *new* client object for the new
 * account, so the effect re-runs and rebinds; the guard below additionally
 * refuses to bind a wallet client whose account disagrees with wagmi's, so a
 * client that is momentarily stale during the switch can never sign as the
 * account the UI is showing.
 */

import { useEffect, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Address } from "viem";
import type { SomniaMarkets, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { SOMNIA_CHAIN_ID } from "./chain";
import { getVaticrExchange } from "./exchange";

export interface VaticrExchange {
  /** The shared exchange. Reads always work; writes need `canTrade`. */
  readonly exchange: SomniaMarkets;
  /** The SDK's native engine - bigint-exact reads. `exchange.client`. */
  readonly client: SomniaMarketsClient;
  /** The connected account, or `undefined`. */
  readonly address: Address | undefined;
  /** A wallet is connected (it may still be on the wrong chain). */
  readonly isConnected: boolean;
  /** The wallet is on Somnia testnet (50312). */
  readonly chainOk: boolean;
  /** The chain the wallet currently reports; `undefined` when disconnected. */
  readonly chainId: number | undefined;
  /**
   * `exchange.setSigner` has been applied for exactly `address`.
   *
   * Binding happens in an effect, so there is a render between "wagmi says
   * connected" and "the exchange can sign". Anything that calls a write verb
   * must gate on `canTrade`, not on `isConnected`.
   */
  readonly signerReady: boolean;
  /**
   * The single gate every write path in the app must check:
   * connected AND on Somnia AND the exchange's signer is bound to this account.
   */
  readonly canTrade: boolean;
}

export function useVaticrExchange(): VaticrExchange {
  const exchange = getVaticrExchange();
  // `useAccount().chainId` is the chain the CONNECTION reports. `useChainId()`
  // is wagmi's configured chain, which on a single-chain config answers 50312
  // no matter what network the wallet is actually on - it cannot detect a
  // wrong network, which is the one thing this needs to detect.
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();

  const chainOk = chainId === SOMNIA_CHAIN_ID;

  // Which account the exchange's signer is currently bound to, as far as this
  // tab knows. Kept in state (not a ref) because `canTrade` flipping must
  // re-render the trade UI.
  const [boundTo, setBoundTo] = useState<Address | undefined>(undefined);

  useEffect(() => {
    const walletAccount = walletClient?.account?.address;

    // Bind only when every source agrees: wagmi says connected, the chain is
    // ours, and the wallet client's own account is the account wagmi reports.
    // A mismatch means we are mid-switch and the client is stale - signing with
    // it would sign as an address the UI is not showing.
    const ready =
      isConnected &&
      chainOk &&
      Boolean(walletClient) &&
      Boolean(walletAccount) &&
      Boolean(address) &&
      walletAccount!.toLowerCase() === address!.toLowerCase();

    if (ready) {
      // `setSigner` drops the cached trader, so this is also the account-switch
      // path: the next `exchange.trader` is rebuilt against the new client.
      exchange.setSigner({ walletClient });
      setBoundTo(walletAccount as Address);
      return;
    }

    // Disconnected, wrong chain, or mid-switch: hand the exchange back to
    // unauthenticated reads. Note this runs in the effect BODY, not in a
    // cleanup - a cleanup would clear the signer whenever any one of several
    // components using this hook unmounted, even though the wallet is still
    // connected for the rest of them.
    exchange.setSigner({});
    setBoundTo(undefined);
  }, [exchange, walletClient, address, isConnected, chainOk]);

  const signerReady =
    boundTo !== undefined && address !== undefined && boundTo.toLowerCase() === address.toLowerCase();

  return {
    exchange,
    client: exchange.client,
    address,
    isConnected,
    chainOk,
    chainId,
    signerReady,
    canTrade: isConnected && chainOk && signerReady,
  };
}
