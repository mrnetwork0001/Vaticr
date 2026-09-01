/**
 * Server-side proxy to the Python intelligence layer.
 *
 * Keeps the API URL (and any future key) server-side, and lets the browser talk
 * to one origin. Every response is uncached: this is live market data.
 */

import { NextResponse } from "next/server";

const API = (process.env.VATICR_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { path: string[] } },
) {
  const search = new URL(request.url).search;
  const target = `${API}/${params.path.join("/")}${search}`;

  try {
    const res = await fetch(target, {
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "intelligence layer unreachable",
        detail: (err as Error).message,
        hint: `Start it with 'npm run api' (expected at ${API}).`,
      },
      { status: 502 },
    );
  }
}
