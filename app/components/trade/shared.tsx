"use client";

/**
 * The vocabulary the three trading surfaces share.
 *
 * Two things live here rather than in any one panel:
 *
 *  1. **The on-chain market status.** Only `Trading` accepts orders, and the
 *     indexer lags the chain by seconds - so every write re-reads the status
 *     from chain immediately before signing. The names and the explanations of
 *     each state belong next to each other so the UI can never say "Locked"
 *     without also saying what Locked means for the user's money.
 *
 *  2. **Revert translation.** A protocol revert arrives as a Solidity error
 *     name. Some of them are routine (`PostOnlyWouldCross` just means the touch
 *     moved), some are the user's balance, some are real bugs. The rule here is
 *     that we explain the name, we never *replace* it: the raw reason is always
 *     rendered too, because a page that signs transactions must not editorialise
 *     a failure the user may need to quote to someone.
 */

import type { ReactNode } from "react";
import { formatUnits } from "viem";
import { ContractRevertError, SomniaMarketsError } from "@somnia-chain/markets-sdk";
import { explorerTx } from "../wallet";

/* ------------------------------------------------------------------ status */

/** On-chain `MarketStatus` enum. Only `Trading` accepts orders. */
export const MARKET_STATUS = {
  Listed: 0,
  Trading: 1,
  Locked: 2,
  Settling: 3,
  Resolved: 4,
  Voided: 5,
} as const;

const STATUS_NAMES = ["Listed", "Trading", "Locked", "Settling", "Resolved", "Voided"];

export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `unknown (${status})`;
}

/** What a non-Trading status means for someone holding a ticket open. */
export function statusExplanation(status: number): string {
  switch (status) {
    case MARKET_STATUS.Listed:
      return "This window exists but has not opened yet. It accepts no orders until trading starts.";
    case MARKET_STATUS.Trading:
      return "Open for orders.";
    case MARKET_STATUS.Locked:
      return "Trading has closed for this window and the outcome is being decided. No orders are accepted; nothing is lost - positions settle from here.";
    case MARKET_STATUS.Settling:
      return "The oracle is resolving this window. No orders are accepted. Your position becomes claimable once it resolves.";
    case MARKET_STATUS.Resolved:
      return "This window has settled. Winnings are not paid automatically - claim them below.";
    case MARKET_STATUS.Voided:
      return "This window was voided. Both YES and NO redeem at 0.5 - claim below. A void is not a loss.";
    default:
      return "This market is not accepting orders.";
  }
}

/* ------------------------------------------------------------------ errors */

export interface Explained {
  /** One line naming what happened, in the user's terms. */
  headline: string;
  /** What it means and what to do next. */
  detail: string;
  /**
   * True for outcomes that are a normal part of trading rather than a fault -
   * a post-only that would have crossed, a user-dismissed wallet prompt. These
   * render amber rather than red, because scaring someone with a red banner
   * over an ordinary requote teaches them to ignore red banners.
   */
  routine: boolean;
  /** The verbatim message / Solidity error name. Always shown. */
  raw: string;
}

/**
 * Turn anything thrown by a write path into something a person can act on,
 * WITHOUT hiding what the chain actually said.
 */
