/**
 * VATICR - autonomous DeAI market maker for DreamDEX Event Contracts.
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
 *   5. sweep settled markets and redeem - winnings are claimed, not received.
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
import { ContractRevertError, isBinaryMarket } from "@somnia-chain/markets-sdk";

import { loadVaticrConfig, log, warn, type VaticrConfig } from "./config.js";
import { VaticrClient, type ForecastEnvelope } from "./signal.js";
import { ForecastRegistry } from "./registry.js";
import { NotionalBudget } from "./risk.js";
import { getSomniaRpcError } from "@somnia-chain/markets-sdk/native";
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

/**
 * What the NODE said, not what viem made of it.
 *
 * Somnia reports a mempool rejection as JSON-RPC -32000 with the real reason in
 * `message` and a status byte in `data`. viem maps -32000 to
 * `InvalidInputRpcError`, whose short message is the generic "Missing or
 * invalid parameters." - so the default log accuses the payload while the node
 * is actually saying something specific and actionable. The SDK ships the
 * unwrapper; this uses it, and appends the mempool verdict when there is one.
 */
function explain(err: unknown): string {
  const base = (err as Error)?.message ?? String(err);
  const rpc = getSomniaRpcError(err);
  if (!rpc) return base;
  const status = rpc.mempoolStatus ? ` [${rpc.mempoolStatus}]` : "";
  const first = base.split("\n")[0];
  return rpc.message && rpc.message !== first
    ? `${first} - node said: ${rpc.message}${status}`
    : `${first}${status}`;
}

/**
 * Markets this process may have an order resting on.
 *
 * `cancelResting` is two indexer round-trips, and on testnet each can take
 * tens of seconds. Paying that on every skip - for markets the bot has never
 * quoted and cannot have anything resting on - made a four-market cycle take
 * four minutes, by which time every window had aged past its minimum and the
 * bot skipped them all again. It could never trade.
 *
 * A market enters this set when an order is placed on it and leaves when the
 * sweep comes back empty. `sweptAtStartup` forces one full pass on the first
 * cycle, because orders from a previous run of this process are not in here
 * and do need pulling.
 */
const mayHaveResting = new Set<string>();
let sweptAtStartup = false;

/** Top of the YES book, in YES probability terms. */
async function bookTop(ctx: EcContext, yesSymbol: string): Promise<BookTop> {
  const ob = await ctx.exchange.fetchOrderBook(yesSymbol, 3);
  return { bestBid: ob.bids[0]?.[0], bestAsk: ob.asks[0]?.[0] };
}

/**
 * Pull every order this wallet has resting on one market - BOTH legs.
 *
 * Read from the SDK rather than assumed: `fetchOpenOrders(ref)` does NOT return
 * a market's orders, it returns one TRADABLE's. The unified exchange maps each
 * indexed row through `tryResolvePool(pool, side)`, which resolves `BUY_NO` to
 * the `#NO` tradable, and then drops anything whose outcome differs from the
 * ref's (`if (scope?.outcome && t.outcome !== scope.outcome) return []`,
 * markets-sdk `unified/exchange.ts`). So asking for the YES symbol returns the
 * BUY_YES leg and silently omits the BUY_NO one - even though the two share a
 * pool and a book - and the requote loop was leaving half its quote resting at
 * a stale price on every cycle. One symbol is emphatically not enough; ask for
 * both. (`cancelOrder(id, ref)` only needs the ref to find the pool, which both
 * symbols resolve to identically, but pairing each id with the symbol it came
 * back on keeps the mapping honest.)
 */
async function cancelResting(ctx: EcContext, market: UnifiedMarket): Promise<number> {
  const { yes, no } = outcomeSymbols(market);
  let pulled = 0;
  for (const symbol of [yes, no]) {
    for (const open of await ctx.exchange.fetchOpenOrders(symbol).catch(() => [])) {
      await ctx.exchange.cancelOrder(open.id, symbol).catch(() => undefined);
      untrackOrder(open.id);
      pulled++;
    }
  }
  return pulled;
}

