/**
 * VATICR — autonomous DeAI market maker for DreamDEX Event Contracts.
 *
 *   npm run bot:start
 *
 * Each cycle:
 *   1. ask the Vaticr intelligence layer for a Bayesian posterior on every live
 *      BTC/ETH window (price-process prior + decayed headline evidence);
 *   2. gate on the AUTHORITATIVE on-chain market status, never the indexer's;
 *   3. take when the posterior clears the touch, otherwise rest a two-sided
 *      mint-a-pair quote that needs no inventory;
 *   4. commit the forecast so the resolver can Brier-score it after settlement;
 *   5. sweep settled markets and redeem — winnings are claimed, not received.
 *
 * Runs in DRY_RUN by default: it logs every order it would send and sends
 * nothing. Set DRY_RUN=false with a funded PRIVATE_KEY to trade for real.
 */

import {
  activeMarkets,
  cancelTracked,
  createExchange,
  explainEmptyScope,
  isTradable,
  marketOnchain,
  maybeClaim,
  minLeftSec,
  netPosition,
  outcomeSymbols,
  placeLimit,
  quantize,
  shutdown,
  untrackOrder,
  type EcContext,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";

import { loadVaticrConfig, log, warn, type VaticrConfig } from "./config.js";
import { VaticrClient, type ForecastEnvelope } from "./signal.js";
import { ForecastRegistry } from "./registry.js";
import { decide, skipReason, type BookTop } from "./strategy.js";

let stopping = false;

const sleep = async (ms: number): Promise<void> => {
  for (let t = 0; t < ms; t += 500) {
    if (stopping) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};

interface Stats {
  cycles: number;
  quoted: number;
  taken: number;
  skipped: number;
  errors: number;
}

const stats: Stats = {
  cycles: 0, quoted: 0, taken: 0, skipped: 0, errors: 0,
};

/** Top of the YES book, in YES probability terms. */
async function bookTop(ctx: EcContext, yesSymbol: string): Promise<BookTop> {
  const ob = await ctx.exchange.fetchOrderBook(yesSymbol, 3);
  return { bestBid: ob.bids[0]?.[0], bestAsk: ob.asks[0]?.[0] };
}

async function actOnMarket(
  ctx: EcContext,
  cfg: VaticrConfig,
  api: VaticrClient,
  registry: ForecastRegistry | null,
  market: UnifiedMarket,
  envelope: ForecastEnvelope,
): Promise<void> {
  const f = envelope.forecast;

  // Always re-read the on-chain snapshot: the indexer lags by seconds and only
  // `Trading` accepts orders. Reuse this one snapshot for every read and write
  // in the pass so we never straddle a pool recycle.
  const onchain = await marketOnchain(ctx, market);
  if (!onchain) return;
  if (!isTradable(onchain)) {
    stats.skipped++;
    return;
  }

  const interval = isBinaryMarket(market.info) ? Number(market.info.intervalSec ?? 0) : 0;
  const secondsLeft = Number(onchain.expiry) - Date.now() / 1000;
  const minLeft = minLeftSec(interval || null);

  const skip = skipReason(f.posterior, secondsLeft, minLeft, f.degraded);
  if (skip) {
    stats.skipped++;
    log(`  ${market.symbol}: skip — ${skip}`);
    return;
  }

  const { yes } = outcomeSymbols(market);
  const top = await bookTop(ctx, yes);
  const net = ctx.config.dryRun ? 0 : await netPosition(ctx, onchain);
  const decision = decide(f.posterior, top, net, cfg);

  const bid = top.bestBid === undefined ? "  -  " : top.bestBid.toFixed(3);
  const ask = top.bestAsk === undefined ? "  -  " : top.bestAsk.toFixed(3);
  const ev = f.evidence.length ? ` news=${f.evidence_log_odds >= 0 ? "+" : ""}${f.evidence_log_odds.toFixed(3)}(${f.evidence.length})` : "";
  log(
    `  ${market.symbol} book=[${bid}/${ask}] prior=${f.prior.toFixed(3)} ` +
      `post=${f.posterior.toFixed(3)}${ev} net=${net.toFixed(1)} -> ${decision.action}`,
  );
  log(`     ${decision.reason}`);

  // Record the forecast before the window closes, so it can be scored honestly
  // after the oracle speaks rather than reconstructed afterwards.
  if (cfg.commitForecasts) await api.commit(envelope);
  if (registry && !cfg.dryRun) await registry.commit(envelope);

  if (decision.action === "skip") {
    stats.skipped++;
    return;
  }

  if (cfg.dryRun) {
    if (decision.action === "quote") {
      const legs = [
        decision.yesBid !== undefined ? `BUY_YES @ ${decision.yesBid.toFixed(3)}` : null,
        decision.noBid !== undefined ? `BUY_NO  @ ${decision.noBid.toFixed(3)}` : null,
      ].filter(Boolean);
      log(`     DRY_RUN would rest ${cfg.quoteSize} x [${legs.join(", ")}]`);
      stats.quoted++;
    } else {
      const leg = decision.action === "take_yes" ? "BUY_YES" : "BUY_NO";
      const px = decision.action === "take_yes" ? top.bestAsk : 1 - (top.bestBid ?? 0);
      log(`     DRY_RUN would take ${cfg.quoteSize} x ${leg} @ ${(px ?? 0).toFixed(3)}`);
      stats.taken++;
    }
    return;
  }

  // Clear our own stale quotes before re-posting, so levels never stack.
  for (const open of await ctx.exchange.fetchOpenOrders(yes).catch(() => [])) {
    await ctx.exchange.cancelOrder(open.id, yes).catch(() => undefined);
    untrackOrder(open.id);
  }

  const size = quantize(ctx, cfg.quoteSize);
  if (size <= 0) {
    warn(`${market.symbol}: quote size ${cfg.quoteSize} is below one lot — skipping`);
    stats.skipped++;
    return;
  }
  // Never outlive the window; also a dead-man's switch if this process dies.
  const ttl = Math.max(15, Math.min(cfg.orderTtlSec, Math.floor(secondsLeft) - 5));

  try {
    if (decision.action === "take_yes" || decision.action === "take_no") {
      const outcome = decision.action === "take_yes" ? "YES" : "NO";
      // Cross with an IOC at the touch, in the leg's own probability terms.
      const price =
        outcome === "YES" ? (top.bestAsk ?? f.posterior) : 1 - (top.bestBid ?? f.posterior);
      const res = await placeLimit(ctx, {
        market, onchain, outcome, side: "buy",
        price, size, type: "ioc", expiresInSec: ttl,
      });
      log(`     TAKE ${outcome} filled=${res.filled} @ ${res.price.toFixed(3)} tx=${res.hash ?? "-"}`);
      stats.taken++;
      return;
    }

    // Two resting buys = a complete two-sided quote with zero inventory.
    let rested = 0;
    for (const leg of [
      { outcome: "YES" as const, price: decision.yesBid },
      { outcome: "NO" as const, price: decision.noBid },
    ]) {
      if (leg.price === undefined) continue;
      try {
        const res = await placeLimit(ctx, {
          market, onchain, outcome: leg.outcome, side: "buy",
          price: leg.price, size, type: "post-only", expiresInSec: ttl,
        });
        rested++;
        log(
          `     QUOTE BUY_${leg.outcome} ${res.size} @ ${res.price.toFixed(3)} ` +
            `${res.rested ? `resting id=${res.orderId}` : `filled=${res.filled}`}`,
        );
      } catch (err) {
        // A post-only that would cross reverts with PostOnlyWouldCross. On a
        // quoting loop that is routine — the touch moved between read and send
        // — so requote next cycle instead of treating it as a fault.
        const msg = (err as Error).message;
        if (msg.includes("PostOnlyWouldCross")) {
          log(`     BUY_${leg.outcome} would cross — requoting next cycle`);
        } else {
          throw err;
        }
      }
    }
    if (rested) stats.quoted++;
  } catch (err) {
    stats.errors++;
    warn(`${market.symbol}: ${(err as Error).message}`);
  }
}

async function cycle(
  ctx: EcContext,
  cfg: VaticrConfig,
  api: VaticrClient,
  registry: ForecastRegistry | null,
): Promise<void> {
  stats.cycles++;

  const venueId = ctx.config.venueId;
  let envelopes: ForecastEnvelope[];
  try {
    envelopes = await api.forecasts(venueId, cfg.underlying || undefined);
  } catch (err) {
    stats.errors++;
    warn(
      `intelligence layer unreachable at ${cfg.apiUrl}: ${(err as Error).message}. ` +
        `Start it with:  npm run api`,
    );
    return;
  }

  const markets = await activeMarkets(ctx, { max: cfg.maxMarkets });
  if (markets.length === 0) {
    warn(`no live markets in scope — ${await explainEmptyScope(ctx)}`);
    return;
  }

  const byId = new Map(
    envelopes
      .filter((e) => e.forecast.market_id)
      .map((e) => [e.forecast.market_id!.toLowerCase(), e]),
  );

  log(
    `cycle ${stats.cycles}: ${markets.length} live market(s), ` +
      `${envelopes.length} forecast(s)`,
  );

  for (const market of markets) {
    if (stopping) break;
    if (cfg.underlying && !market.symbol.toUpperCase().includes(cfg.underlying)) continue;
    const marketId = String((market.info as { marketId?: string }).marketId ?? "");
    const envelope = byId.get(marketId.toLowerCase());
    if (!envelope) {
      log(`  ${market.symbol}: no forecast yet (window just opened) — skipping`);
      stats.skipped++;
      continue;
    }
    try {
      await actOnMarket(ctx, cfg, api, registry, market, envelope);
    } catch (err) {
      stats.errors++;
      warn(`${market.symbol}: ${(err as Error).message}`);
    }
  }

  // Winnings are claimed, not received: a settled position does not decay into
  // collateral on its own. Driven from the loop (not a timer) so it serialises
  // with this strategy's writes and cannot race its own nonce.
  if (!cfg.dryRun && ctx.canTrade) {
    try {
      // `maybeClaim` is throttled internally (AUTO_CLAIM_INTERVAL_MS) and
      // returns void — it logs its own sweeps.
      await maybeClaim(ctx);
    } catch (err) {
      warn(`claim sweep failed: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadVaticrConfig();
  const ctx = createExchange({ withSigner: !cfg.dryRun });

  console.log(`
================================================================================
  VATICR — Autonomous DeAI Market Maker for DreamDEX Event Contracts
  Somnia ${ctx.config.network} (chainId ${ctx.config.chainId})
================================================================================
  mode          ${cfg.dryRun ? "DRY_RUN — logging orders, sending nothing" : "LIVE — sending real orders"}
  wallet        ${ctx.exchange.walletAddress ?? "(read-only)"}
  venue         ${ctx.config.venueId ?? "(inferred from live markets)"}
  intelligence  ${cfg.apiUrl}
  underlying    ${cfg.underlying || "all"}
  edge / spread ${cfg.edgeThreshold} / ${cfg.halfSpread}
  quote size    ${cfg.quoteSize} shares   inventory cap ${cfg.maxNetInventory}
================================================================================
`);

  const api = new VaticrClient(cfg.apiUrl);
  const registry = ForecastRegistry.create(ctx);
  if (registry) log(`forecast registry: ${process.env.VATICR_REGISTRY}`);
  try {
    const health = await api.health();
    log(
      `intelligence layer: ${health["headlines_in_window"] ?? "?"} headline(s) in window, ` +
        `classifier ${health["llm_classifier"] ?? "?"}, network ${health["network"] ?? "?"}`,
    );
  } catch {
    warn(
      `intelligence layer not reachable at ${cfg.apiUrl} — start it with 'npm run api'. ` +
        `Retrying each cycle.`,
    );
  }
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} — finishing cycle and cancelling resting orders…`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    try {
      await cycle(ctx, cfg, api, registry);
    } catch (err) {
      stats.errors++;
      warn(`cycle failed: ${(err as Error).message}`);
    }
    await sleep(cfg.refreshMs);
  }

  if (!cfg.dryRun) {
    const { cancelled, tracked } = await cancelTracked(ctx);
    log(`cancelled ${cancelled} of ${tracked} tracked order(s)`);
  }
  log(
    `done — cycles=${stats.cycles} quoted=${stats.quoted} taken=${stats.taken} ` +
      `skipped=${stats.skipped} errors=${stats.errors}`,
  );
  await shutdown(ctx);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
