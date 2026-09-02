/**
 * The wagmi configuration — one chain, one HTTP transport, and whichever
 * connectors this deployment can actually offer.
 *
 * WalletConnect is opt-in. It needs a project id from the WalletConnect cloud
 * console, and a *missing* id must not be a crash: a visitor with MetaMask
 * installed should still be able to trade on a checkout of this repo that has
 * no `.env.local`. So the connector list is built conditionally and the site
 * degrades to injected-only.
 */

import { createConfig, http, type Config, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { SOMNIA_HTTP_RPC, somniaTestnet } from "./chain";

/** Set to enable the WalletConnect QR flow (mobile wallets). Optional. */
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || undefined;

/** True when the WalletConnect connector is available in this build. */
export const walletConnectEnabled = Boolean(WALLETCONNECT_PROJECT_ID);

function connectors(): CreateConnectorFn[] {
  // Typed up front: pushing a second connector into an array inferred from the
  // first one is a type error, and the inferred type is not one we can name.
  const list: CreateConnectorFn[] = [
    // `shimDisconnect` so a disconnect in our UI is remembered across reloads;
    // without it an injected wallet re-attaches itself on every page load and
    // "Disconnect" appears not to work.
    injected({ shimDisconnect: true }),
  ];
  if (WALLETCONNECT_PROJECT_ID) {
    list.push(
      walletConnect({
        projectId: WALLETCONNECT_PROJECT_ID,
        showQrModal: true,
        metadata: {
          name: "Vaticr",
          description: "Bayesian forecasts on DreamDEX Event Contracts",
          url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
          icons: [],
        },
      }),
    );
  }
  return list;
}

const CACHE_KEY = "__vaticr_wagmi_config__";
type ConfigCache = { [CACHE_KEY]?: Config };

/**
 * The shared wagmi config.
 *
 * Cached on `globalThis` for the same reason the exchange is: a hot reload that
 * forks the config forks the connection state with it, and the wallet appears
 * to disconnect itself.
 */
export function getWagmiConfig(): Config {
  const cache = globalThis as unknown as ConfigCache;
  cache[CACHE_KEY] ??= createConfig({
    chains: [somniaTestnet],
    connectors: connectors(),
    transports: { [somniaTestnet.id]: http(SOMNIA_HTTP_RPC) },
    // The app is server-rendered; without this wagmi reads localStorage during
    // hydration and the first client paint disagrees with the server's.
    ssr: true,
  });
  return cache[CACHE_KEY]!;
}
