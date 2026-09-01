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
} from "@dreamdex-bot-kit/ec-core";

import { loadVaticrConfig } from "./config.js";
import { VaticrClient } from "./signal.js";

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`    ${s}`);

async function main(): Promise<void> {
  const cfg = loadVaticrConfig();
  const ctx = createExchange();
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

  console.log(`\nlive markets`);
  try {
    const markets = await activeMarkets(ctx, { max: 5 });
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
  } else if (!ctx.exchange.walletAddress) {
    bad("DRY_RUN=false but no PRIVATE_KEY");
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
      if (gas === 0n) { bad("0 native token — cannot pay gas"); failures++; }
      else ok(`gas ${(Number(gas) / 1e18).toFixed(4)} native`);
      if (bal === 0n) {
        bad(`0 collateral — fund ${collateral} or let the testnet faucet run`);
        failures++;
      } else ok(`collateral ${(Number(bal) / Number(one)).toFixed(2)}`);
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
