/**
 * Preflight for Vaticr — run this before trading for real.
 *
 *   npm run doctor
 *
 * Checks the three things that actually stop a bot: the venue scope resolves to
 * live markets, the intelligence layer is answering, and the wallet can pay for
 * what it is about to do.
 */

import {
  activeMarkets,
  createExchange,
  explainEmptyScope,
  marketOnchain,
  outcomeSymbols,
  resolveVenue,
  shutdown,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";

import { loadVaticrConfig } from "./config.js";
import { VaticrClient } from "./signal.js";

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`    ${s}`);

/**
 * Open the exchange the way the RUNNER will open it.
 *
 * This is the whole reason the preflight exists, and it was the one thing it
 * did not do. `createExchange()` with no options passes `privateKey: undefined`
 * to the SDK, so `exchange.walletAddress` is undefined no matter what is in
 * .env — which made the signer check below report "DRY_RUN=false but no
 * PRIVATE_KEY" against a perfectly good funded key, and skip the gas and
 * collateral reads that are the only reason to run this before going live.
 *
 * `createExchange({ withSigner: true })` THROWS when the key really is missing,
 * and a preflight that dies on its last check has told you nothing about the
 * first four. So catch it, keep the message, and fall back to a read-only
 * context so the rest of the report still runs.
 */
function openExchange(wantSigner: boolean): { ctx: EcContext; signerError: string | null } {
  if (!wantSigner) return { ctx: createExchange(), signerError: null };
  try {
    return { ctx: createExchange({ withSigner: true }), signerError: null };
  } catch (err) {
    return { ctx: createExchange(), signerError: (err as Error).message };
  }
}

