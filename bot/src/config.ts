/**
 * Vaticr bot configuration.
 *
 * Venue scoping, network selection and the signer come from the Bot Kit's own
 * `loadConfig()` (vendor/ec-core) so this bot speaks exactly the same .env
 * dialect as every in-repo DreamDEX strategy. Everything here is Vaticr's own.
 */

import { envNum, loadEnv } from "@dreamdex-bot-kit/ec-core";

loadEnv();

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw !== "false" && raw !== "0";
};

export interface VaticrConfig {
  /** Base URL of the Python intelligence layer. */
  apiUrl: string;
  /** Milliseconds between strategy cycles. */
  refreshMs: number;
  /** Shares per quote leg. */
  quoteSize: number;
  /** Half-spread, in probability, around the posterior when quoting. */
  halfSpread: number;
  /**
   * Minimum edge over the *touch* before crossing the spread. Taking is how a
   * signal bot bleeds: this must clear the spread, not the mid.
   */
  edgeThreshold: number;
  /** Stop adding to a market once |net position| exceeds this, in shares. */
  maxNetInventory: number;
  /** Markets acted on per cycle. */
  maxMarkets: number;
  /** Only trade this underlying when set (e.g. "BTC"). */
  underlying: string;
  /** Seconds of order life; also the dead-man's switch on a crashed bot. */
  orderTtlSec: number;
  /** Post forecasts to the API for later Brier scoring. */
  commitForecasts: boolean;
  /** Log intended actions instead of sending them. */
  dryRun: boolean;
}

export function loadVaticrConfig(): VaticrConfig {
  return {
    apiUrl: (process.env.VATICR_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
    refreshMs: envNum("VATICR_REFRESH_MS", 10_000),
    quoteSize: envNum("VATICR_QUOTE_SIZE", 5),
    halfSpread: envNum("VATICR_HALF_SPREAD", 0.03),
    edgeThreshold: envNum("VATICR_EDGE_THRESHOLD", 0.05),
    maxNetInventory: envNum("VATICR_MAX_NET_INVENTORY", 25),
    maxMarkets: envNum("VATICR_MAX_MARKETS", 8),
    underlying: (process.env.EC_UNDERLYING ?? "").toUpperCase(),
    orderTtlSec: envNum("VATICR_ORDER_TTL_SEC", 90),
    commitForecasts: bool("VATICR_COMMIT_FORECASTS", true),
    // Mirrors the Bot Kit: dry run unless explicitly disabled.
    dryRun: (process.env.DRY_RUN ?? "true") !== "false" && process.env.DRY_RUN !== "0",
  };
}

export const log = (msg: string): void =>
  console.log(`${new Date().toISOString()} ${msg}`);

export const warn = (msg: string): void =>
  console.warn(`${new Date().toISOString()} WARN ${msg}`);
