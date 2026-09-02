/**
 * Top of the YES book, per market.
 *
 * The landing page promises the dashboard shows prior, posterior and the book
 * mid side by side, so the mid has to come from somewhere. The Python layer
 * never reads the book — the bot does, through the Bot Kit's on-chain reader,
 * and the bot does not serve HTTP. The indexer does publish resting orders
 * though, so this route derives the top of book from them.
 *
 * It deliberately does NOT hardcode the indexer URL: agents/somnia.py owns
 * which network the project is pointed at, and /health already reports the
 * endpoint it chose. Reading it from there keeps one source of truth, at the
 * cost of one cached round trip.
 */

import { NextResponse } from "next/server";

const API = (process.env.VATICR_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export const dynamic = "force-dynamic";

// The indexer host changes only when the network does, so a long cache is safe
// and keeps this route to a single upstream call in the steady state.
let indexerUrl: { value: string; at: number } | null = null;
const INDEXER_TTL_MS = 5 * 60_000;

async function resolveIndexer(): Promise<string> {
  if (indexerUrl && Date.now() - indexerUrl.at < INDEXER_TTL_MS) return indexerUrl.value;
  const res = await fetch(`${API}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`health ${res.status}`);
  const health = (await res.json()) as { indexer?: string };
  if (!health.indexer) throw new Error("health did not report an indexer endpoint");
  indexerUrl = { value: health.indexer, at: Date.now() };
  return health.indexer;
}

// `quoteDecimals` comes back per market rather than assumed: testnet quotes at
// 6 decimals and mainnet at 18, and the bot kit's own notes are explicit that
// the two venues differ. Dividing by the wrong power gives a mid of 7e-13,
// which would render as a plausible-looking 0.0%.
const BOOK_QUERY = `
query Book($markets: [String!], $now: numeric!) {
  Order(
    where: {
      market_id: {_in: $markets},
      status: {_eq: "Open"},
      quantityRemaining: {_gt: "0"},
      expireTimestampNs: {_gt: $now}
    },
    limit: 500
  ) {
    market_id
    isBid
    price
    market { quoteDecimals }
  }
}`;

interface OrderRow {
  market_id: string;
  isBid: boolean | null;
  price: string | null;
  market: { quoteDecimals: number | null } | null;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("markets") ?? "";
  const markets = raw.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 50);
  if (markets.length === 0) return NextResponse.json({ tops: [] });

  try {
    const endpoint = await resolveIndexer();
    const res = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      // Orders carry a dead-man's-switch expiry in nanoseconds; an order past
      // it still reads as Open until someone cancels it, and quoting a mid off
      // a dead order is worse than showing no mid at all.
      body: JSON.stringify({
        query: BOOK_QUERY,
        variables: { markets, now: Date.now() * 1_000_000 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = (await res.json()) as {
      data?: { Order?: OrderRow[] };
      errors?: unknown[];
    };
    if (payload.errors?.length) {
      throw new Error(`graphql error: ${JSON.stringify(payload.errors[0])}`);
    }

    const best = new Map<string, { bid: number | null; ask: number | null }>();
    for (const id of markets) best.set(id, { bid: null, ask: null });

    for (const row of payload.data?.Order ?? []) {
      const decimals = row.market?.quoteDecimals ?? 6;
      const price = Number(row.price) / 10 ** decimals;
      if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
      const top = best.get(row.market_id);
      if (!top) continue;
      if (row.isBid) top.bid = Math.max(top.bid ?? 0, price);
      else top.ask = Math.min(top.ask ?? 1, price);
    }

    return NextResponse.json({
      tops: markets.map((id) => {
        const t = best.get(id) ?? { bid: null, ask: null };
        return {
          market_id: id,
          best_bid: t.bid,
          best_ask: t.ask,
          // A one-sided book has no mid. Reporting the single side as the mid
          // would overstate what the market actually agrees on.
          mid: t.bid !== null && t.ask !== null ? (t.bid + t.ask) / 2 : null,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "book unavailable",
        detail: (err as Error).message,
        hint: `Needs the intelligence layer for the indexer endpoint — start it with 'npm run api' (expected at ${API}).`,
      },
      { status: 502 },
    );
  }
}
