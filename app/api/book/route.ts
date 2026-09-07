/**
 * Top of the YES book, per market.
 *
 * The landing page promises the dashboard shows prior, posterior and the book
 * mid side by side, so the mid has to come from somewhere.
 *
 * This route used to derive it from resting `Order` rows in the Envio indexer.
 * That returned `null` for every market on the live venue while the chain
 * demonstrably had books - measured 2026-09-04: this route reported
 * best_bid/best_ask null on all eight live windows at the same moment the
 * on-chain reader saw [0.803/0.828] and [0.813/0.836]. So the dashboard showed
 * "mid -" on every row, on the exact screen whose whole argument is that the
 * model disagrees with the market.
 *
 * It now reads the same source the trade ticket reads: the chain, through the
 * SDK's `getBinaryOrderBook`. One authoritative book means the row badge's edge
 * and the ticket's edge cannot disagree about the same window - which they
 * could when one came from the indexer and the other from the chain.
 */

import { NextResponse } from "next/server";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { Hex } from "viem";
// Deliberately NOT @dreamdex-bot-kit/ec-core: the vendored kit imports its own
// modules with ESM ".js" specifiers that resolve to ".ts" files. tsx handles
// that, webpack does not, and pulling it in here fails the Next build outright.
// The app already owns one description of the chain - reuse it.
import {
  SOMNIA_ADDRESSES, SOMNIA_INDEXER_URL, SOMNIA_WS_RPC, somniaTestnet,
} from "@/app/components/wallet/chain";

export const dynamic = "force-dynamic";

const DEPTH = 1;
/** Books move constantly; this only exists to collapse the burst of identical
 *  requests a single dashboard render produces. */
const CACHE_TTL_MS = 2_000;

interface Top {
  market_id: string;
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
}

let exchange: SomniaMarkets | null = null;
function getExchange(): SomniaMarkets {
  if (exchange) return exchange;
  // No signer: this route only ever reads.
  exchange = new SomniaMarkets({
    indexerUrl: SOMNIA_INDEXER_URL,
    chain: somniaTestnet,
    wsRpcUrl: SOMNIA_WS_RPC,
    addresses: SOMNIA_ADDRESSES,
  });
  return exchange;
}

const cache = new Map<string, { at: number; top: Top }>();
/** The pool a market is bound to changes only when the market does. */
const poolOf = new Map<string, { pool: Hex; decimals: number }>();

async function topFor(marketId: string): Promise<Top> {
  const hit = cache.get(marketId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.top;

  const empty: Top = { market_id: marketId, best_bid: null, best_ask: null, mid: null };
  try {
    const ex = getExchange();
    let bound = poolOf.get(marketId);
    if (!bound) {
      // Settlement-extraction v2: a pool address is a time-varying binding, so
      // resolve it from the marketId rather than caching a pool forever.
      const onchain = await ex.client.getMarketOnchain(marketId as Hex);
      if (!onchain) return empty;
      bound = { pool: onchain.pool as Hex, decimals: onchain.decimals };
      poolOf.set(marketId, bound);
    }
    const book = await ex.client.getBinaryOrderBook(bound.pool, {
      depth: DEPTH,
      decimals: bound.decimals,
    });
    // Prices come back RAW (bigint, scaled by the market's own decimals - 6 on
    // testnet tUSDC, 18 on the mainnet USDso venue). Dividing by the wrong power
    // yields a mid of ~7e-13, which renders as a plausible-looking 0.0% rather
    // than an obvious error, so the scale is taken from the market, not assumed.
    const one = 10 ** bound.decimals;
    const rawBid = book.yesBids[0]?.price;
    const rawAsk = book.yesAsks[0]?.price;
    const bid = rawBid === undefined ? null : Number(rawBid) / one;
    const ask = rawAsk === undefined ? null : Number(rawAsk) / one;
    const top: Top = {
      market_id: marketId,
      best_bid: bid,
      best_ask: ask,
      mid: bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask),
    };
    cache.set(marketId, { at: Date.now(), top });
    return top;
  } catch {
    // A book that cannot be read is reported as absent, never as a price. The
    // dashboard renders an em dash for null, which is the honest answer.
    poolOf.delete(marketId);
    return empty;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("markets") ?? "";
  const markets = raw.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 50);
  if (markets.length === 0) return NextResponse.json({ tops: [] });

  const tops = await Promise.all(markets.map((m) => topFor(m)));
  return NextResponse.json(
    { tops },
    { headers: { "Cache-Control": "no-store" } },
  );
}
