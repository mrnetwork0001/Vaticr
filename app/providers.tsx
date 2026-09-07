"use client";

/**
 * The client-side context stack the whole site renders inside.
 *
 * Order matters, and it is the order the libraries require rather than a
 * preference:
 *
 *   WagmiProvider          - owns the wallet connection and the viem clients.
 *     QueryClientProvider  - wagmi v2 stores every connector/read result here,
 *                            so it must be INSIDE Wagmi's provider tree.
 *       SomniaMarketsProvider
 *                          - hands the SDK's live-tail engine to the
 *                            `useLive*` / `usePortfolio` hooks.
 *
 * The page was read-only until now, so this wraps `app/layout.tsx` rather than
 * any one route: every page keeps working with no wallet connected, and the
 * dashboard gains the ability to ask for one.
 */

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { SomniaMarketsProvider } from "@somnia-chain/markets-sdk/react";
import { getVaticrExchange } from "./components/wallet/exchange";
import { getWagmiConfig } from "./components/wallet/wagmi";

export default function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per browser tab. Built in state rather than at module scope
  // so a server render never shares a cache between two users' requests.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain data goes stale on its own schedule; refetching on every
            // window focus just burns RPC calls on a dashboard left open.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  // `getVaticrExchange()` is idempotent and does no I/O, so calling it during
  // the server render is free and the client picks up the same instance.
  const [exchange] = useState(getVaticrExchange);

  return (
    <WagmiProvider config={getWagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        <SomniaMarketsProvider client={exchange.client}>
          {children}
        </SomniaMarketsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
