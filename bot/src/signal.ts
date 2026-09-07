/**
 * Client for the Vaticr intelligence layer (`agents/server.py`).
 *
 * The bot never computes a probability itself - it asks. Keeping the model on
 * one side of a documented HTTP boundary means the forecasting logic is
 * testable in isolation and the trading loop stays about execution.
 */

import { warn } from "./config.js";

export interface EvidenceItem {
  headline_id: string;
  title: string;
  source: string;
  age_sec: number;
  log_likelihood_ratio: number;
  decay: number;
}

export interface Forecast {
  asset: string;
  market_id: string | null;
  symbol: string | null;
  open_price: number;
  spot: number;
  seconds_left: number;
  window_sec: number;
  annual_vol: number;
  vol_source: "realized" | "fallback";
  prior: number;
  posterior: number;
  evidence_log_odds: number;
  evidence: EvidenceItem[];
  computed_at: number;
  degraded: boolean;
  note: string;
}

export interface ForecastEnvelope {
  forecast: Forecast;
  expiry: number;
  trading_start: number;
  interval_sec: number;
  status: string;
  oracle_question_id: string | null;
  receipt_url: string | null;
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class VaticrClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<Record<string, unknown>> {
    return getJson(`${this.baseUrl}/health`);
  }

  /** Posteriors for every live window on the venue. */
  async forecasts(venueId?: string, underlying?: string): Promise<ForecastEnvelope[]> {
    const params = new URLSearchParams();
    if (venueId) params.set("venue", venueId);
    if (underlying) params.set("asset", underlying);
    params.set("limit", "24");
    return getJson(`${this.baseUrl}/forecasts?${params.toString()}`, 45_000);
  }

  /**
   * Record a forecast before its window closes so the resolver can score it.
   *
   * Best-effort: a bot that cannot reach the recorder should keep trading, not
   * stop. The commitment is for auditability, not for execution.
   */
  async commit(env: ForecastEnvelope): Promise<boolean> {
    const f = env.forecast;
    if (!f.market_id) return false;
    try {
      const res = await fetch(`${this.baseUrl}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market_id: f.market_id,
          symbol: f.symbol ?? "",
          asset: f.asset,
          posterior: f.posterior,
          prior: f.prior,
          expiry: env.expiry,
          headline_ids: f.evidence.map((e) => e.headline_id),
        }),
      });
      if (!res.ok) return false;
      return Boolean(((await res.json()) as { recorded?: boolean }).recorded);
    } catch (err) {
      warn(`commit failed (continuing): ${(err as Error).message}`);
      return false;
    }
  }
}
