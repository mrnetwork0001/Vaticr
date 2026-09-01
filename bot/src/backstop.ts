/**
 * Settlement backstop — the write half of the resolution agent.
 *
 *   npm run backstop            # report only
 *   DRY_RUN=false npm run backstop
 *
 * DreamDEX event contracts settle themselves: the question is scheduled on the
 * OracleHub at market creation with its resolution gas reserved up front, and
 * Somnia's reactivity delivers the answer to the hub's callback at expiry. No
 * keeper is required, and this script is not one.
 *
 * It exists for the two cases where the callback does not land, both of which
 * the protocol makes permissionless on purpose:
 *
 *   pokeOracle(oracleQuestionId)  pulls an answer that WAS posted but whose
 *                                 callback was missed, and resolves the market.
 *   voidExpired(marketId)         once the settlement window lapses with no
 *                                 answer at all, voids the market so both sides
 *                                 redeem at 0.5 rather than stranding funds.
 *
 * Which markets need which is decided by `agents/resolver.py`, which watches
 * the indexer; this script holds the signer and makes the call.
 */

import { createExchange, shutdown, assertTxOk } from "@dreamdex-bot-kit/ec-core";
import { loadVaticrConfig, log, warn } from "./config.js";

interface Backstop {
  market_id: string;
  symbol: string;
  expiry: number;
  overdue_sec: number;
  oracle_question_id: string | null;
  suggested_call: "pokeOracle" | "voidExpired";
  receipt_url: string | null;
}

async function main(): Promise<void> {
  const cfg = loadVaticrConfig();
  const ctx = createExchange({ withSigner: !cfg.dryRun });

  const params = new URLSearchParams();
  if (ctx.config.venueId) params.set("venue", ctx.config.venueId);

  let stuck: Backstop[] = [];
  try {
    const res = await fetch(`${cfg.apiUrl}/backstops?${params.toString()}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    stuck = ((await res.json()) as { markets: Backstop[] }).markets;
  } catch (err) {
    warn(`could not reach the resolver at ${cfg.apiUrl}: ${(err as Error).message}`);
    await shutdown(ctx);
    process.exit(1);
  }

  if (stuck.length === 0) {
    log("no stuck markets — every expired window settled inside its grace period");
    await shutdown(ctx);
    process.exit(0);
  }

  log(`${stuck.length} market(s) past their settlement window:`);
  for (const m of stuck) {
    log(`  ${m.symbol} overdue ${m.overdue_sec}s -> ${m.suggested_call}()`);
    if (m.receipt_url) log(`     receipt ${m.receipt_url}`);

    if (cfg.dryRun) {
      log(`     DRY_RUN would call ${m.suggested_call}()`);
      continue;
    }

    try {
      if (m.suggested_call === "pokeOracle") {
        if (!m.oracle_question_id) {
          warn("     no oracleQuestionId on this row — cannot poke");
          continue;
        }
        // Note: pokeOracle takes the ORACLE QUESTION id, not the market id —
        // the module fans out to every market bound to that question.
        const res = await ctx.exchange.trader.pokeOracle({
          oracleQuestionId: BigInt(m.oracle_question_id),
        });
        assertTxOk(res, `pokeOracle(${m.oracle_question_id})`);
        log(`     poked — tx ${res.hash}`);
      } else {
        const res = await ctx.exchange.trader.voidExpired({
          marketId: m.market_id as `0x${string}`,
        });
        assertTxOk(res, `voidExpired(${m.market_id})`);
        log(`     voided — tx ${res.hash}; both sides now redeem at 0.5`);
      }
    } catch (err) {
      // Losing the race to the oracle's own callback is the expected outcome
      // here, not a failure — the market resolved, which is the point.
      warn(`     ${m.suggested_call} failed: ${(err as Error).message}`);
    }
  }

  await shutdown(ctx);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