async function actOnMarket(
  ctx: EcContext,
  cfg: VaticrConfig,
  api: VaticrClient,
  registry: ForecastRegistry | null,
  budget: NotionalBudget,
  market: UnifiedMarket,
  envelope: ForecastEnvelope,
): Promise<void> {
  const f = envelope.forecast;

  /**
   * Every path that declines to trade this market leaves through here.
   *
   * A quote already resting is a live order at a price the bot has just decided
   * it no longer wants - the market went untradable, the headroom ran out, the
   * posterior pinned, inventory capped. Returning without cancelling leaves it
   * working until `orderTtlSec` (90s by default, up to nine cycles), quoting a
   * view that has been abandoned, and it is the *skip* conditions that most
   * often mean the old price is now the wrong one. Cancel on the way out.
   *
   * Best-effort by design: on a market that has already left `Trading` the
   * cancel may itself revert, which is fine - those orders can no longer fill
   * and expire at the market's own expiry (`placeLimit` caps every TTL there).
   */
  const standDown = async (why: string | null): Promise<void> => {
    stats.skipped++;
    if (why) log(`  ${market.symbol}: skip - ${why}`);
    if (cfg.dryRun) {
      // Mirror the live path's book-keeping so the rail reads the same in both
      // modes - a dry run that never releases escrow would report a cap breach
      // a live run would not have hit.
      budget.releaseMarket(market.symbol);
      return;
    }
    if (!sweptAtStartup || mayHaveResting.has(market.symbol)) {
      const pulled = await cancelResting(ctx, market).catch(() => 0);
      if (pulled) log(`     pulled ${pulled} stale resting order(s)`);
      else mayHaveResting.delete(market.symbol);
    }
    budget.releaseMarket(market.symbol);
  };

  // Always re-read the on-chain snapshot: the indexer lags by seconds and only
  // `Trading` accepts orders. Reuse this one snapshot for every read and write
  // in the pass so we never straddle a pool recycle.
  // The envelope already knows the posterior and roughly how long is left. When
  // that alone is decisive, say so now rather than after a chain read: on a
  // window with 78s left the answer cannot change, and the read is not free.
  const interval0 = isBinaryMarket(market.info) ? Number(market.info.intervalSec ?? 0) : 0;
  const earlySkip = skipReason(f.posterior, f.seconds_left, minLeftSec(interval0 || null), f.degraded);
  if (earlySkip) {
    await standDown(earlySkip);
    return;
  }

  const onchain = await marketOnchain(ctx, market);
  // Not a binary row at all, so it has no YES/NO books and nothing of ours can
  // be resting on it - the one early return with nothing to stand down from.
  if (!onchain) return;
  if (!isTradable(onchain)) {
    await standDown(null);
    return;
  }

  const interval = isBinaryMarket(market.info) ? Number(market.info.intervalSec ?? 0) : 0;
  const secondsLeft = Number(onchain.expiry) - Date.now() / 1000;
  const minLeft = minLeftSec(interval || null);

  const skip = skipReason(f.posterior, secondsLeft, minLeft, f.degraded);
  if (skip) {
    await standDown(skip);
    return;
  }

  const { yes } = outcomeSymbols(market);
  const top = await bookTop(ctx, yes);
  const net = ctx.config.dryRun ? 0 : await netPosition(ctx, onchain);
  // The venue's tick in probability terms, so the quote can be clamped one tick
  // inside the touch instead of reverting through it (see strategy.ts).
  const tickProb = Number(ctx.config.tick) / 10 ** ctx.config.decimals;
  const decision = decide(f.posterior, top, net, cfg, tickProb);

  const bid = top.bestBid === undefined ? " - " : top.bestBid.toFixed(3);
  const ask = top.bestAsk === undefined ? " - " : top.bestAsk.toFixed(3);
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
    await standDown(null);
    return;
  }

  // Quantize in dry run too: the lot grid is pure config, so a size that the
  // venue would refuse should be visible in the log before it is live.
  const size = quantize(ctx, cfg.quoteSize);
  if (size <= 0) {
    warn(`${market.symbol}: quote size ${cfg.quoteSize} is below one lot - skipping`);
    await standDown(null);
    return;
  }

  /**
   * The spend rail, checked immediately before each write rather than once per
   * cycle: a cycle places up to two legs on each of `maxMarkets` markets, and
   * the only place a running total can be honest is at the last moment before
   * the order goes out. Charged in dry run too, so the log shows the rail
   * biting where a live run would stop.
   */
  const afford = (price: number, what: string): boolean => {
    if (budget.reserve(market.symbol, price, size)) return true;
    warn(
      `${market.symbol}: ${what} refused - notional cap ${budget.cap} reached ` +
        `(committed ${budget.committed.toFixed(2)}, this order ` +
        `${NotionalBudget.costOf(price, size).toFixed(2)}). ` +
        `Raise VATICR_MAX_NOTIONAL deliberately.`,
    );
    return false;
  };

  if (cfg.dryRun) {
    // The previous cycle's quotes on this market are about to be replaced, so
    // their escrow is refunded and must stop counting against the cap before
    // the replacements are priced. The live path does this after the cancel
    // actually goes out, below.
    budget.releaseMarket(market.symbol);
    if (decision.action === "quote") {
      const legs: string[] = [];
      if (decision.yesBid !== undefined && afford(decision.yesBid, "BUY_YES")) {
        legs.push(`BUY_YES @ ${decision.yesBid.toFixed(3)}`);
      }
      if (decision.noBid !== undefined && afford(decision.noBid, "BUY_NO")) {
        legs.push(`BUY_NO  @ ${decision.noBid.toFixed(3)}`);
      }
      if (legs.length === 0) return;
      log(`     DRY_RUN would rest ${size} x [${legs.join(", ")}]`);
      stats.quoted++;
    } else {
      const leg = decision.action === "take_yes" ? "BUY_YES" : "BUY_NO";
      const px = decision.takePrice ?? f.posterior;
      if (!afford(px, leg)) return;
      log(`     DRY_RUN would take ${size} x ${leg} IOC @ ${px.toFixed(3)}`);
      stats.taken++;
    }
    return;
  }

  // Clear our own stale quotes before re-posting, so levels never stack - and
  // give the rail back the escrow those orders were holding.
  await cancelResting(ctx, market);
  budget.releaseMarket(market.symbol);

  // Never outlive the window; also a dead-man's switch if this process dies.
  const ttl = Math.max(15, Math.min(cfg.orderTtlSec, Math.floor(secondsLeft) - 5));

  try {
    if (decision.action === "take_yes" || decision.action === "take_no") {
      const outcome = decision.action === "take_yes" ? "YES" : "NO";
      // Cross with an IOC one buffer THROUGH the touch, in the leg's own
      // probability terms, capped at fair value (strategy.ts `takeAt`).
      const price = decision.takePrice ?? f.posterior;
      if (!afford(price, `take ${outcome}`)) return;
      try {
        mayHaveResting.add(market.symbol);
        const res = await placeLimit(ctx, {
          market, onchain, outcome, side: "buy",
          price, size, type: "ioc", expiresInSec: ttl,
        });
        // An IOC never rests: what filled is spent, the rest was refunded.
        budget.recordFill(market.symbol, res.price, res.filled);
        budget.release(market.symbol, res.price, size - res.filled);
        log(`     TAKE ${outcome} filled=${res.filled} @ ${res.price.toFixed(3)} tx=${res.hash ?? "-"}`);
        stats.taken++;
      } catch (err) {
        budget.release(market.symbol, price, size);
        throw err;
      }
      return;
    }

    // Two resting buys = a complete two-sided quote with zero inventory.
    let rested = 0;
    for (const leg of [
      { outcome: "YES" as const, price: decision.yesBid },
      { outcome: "NO" as const, price: decision.noBid },
    ]) {
      if (leg.price === undefined) continue;
      if (!afford(leg.price, `BUY_${leg.outcome}`)) continue;
      try {
        mayHaveResting.add(market.symbol);
        const res = await placeLimit(ctx, {
          market, onchain, outcome: leg.outcome, side: "buy",
          price: leg.price, size, type: "post-only", expiresInSec: ttl,
        });
        rested++;
        // Anything that crossed on arrival is spent; the remainder stays as
        // escrow on the resting order until the next cycle cancels it.
        budget.recordFill(market.symbol, res.price, res.filled);
        log(
          `     QUOTE BUY_${leg.outcome} ${res.size} @ ${res.price.toFixed(3)} ` +
            `${res.rested ? `resting id=${res.orderId}` : `filled=${res.filled}`}`,
        );
      } catch (err) {
        // Nothing was escrowed by a reverted order - give the rail its budget
        // back before deciding what the revert was.
        budget.release(market.symbol, leg.price, size);
        // A post-only that would cross reverts with PostOnlyWouldCross. On a
        // quoting loop that is routine - the touch moved between read and send
        // - so requote next cycle instead of treating it as a fault.
        //
        // Branch on the SDK's DECODED error, never on the message text. The
        // SDK wraps every revert as ContractRevertError with `errorName` taken
        // from the protocol's custom-error ABIs; its own docs warn that
        // `errorName` is `undefined` when the revert did not decode - a bare
        // require string, an unknown selector, no data at all. A substring test
        // on `err.message` cannot tell those apart from the routine case, so an
        // undecodable revert (exactly the kind worth seeing) was being logged
        // as a requote and swallowed. Anything that is not this one named
        // revert propagates.
        if (err instanceof ContractRevertError && err.errorName === "PostOnlyWouldCross") {
          log(`     BUY_${leg.outcome} @ ${leg.price.toFixed(3)} would cross - requoting next cycle`);
        } else {
          throw err;
        }
      }
    }
    if (rested) stats.quoted++;
  } catch (err) {
    stats.errors++;
    warn(`${market.symbol}: ${explain(err)}`);
  }
}