async function main(): Promise<void> {
  const cfg = loadVaticrConfig();
  const { ctx, signerError } = openExchange(!cfg.dryRun);
  let failures = 0;

  console.log("\nVATICR DOCTOR\n=============\n");

  console.log(`network / chain`);
  ok(`${ctx.config.network} (chainId ${ctx.config.chainId})`);
  info(`rpc      ${ctx.config.rpcUrl}`);
  info(`indexer  ${ctx.config.indexerUrl}`);
  info(`collateral ${ctx.config.addresses.collateral} (${ctx.config.decimals} dp)`);

  console.log(`\nmodule bytecode`);
  try {
    const client = ctx.exchange.client.getViemClient();
    const code = await client.getCode({
      address: ctx.config.addresses.binaryModule as `0x${string}`,
    });
    if (code && code !== "0x") ok(`BinaryMarketsModule has code at ${ctx.config.addresses.binaryModule}`);
    else { bad(`no code at ${ctx.config.addresses.binaryModule} — stale address`); failures++; }
  } catch (err) {
    bad(`bytecode check failed: ${(err as Error).message}`);
    failures++;
  }

  console.log(`\nvenue scope`);
  try {
    const venue = await resolveVenue(ctx);
    if (venue.markets === 0) {
      bad(`no live markets — ${await explainEmptyScope(ctx)}`);
      failures++;
    } else {
      ok(`${venue.markets} live market(s), venue from ${venue.source}`);
      info(`venueId ${venue.scope.venueId ?? "(none)"}`);
      if (venue.source === "inferred") {
        info("set VENUE_ID in .env to pin this — venue ids move between deploys");
      }
    }
  } catch (err) {
    bad(`${(err as Error).message}`);
    failures++;
  }

  console.log(`\nlive markets${cfg.underlying ? ` (EC_UNDERLYING=${cfg.underlying})` : ""}`);
  try {
    // Same `asset` scoping the runner uses, and for the same reason: the filter
    // has to happen before the slice or a configured underlying can vanish
    // behind markets of the other one.
    const markets = await activeMarkets(ctx, { asset: cfg.underlying || undefined, max: 5 });
    for (const m of markets) {
      const onchain = await marketOnchain(ctx, m);
      const left = onchain ? Number(onchain.expiry) - Date.now() / 1000 : 0;
      const { yes } = outcomeSymbols(m);
      const ob = await ctx.exchange.fetchOrderBook(yes, 1).catch(() => null);
      const top = ob
        ? `[${ob.bids[0]?.[0]?.toFixed(3) ?? "-"}/${ob.asks[0]?.[0]?.toFixed(3) ?? "-"}]`
        : "[book unavailable]";
      ok(`${m.symbol}  status=${onchain?.status ?? "?"} left=${Math.round(left)}s ${top}`);
    }
    if (markets.length === 0) { bad("none in scope"); failures++; }
  } catch (err) {
    bad(`${(err as Error).message}`);
    failures++;
  }

  console.log(`\nintelligence layer (${cfg.apiUrl})`);
  const api = new VaticrClient(cfg.apiUrl);
  try {
    const health = await api.health();
    ok(`reachable — ${health["headlines_in_window"]} headline(s) in window`);
    info(`classifier ${health["llm_classifier"]}, ${health["feeds"]} feed(s)`);
    const forecasts = await api.forecasts(ctx.config.venueId, cfg.underlying || undefined);
    if (forecasts.length === 0) {
      bad("no forecasts returned — check the venue matches the API's network");
      failures++;
    } else {
      ok(`${forecasts.length} forecast(s)`);
      for (const e of forecasts.slice(0, 3)) {
        const f = e.forecast;
        info(
          `${f.symbol}  prior=${f.prior.toFixed(3)} post=${f.posterior.toFixed(3)} ` +
            `vol=${f.annual_vol.toFixed(3)} (${f.vol_source})`,
        );
      }
    }
  } catch (err) {
    bad(`unreachable: ${(err as Error).message}`);
    info("start it with:  npm run api");
    failures++;
  }

  console.log(`\nsigner`);
  if (cfg.dryRun) {
    ok("DRY_RUN — no signer needed. Set DRY_RUN=false to trade.");
  } else if (signerError) {
    bad(signerError);
    failures++;
  } else if (!ctx.exchange.walletAddress) {
    // With withSigner:true this is unreachable — createExchange throws first —
    // but an SDK that changed its mind about that should fail loudly, not quietly.
    bad("no wallet address on a signing exchange — the SDK did not load the key");
    failures++;
  } else {
    const me = ctx.exchange.walletAddress;
    ok(`wallet ${me}`);
    try {
      const client = ctx.exchange.client;
      const gas = await client.getViemClient().getBalance({ address: me });
      const collateral = ctx.config.addresses.collateral;
      const bal = collateral ? await client.getErc20Balance(collateral, me) : 0n;
      const one = 10n ** BigInt(ctx.config.decimals);

      // Gas: "non-zero" is not a passing grade. The SDK signs with a fixed
      // generous gas ceiling and never estimates, so the balance has to cover
      // that ceiling or the node rejects the send with an error viem reports as
      // "Missing or invalid parameters" — the failure vendor/ec-core documents
      // as taking 24 identical log lines to diagnose.
      const gasHuman = Number(gas) / 1e18;
      if (gas === 0n) { bad("0 native token — cannot pay gas"); failures++; }
      else if (gasHuman < 0.01) {
        bad(`gas ${gasHuman.toFixed(6)} native — too thin for a run; top up the faucet`);
        failures++;
      } else ok(`gas ${gasHuman.toFixed(4)} native`);

      // Collateral: enough for one full two-sided quote, which is the smallest
      // thing this bot ever does. A buy escrows price x size in the leg's OWN
      // price, so both legs together escrow
      //     quoteSize x ((p - d) + (1 - p - d)) = quoteSize x (1 - 2d)
      // — always under one whole `quoteSize`, whatever the posterior. Demand
      // that much so "funded" means "can rest the quote it is configured for".
      const balHuman = Number(bal) / Number(one);
      const needed = cfg.quoteSize;
      if (bal === 0n) {
        bad(`0 collateral — fund ${collateral} or let the testnet faucet run`);
        failures++;
      } else if (balHuman < needed) {
        bad(
          `collateral ${balHuman.toFixed(2)} — under one quote (${needed}); ` +
            `fund ${collateral} → ${me}`,
        );
        failures++;
      } else {
        ok(`collateral ${balHuman.toFixed(2)} (one two-sided quote escrows under ${needed})`);
        info(
          `spend rail VATICR_MAX_NOTIONAL=${cfg.maxNotional} — about ` +
            `${Math.floor(cfg.maxNotional / Math.max(needed, 1e-9))} two-sided quote(s) ` +
            `committed at once before writes stop`,
        );
      }
    } catch (err) {
      bad(`balance check failed: ${(err as Error).message}`);
      failures++;
    }
  }

  console.log(
    failures === 0
      ? "\nAll checks passed — ready to run 'npm run bot:start'.\n"
      : `\n${failures} check(s) failed — fix the above before trading.\n`,
  );
  await shutdown(ctx);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
