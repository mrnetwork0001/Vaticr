/**
 * Number and address formatting for the wallet surfaces.
 *
 * The rule this file exists to enforce: a shortened balance must never read as
 * larger than the balance actually is, and a non-zero balance must never render
 * as "0". Both are cheap to get wrong with `toFixed`, and both are the kind of
 * wrong that makes a user sign an order they cannot afford.
 */

import { formatUnits, parseUnits } from "viem";

/** `0x1234…abcd` - enough to compare against a wallet's own display. */
export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** The exact value, trailing zeros trimmed. Never rounded - this is the truth. */
export function exactAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export interface ShortAmount {
  /** What to render. */
  text: string;
  /** True when digits were dropped, so the caller can show the exact value too. */
  truncated: boolean;
}

/**
 * A short rendering that rounds **down**, so it can only understate a balance.
 *
 * A non-zero amount smaller than the last displayed place renders as
 * `< 0.0001` rather than `0.0000`, because "0" would be a different claim.
 */
export function shortAmount(raw: bigint, decimals: number, places = 4): ShortAmount {
  if (raw === 0n) return { text: "0", truncated: false };

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;

  // Round toward zero at `places` by integer division - no float anywhere.
  const drop = decimals > places ? decimals - places : 0;
  const scale = 10n ** BigInt(drop);
  const kept = abs / scale;
  const truncated = kept * scale !== abs;

  if (kept === 0n) {
    const epsilon = places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`;
    return { text: `${negative ? "> -" : "< "}${epsilon}`, truncated: true };
  }

  const shown = exactAmount(kept, Math.min(decimals, places));
  return { text: `${negative ? "-" : ""}${shown}`, truncated };
}

/**
 * Human decimal string -> raw token units, exactly.
 *
 * Wraps `parseUnits` so nothing in the app is tempted to reach for
 * `Number(x) * 10 ** decimals`, which silently loses precision above 2^53 and
 * is how an 18-decimal venue ends up with an off-grid amount.
 */
export function toRaw(human: string, decimals: number): bigint {
  return parseUnits(human.trim() === "" ? "0" : human.trim(), decimals);
}

/**
 * Snap a probability-style price onto the venue's tick grid, as an exact
 * decimal string with `decimals` places.
 *
 * The gotcha this exists for: `(0.05).toFixed(18)` is `"0.050000000000000003"`
 * on a binary64 float, which is off the tick grid and the pool rejects it with
 * `InvalidPrice`. Testnet's 6 places happen to be clean, but the same code runs
 * on an 18-decimal venue, so the conversion is done in integer arithmetic and
 * the float never reaches the SDK.
 *
 * `tick` is in RAW units (e.g. 1000n at 6dp = 0.001). Rounds toward zero.
 */
export function quantizePrice(price: number, decimals: number, tick: bigint = 1n): string {
  if (!Number.isFinite(price)) throw new Error(`quantizePrice: ${price} is not a finite number`);
  const clamped = Math.min(Math.max(price, 0), 1);

  // A binary64 carries ~15-17 significant decimal digits. Fixing at 15 places
  // discards the representation error BEFORE it can land on a grid boundary,
  // then the exact integer is scaled the rest of the way. `parseUnits` on the
  // full 18 would have carried the artifact straight through.
  const safe = Math.min(decimals, 15);
  const scaled = parseUnits(clamped.toFixed(safe), safe) * 10n ** BigInt(decimals - safe);

  const step = tick > 0n ? tick : 1n;
  return formatUnits((scaled / step) * step, decimals);
}