export function explainError(err: unknown): Explained {
  const raw =
    err instanceof ContractRevertError
      ? [err.errorName, err.reason, err.message].filter(Boolean).join(" · ")
      : err instanceof Error
        ? err.message
        : String(err);

  if (err instanceof ContractRevertError) {
    switch (err.errorName) {
      case "PostOnlyWouldCross":
        return {
          headline: "Your quote would have crossed the book",
          detail:
            "A post-only order is only allowed to rest. Between the preview and the send, the other side moved through your price, so resting it would have taken liquidity instead - the pool refused rather than fill you at a price you did not choose. Nothing was placed. Move your price away from the touch, or switch to IOC to cross on purpose.",
          routine: true,
          raw,
        };
      case "ImmediateOrCancelNoFill":
        return {
          headline: "An IOC found nothing to take at your price",
          detail:
            "An IOC buy only takes offers at or BELOW your limit. Nothing was resting there, so the pool cancelled the whole order rather than resting it - that is what IOC means. No shares were bought and no collateral was escrowed; the gas for the reverted transaction is the only cost. Raise the limit to the best offer to cross, or switch to post-only and rest at your price.",
          routine: true,
          raw,
        };
      case "FillOrKillNotFilled":
        return {
          headline: "A fill-or-kill could not be filled in full",
          detail:
            "There was not enough resting size at or better than your price to fill the whole order, so none of it was placed.",
          routine: true,
          raw,
        };
      case "OrderExpiryBeyondMarket":
        return {
          headline: "The order would have outlived its market",
          detail:
            "A binary order must expire no later than the window itself. Reopen the ticket so it can re-read the window's expiry.",
          routine: false,
          raw,
        };
      case "OrderAlreadyExpired":
        return {
          headline: "The order's expiry was already in the past",
          detail:
            "The window closed between building this order and sending it. Nothing was placed.",
          routine: true,
          raw,
        };
      case "TradingNotActive":
      case "WrongStatus":
        return {
          headline: "The window stopped accepting orders",
          detail:
            "It moved out of Trading between the on-chain check and the send - windows are short. Nothing was placed.",
          routine: true,
          raw,
        };
      case "InvalidPrice":
      case "PriceNotAlignedToTickSize":
        return {
          headline: "Price is off the venue's tick grid",
          detail:
            "The pool only accepts prices that are an exact multiple of its tick. This is a bug in the ticket rather than something you did - please report the price you typed.",
          routine: false,
          raw,
        };
      case "InvalidQuantity":
      case "QuantityNotAlignedToLotSize":
        return {
          headline: "Size is off the venue's lot grid",
          detail: "The pool only accepts sizes that are an exact multiple of its lot.",
          routine: false,
          raw,
        };
      case "QuantityBelowMinimum":
        return {
          headline: "Size is below this pool's minimum order",
          detail: "Increase the number of shares and try again.",
          routine: false,
          raw,
        };
      case "ERC20InsufficientBalance":
      case "ERC20InsufficientAllowance":
      case "InsufficientBalance":
      case "InsufficientCollateral":
        return {
          headline: "Not enough collateral to back this order",
          detail:
            "A buy escrows price × size in tUSDC the moment it is placed. Top the wallet up, or reduce the size.",
          routine: false,
          raw,
        };
      case "SelfMatchCancelTaker":
        return {
          headline: "That order would have matched your own resting order",
          detail:
            "The venue blocks self-matching. Cancel your resting order on the other side first, or move your price.",
          routine: true,
          raw,
        };
      case "ExpiredOrderMustBeCancelled":
        return {
          headline: "An expired order is blocking the book",
          detail:
            "A stale resting order at this level has to be swept before a new one can be placed here. Try a different price.",
          routine: true,
          raw,
        };
      case "MarketNotSettled":
      case "MarketNotFinalizedYet":
        return {
          headline: "This market has not settled yet",
          detail: "There is nothing to claim until the oracle resolves the window.",
          routine: false,
          raw,
        };
      default:
        return {
          headline: err.errorName
            ? `The contract rejected this: ${err.errorName}`
            : "The contract rejected this transaction",
          detail:
            "The chain refused the call. The Solidity reason is printed below verbatim - nothing was interpreted away.",
          routine: false,
          raw,
        };
    }
  }

  if (err instanceof SomniaMarketsError) {
    return {
      headline: "The SDK refused this before it reached the chain",
      detail: "Nothing was signed and nothing was sent.",
      routine: false,
      raw,
    };
  }

  const lower = raw.toLowerCase();
  if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("4001")) {
    return {
      headline: "You dismissed the wallet prompt",
      detail: "Nothing was signed and nothing was sent.",
      routine: true,
      raw,
    };
  }

  return {
    headline: "The transaction did not go through",
    detail: "The underlying error is printed below verbatim.",
    routine: false,
    raw,
  };
}

/* ------------------------------------------------------------------ format */

/** Raw token units to a display number. Exact through the string, never `Number(bigint)`. */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/** A probability as a percentage with one decimal - the site's existing idiom. */
export function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** A probability as a price, the way a book quotes it. */
export function price(p: number): string {
  return p.toFixed(3);
}

/** A signed number, so a reader never has to infer direction from colour alone. */
export function signedFixed(n: number, places = 3): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(places)}`;
}

/** Collateral, to cents. */
export function money(raw: bigint, decimals: number, symbol = "tUSDC"): string {
  return `${rawToNumber(raw, decimals).toFixed(4)} ${symbol}`;
}

/* ------------------------------------------------------------------ pieces */

/** A signed transaction, linked to its receipt. Never a bare hash. */
export function TxLink({ hash, label = "receipt" }: { hash: string; label?: string }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="mono text-accent hover:underline"
    >
      {hash.slice(0, 10)}…{hash.slice(-8)}
      <span className="sr-only"> - {label} on the Shannon explorer, opens in a new tab</span>
    </a>
  );
}

/** One line of a review sheet: what it is, and exactly what will be signed. */
export function ReviewRow({
  label, value, tone = "neutral", note,
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn";
  note?: string;
}) {
  const tones = {
    neutral: "text-slate-100",
    up: "text-up",
    down: "text-down",
    warn: "text-amber-300",
  } as const;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div>
        <span className="text-[12px] text-slate-400">{label}</span>
        {note && <span className="mt-0.5 block text-[10.5px] leading-snug text-slate-500">{note}</span>}
      </div>
      <span className={`mono text-[13px] font-semibold ${tones[tone]}`}>{value}</span>
    </div>
  );
}

/**
 * The error surface every write path shares. Routine outcomes are amber and
 * calm; real failures are red. Both print the raw reason.
 */
export function WriteError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const e = explainError(error);
  const shell = e.routine
    ? "border-amber-400/30 bg-amber-400/[0.07]"
    : "border-down/30 bg-down/[0.07]";
  const head = e.routine ? "text-amber-300" : "text-down";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${shell}`} role="status" aria-live="polite">
      <p className={`text-[12.5px] font-semibold ${head}`}>{e.headline}</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-300">{e.detail}</p>
      <p className="mono mt-1.5 break-words text-[10.5px] leading-relaxed text-slate-500">{e.raw}</p>
    </div>
  );
}

