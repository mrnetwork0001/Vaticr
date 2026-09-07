/**
 * The on-chain half of `npm run go-live -- --send`.
 *
 * Produces the evidence a "working prototype on testnet" needs, in one pass:
 *   1. mint tUSDC from the public testnet faucet
 *   2. publish one real forecast to VaticrForecastRegistry, BEFORE its window closes
 *   3. place ONE small real order on a live event contract
 *
 * Deliberately conservative: one order, minimum size, post-only so it rests
 * rather than crossing, and gated on the authoritative on-chain status. The
 * point is a verifiable footprint on the explorer, not a trading session.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  activeMarkets, createExchange, isTradable, marketOnchain, minLeftSec,
  outcomeSymbols, placeLimit, quantize, shutdown, assertTxOk,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createWalletClient, createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeChain } from "@dreamdex-bot-kit/ec-core";

const EXPLORER = "https://shannon-explorer.somnia.network";
const ok = (m: string) => console.log(`\x1b[32m  ✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`\x1b[31m  ✗\x1b[0m ${m}`);
const tx = (h?: string) => (h ? `${EXPLORER}/tx/${h}` : "-");

const REGISTRY_ABI = [
  {
    type: "function", name: "commit", stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" }, { name: "probabilityBps", type: "uint16" },
      { name: "priorBps", type: "uint16" }, { name: "expiry", type: "uint64" },
      { name: "evidenceHash", type: "bytes32" },
    ], outputs: [],
  },
] as const;

interface Proof {
  faucet?: { hash?: string; explorer: string };
  forecast?: { marketId: string; posteriorBps: number; priorBps: number; hash?: string; explorer: string };
  order?: { symbol: string; outcome: string; price: number; size: number; rested: boolean; hash?: string; explorer: string };
  errors: string[];
}

async function main(): Promise<void> {
  const proof: Proof = { errors: [] };
  if (!(process.env.PRIVATE_KEY ?? "").trim()) {
    bad("No PRIVATE_KEY. This script signs real testnet transactions and cannot run without one.");
    console.log("   Run 'npm run go-live' for the guided setup, which explains how to fund a key.\n");
    process.exit(1);
  }
  const ctx = createExchange({ withSigner: true });
  const me = ctx.exchange.walletAddress!;
  console.log(`   wallet ${me}\n`);

  // --- 1. faucet -----------------------------------------------------------
  console.log("   [1/3] tUSDC faucet");
  const collateral = ctx.config.addresses.collateral!;
  const one = 10n ** BigInt(ctx.config.decimals);
  try {
    const before = await ctx.exchange.client.getErc20Balance(collateral, me);
    if (before < 1_000n * one) {
      const res = await ctx.exchange.trader.faucet();
      assertTxOk(res, "faucet()");
      proof.faucet = { hash: res.hash, explorer: tx(res.hash) };
      ok(`minted tUSDC - ${tx(res.hash)}`);
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      ok(`already funded (${Number(before) / Number(one)} tUSDC)`);
    }
  } catch (e) {
    bad(`faucet: ${(e as Error).message}`);
    proof.errors.push(`faucet: ${(e as Error).message}`);
  }

  // --- pick a live market we can act on ------------------------------------
  const markets = await activeMarkets(ctx, { max: 12 });
  let target = null as null | { market: (typeof markets)[number]; onchain: Awaited<ReturnType<typeof marketOnchain>> };
  for (const m of markets) {
    const onchain = await marketOnchain(ctx, m);
    if (!onchain || !isTradable(onchain)) continue;
    const interval = isBinaryMarket(m.info) ? Number(m.info.intervalSec ?? 0) : 0;
    const left = Number(onchain.expiry) - Date.now() / 1000;
    // Needs enough runway that the window cannot lock between here and the send.
    if (left < Math.max(minLeftSec(interval || null), 120)) continue;
    target = { market: m, onchain };
    break;
  }
  if (!target) {
    bad("no live market with enough runway right now - re-run in a minute");
    writeProof(proof);
    await shutdown(ctx);
    process.exit(1);
  }
  const { market, onchain } = target;
  const marketId = String((market.info as { marketId?: string }).marketId ?? "");
  console.log(`\n   target ${market.symbol}`);

  // --- ask the brain what it thinks ----------------------------------------
  const api = (process.env.VATICR_API_URL ?? "http://127.0.0.1:8799").replace(/\/$/, "");
  let posterior = 0.5, prior = 0.5, evidenceIds: string[] = [];
  try {
    const params = new URLSearchParams({ limit: "24" });
    if (ctx.config.venueId) params.set("venue", ctx.config.venueId);
    const rows = (await (await fetch(`${api}/forecasts?${params}`)).json()) as any[];
    const hit = rows.find((r) => (r.forecast.market_id ?? "").toLowerCase() === marketId.toLowerCase());
    if (hit) {
      posterior = hit.forecast.posterior;
      prior = hit.forecast.prior;
      evidenceIds = hit.forecast.evidence.map((e: any) => e.headline_id);
      ok(`Vaticr posterior ${posterior.toFixed(4)} (prior ${prior.toFixed(4)})`);
    } else {
      bad("no live forecast for this market - using 0.5, the forecast commit is then meaningless");
    }
  } catch (e) {
    bad(`intelligence layer unreachable (${api}) - start it with 'npm run api'`);
    proof.errors.push(`api: ${(e as Error).message}`);
  }

  // --- 2. on-chain forecast commitment -------------------------------------
  console.log("\n   [2/3] Publish the forecast on-chain");
  const dep = "deployments/50312.json";
  const registry = existsSync(dep) ? JSON.parse(readFileSync(dep, "utf8")).forecastRegistry : null;
  if (!registry) {
    bad("no registry address in deployments/50312.json - deploy it first");
  } else {
    try {
      const chain = makeChain(ctx.config);
      const account = privateKeyToAccount(ctx.config.privateKey!);
      const wallet = createWalletClient({ account, chain, transport: http(ctx.config.rpcUrl) });
      const pubc = createPublicClient({ chain, transport: http(ctx.config.rpcUrl) });
      const bps = (p: number) => Math.max(1, Math.min(9999, Math.round(p * 10_000)));
      const evidenceHash = evidenceIds.length
        ? keccak256(toHex([...evidenceIds].sort().join(",")))
        : ("0x" + "00".repeat(32)) as Hex;

      const hash = await wallet.writeContract({
        address: registry as Hex, abi: REGISTRY_ABI, functionName: "commit",
        args: [marketId as Hex, bps(posterior), bps(prior), BigInt(onchain!.expiry), evidenceHash],
        chain, account,
      });
      const rec = await pubc.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (rec.status !== "success") throw new Error("commit reverted");
      proof.forecast = {
        marketId, posteriorBps: bps(posterior), priorBps: bps(prior),
        hash, explorer: tx(hash),
      };
      ok(`forecast committed before settlement - ${tx(hash)}`);
    } catch (e) {
      bad(`registry commit: ${(e as Error).message}`);
      proof.errors.push(`commit: ${(e as Error).message}`);
    }
  }

  // --- 3. one real order ---------------------------------------------------
  console.log("\n   [3/3] Place one small real order");
  try {
    const { yes } = outcomeSymbols(market);
    const ob = await ctx.exchange.fetchOrderBook(yes, 3);
    const bestBid = ob.bids[0]?.[0];
    const bestAsk = ob.asks[0]?.[0];

    // Rest strictly inside the touch so post-only cannot cross, and stay below
    // the posterior so the order is one we would actually want filled.
    const target = Math.min(posterior - 0.02, bestAsk !== undefined ? bestAsk - 0.01 : 0.5);
    const price = Math.max(0.02, Math.min(0.98, Number(target.toFixed(4))));
    const size = quantize(ctx, Number(process.env.GO_LIVE_SIZE ?? 1));
    if (size <= 0) throw new Error("size rounds below one lot");

    console.log(`   book [${bestBid?.toFixed(3) ?? "-"}/${bestAsk?.toFixed(3) ?? "-"}]  posterior ${posterior.toFixed(3)}`);
    console.log(`   -> BUY_YES ${size} @ ${price} (post-only, rests)`);

    const fresh = await marketOnchain(ctx, market);
    if (!fresh || !isTradable(fresh)) throw new Error("market left Trading before the send");

    const res = await placeLimit(ctx, {
      market, onchain: fresh, outcome: "YES", side: "buy",
      price, size, type: "post-only", expiresInSec: 120,
    });
    proof.order = {
      symbol: market.symbol, outcome: "YES", price: res.price, size: res.size,
      rested: res.rested, hash: res.hash, explorer: tx(res.hash),
    };
    ok(`order ${res.rested ? `resting id=${res.orderId}` : `filled=${res.filled}`} - ${tx(res.hash)}`);
  } catch (e) {
    bad(`order: ${(e as Error).message}`);
    proof.errors.push(`order: ${(e as Error).message}`);
  }

  writeProof(proof);
  await shutdown(ctx);
  process.exit(proof.errors.length ? 1 : 0);
}

function writeProof(proof: Proof): void {
  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/onchain-proof.json", JSON.stringify(proof, null, 2) + "\n");
  console.log(`\n   wrote deployments/onchain-proof.json`);
}

main().catch((e) => {
  // A stack trace is the wrong answer for an operator running a deploy script.
  bad((e as Error).message ?? String(e));
  process.exit(1);
});