async function cycle(
  ctx: EcContext,
  cfg: VaticrConfig,
  api: VaticrClient,
  registry: ForecastRegistry | null,
  budget: NotionalBudget,
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

  // EC_UNDERLYING has to reach the QUERY, not a filter downstream of it.
  // `activeMarkets` slices to `max` before returning, and the venue interleaves
  // its BTC and ETH series - measured on testnet just now, the live list came
  // back ETH, BTC, BTC, ETH, ETH, BTC, … - so filtering after the slice means
  // EC_UNDERLYING=BTC on maxMarkets=1 trades nothing at all, and on 8 quietly
  // trades four markets instead of eight. The kit takes an `asset` option that
  // filters before the slice; the rows carry the bare symbol ("BTC" / "ETH"),
  // which is exactly what config uppercases EC_UNDERLYING into.
  const markets = await activeMarkets(ctx, {
    asset: cfg.underlying || undefined,
    max: cfg.maxMarkets,
  });
  if (markets.length === 0) {
    warn(
      cfg.underlying
        ? `no live ${cfg.underlying} markets in scope - ${await explainEmptyScope(ctx)}`
        : `no live markets in scope - ${await explainEmptyScope(ctx)}`,
    );
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
    const marketId = String((market.info as { marketId?: string }).marketId ?? "");
    const envelope = byId.get(marketId.toLowerCase());
    if (!envelope) {
      log(`  ${market.symbol}: no forecast yet (window just opened) - skipping`);
      stats.skipped++;
      continue;
    }
    try {
      await actOnMarket(ctx, cfg, api, registry, budget, market, envelope);
    } catch (err) {
      stats.errors++;
      warn(`${market.symbol}: ${explain(err)}`);
    }
  }

  // Winnings are claimed, not received: a settled position does not decay into
  // collateral on its own. Driven from the loop (not a timer) so it serialises
  // with this strategy's writes and cannot race its own nonce.
  if (!cfg.dryRun && ctx.canTrade) {
    try {
      // `maybeClaim` is throttled internally (AUTO_CLAIM_INTERVAL_MS) and
      // returns void - it logs its own sweeps.
      await maybeClaim(ctx);
    } catch (err) {
      warn(`claim sweep failed: ${explain(err)}`);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadVaticrConfig();
  const ctx = createExchange({ withSigner: !cfg.dryRun });

  console.log(`
================================================================================
  VATICR - Autonomous DeAI Market Maker for DreamDEX Event Contracts
  Somnia ${ctx.config.network} (chainId ${ctx.config.chainId})
================================================================================
  mode          ${cfg.dryRun ? "DRY_RUN - logging orders, sending nothing" : "LIVE - sending real orders"}
  wallet        ${ctx.exchange.walletAddress ?? "(read-only)"}
  venue         ${ctx.config.venueId ?? "(inferred from live markets)"}
  intelligence  ${cfg.apiUrl}
  underlying    ${cfg.underlying || "all"}
  edge / spread ${cfg.edgeThreshold} / ${cfg.halfSpread}   take buffer ${cfg.takeBuffer}
  quote size    ${cfg.quoteSize} shares   inventory cap ${cfg.maxNetInventory}
  notional cap  ${cfg.maxNotional} collateral committed at once (escrow + fills)
================================================================================
`);

  const api = new VaticrClient(cfg.apiUrl);
  const registry = ForecastRegistry.create(ctx);
  const budget = new NotionalBudget(cfg.maxNotional);
  if (registry) log(`forecast registry: ${process.env.VATICR_REGISTRY}`);
  try {
    const health = await api.health();
    log(
      `intelligence layer: ${health["headlines_in_window"] ?? "?"} headline(s) in window, ` +
        `classifier ${health["llm_classifier"] ?? "?"}, network ${health["network"] ?? "?"}`,
    );
  } catch {
    warn(
      `intelligence layer not reachable at ${cfg.apiUrl} - start it with 'npm run api'. ` +
        `Retrying each cycle.`,
    );
  }
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} - finishing cycle and cancelling resting orders…`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    try {
      await cycle(ctx, cfg, api, registry, budget);
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
    `done - cycles=${stats.cycles} quoted=${stats.quoted} taken=${stats.taken} ` +
      `skipped=${stats.skipped} errors=${stats.errors} ` +
      `notional=${budget.committed.toFixed(2)}/${budget.cap} ` +
      `(filled ${budget.settled.toFixed(2)}, escrowed ${budget.outstanding.toFixed(2)})` +
      (budget.refused ? ` (${budget.refused} write(s) refused by the cap)` : ""),
  );
  await shutdown(ctx);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