/** A short explanatory line under a control, in the site's muted register. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{children}</p>;
}

/**
 * Collateral printed to the LAST DIGIT THE TOKEN CAN HOLD.
 *
 * `money` above rounds to four places, which is the right call for a balance
 * read but the wrong one for a number that is about to be signed: at six
 * decimals it can differ from the amount the pool actually escrows in the fifth
 * and sixth place. Anywhere the figure IS the transaction - total cost, max
 * loss, the amount on the confirm button - use this one, so what is printed and
 * what is escrowed are the same number.
 */
export function moneyExact(raw: bigint, decimals: number, symbol = "tUSDC"): string {
  const s = formatUnits(raw, decimals);
  const [whole, frac = ""] = s.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const padded = trimmed.length >= 2 ? trimmed : `${trimmed}${"0".repeat(2 - trimmed.length)}`;
  return `${whole}.${padded} ${symbol}`;
}

/** A basis-point rate as a percentage, e.g. `25` -> `"0.25%"`. */
export function bpsPct(bps: number): string {
  const p = bps / 100;
  return `${Number.isInteger(p) ? p.toString() : p.toFixed(2)}%`;
}

/**
 * Scroll to a section of the dashboard by DOM id, smoothly where the viewer has
 * not asked for reduced motion.
 *
 * This exists because the panels a trader needs AFTER a fill - Positions, and
 * the Claim panel that settled winnings sit in until someone asks for them -
 * live below the fold. A receipt that names them without going there is a
 * receipt that ends the journey in the wrong place.
 *
 * Returns false when the target is not on the page, so a caller can fall back
 * to ordinary anchor navigation rather than swallowing the click.
 */
export function scrollToId(id: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.getElementById(id);
  if (!el) return false;

  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  try {
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  } catch {
    // Older engines only accept the boolean form.
    el.scrollIntoView(true);
  }

  // Land keyboard focus there too, without a second competing scroll.
  if (el.tabIndex < 0) el.tabIndex = -1;
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* focus is a courtesy, never a requirement */
  }
  return true;
}

/**
 * A link to another section of the dashboard. A real `href` first - so it works
 * with middle-click, with keyboard, and if the JS handler ever throws - with the
 * smooth scroll layered on top only when the target actually exists.
 */
export function JumpLink({
  to, children, emphasis = false,
}: {
  to: string;
  children: ReactNode;
  /** Render as a bordered chip rather than an inline link. */
  emphasis?: boolean;
}) {
  const className = emphasis
    ? "inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11.5px] font-semibold text-accent transition hover:bg-accent/20"
    : "text-accent underline underline-offset-2 hover:text-white";
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (scrollToId(to)) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

/**
 * A pre-flight notice: something the page already knows that would otherwise be
 * learned by paying gas for a revert. Amber, never red - nothing has failed
 * yet - and never a block: it states the problem, offers the two real fixes,
 * and leaves the decision where it belongs.
 */
export function Notice({
  title, tone = "warn", children, actions,
}: {
  title: string;
  tone?: "warn" | "info";
  children: ReactNode;
  actions?: ReactNode;
}) {
  const shell =
    tone === "warn"
      ? "border-amber-400/30 bg-amber-400/[0.07]"
      : "border-white/10 bg-white/[0.03]";
  const head = tone === "warn" ? "text-amber-300" : "text-slate-200";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${shell}`} role="status" aria-live="polite">
      <p className={`text-[12.5px] font-semibold ${head}`}>{title}</p>
      <div className="mt-1 text-[11.5px] leading-relaxed text-slate-300">{children}</div>
      {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A button offered by a `Notice` - the user's fix, applied only if they click it. */
export function NoticeAction({
  onClick, children, primary = false,
}: {
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition ${
        primary
          ? "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
          : "border-white/15 text-slate-300 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * A gas limit taken from the chain rather than from a guess, with headroom.
 *
 * Estimation runs against current state, so it prices a WARM storage slot when
 * the real transaction may touch a cold one. The buffer covers that gap. If the
 * node cannot estimate at all - a common outcome when a call would revert for a
 * reason the caller is about to handle anyway - fall back rather than block.
 */
export async function estimateWithBuffer(
  estimate: () => Promise<bigint>,
  fallback: bigint,
  bufferPct = 60n,
): Promise<bigint> {
  try {
    const raw = await estimate();
    const padded = (raw * (100n + bufferPct)) / 100n;
    return padded > fallback ? padded : fallback;
  } catch {
    return fallback;
  }
}
