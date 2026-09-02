"use client";

/**
 * Winnings are CLAIMED, not received.
 *
 * This is the protocol's sharpest edge for a human user, and it is not a bug —
 * it is how settlement is built. A market that resolves in your favour does not
 * push collateral back to you and your outcome tokens do not decay into money.
 * They sit there. Trade a rolling 15-minute series for an afternoon and your
 * balance ends up spread across two dozen finalised windows while the wallet
 * reads near zero, which looks exactly like having lost.
 *
 * So this panel does the one thing nothing else on the page does: it scans the
 * settled markets the connected account still holds tokens in, prices them, adds
 * them up, and lets them be swept — in one transaction if the user wants.
 *
 * The case worth being careful about is a VOID. A voided window has no winner:
 * BOTH sides redeem at 0.5. That is a refund, not a loss, and rendering it in
 * the same red as a losing position would tell the user something untrue about
 * their own money. Void rows are amber and say so in words.
 */

import { useMemo, useState } from "react";
import type { Hex } from "viem";
import type { ClaimablePosition } from "@somnia-chain/markets-sdk";
import { useIndexerQuery, usePortfolio } from "@somnia-chain/markets-sdk/react";
import { Card, PanelState, Pill } from "../ui";
import { COLLATERAL_SYMBOL, useBalances, useVaticrExchange } from "../wallet";
import { ReviewRow, TxLink, WriteError, rawToNumber } from "./shared";

interface Row extends ClaimablePosition {
  decimals: number;
  asset: string;
  interval: string | null;
  voided: boolean;
  /** Payout in human collateral units. */
  payout: number;
  shares: number;
}

export default function ClaimPanel({ onClaimed }: { onClaimed?: () => void }) {
  const { exchange, address, chainOk, canTrade } = useVaticrExchange();
  const balances = useBalances(chainOk ? address : undefined);
  const portfolio = usePortfolio(address);

  // One indexer read plus a fee read per winning market — the SDK's own sweep.
  const claimable = useIndexerQuery(
    async (client) => (address ? client.getClaimable(address) : []),
    [address],
  );

  const [review, setReview] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ hash: string; count: number; total: number } | null>(null);

  const rows = useMemo((): Row[] => {
    const meta = new Map<string, { decimals: number; asset: string; interval: string | null }>();
    for (const p of portfolio.data?.positions ?? []) {
      meta.set(p.market.id.toLowerCase(), {
        decimals: p.market.quoteDecimals,
        asset: p.market.asset,
        interval: p.market.interval,
      });
    }
    return (claimable.data ?? []).map((c) => {
      const m = meta.get(c.marketId.toLowerCase());
      // The collateral decimals are read from chain by `useBalances`; falling
      // back to a literal 6 here would render a mainnet payout a trillion times
      // too large, so the fallback is the READ value, not a constant.
      const decimals = m?.decimals ?? balances.collateralDecimals;
      return {
        ...c,
        decimals,
        asset: m?.asset ?? "market",
        interval: m?.interval ?? null,
        voided: c.status === "Voided",
        payout: rawToNumber(c.estPayout, decimals),
        shares: rawToNumber(c.amount, decimals),
      };
    });
  }, [claimable.data, portfolio.data, balances.collateralDecimals]);

  const total = rows.reduce((acc, r) => acc + r.payout, 0);
  const voidCount = rows.filter((r) => r.voided).length;

  async function claim(entries: Row[]) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // Everything goes through `redeemMany`, single claims included. It takes
      // an EXPLICIT `outcomeIdx` per entry, which is what makes a voided market
      // claimable at all: a void has no `winningOutcome` to infer from, and the
      // convenience `redeem()` path derives one.
      const res = await exchange.trader.redeemMany({
        entries: entries.map((r) => ({
          marketId: r.marketId as Hex,
          outcomeIdx: r.outcomeIdx,
          amount: r.amount,
        })),
      });
      if (res.receipt?.status === "reverted") {
        throw new Error(
          `The claim was mined but REVERTED on-chain (tx ${res.hash}). Nothing was redeemed. ` +
            "A batch claim is all-or-nothing — try claiming the rows one at a time to find the one that objects.",
        );
      }
      setDone({
        hash: res.hash,
        count: entries.length,
        total: entries.reduce((acc, r) => acc + r.payout, 0),
      });
      setReview(null);
      claimable.refetch();
      portfolio.refetch();
      balances.refetch();
      onClaimed?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      id="claims"
      title="Unclaimed winnings"
      subtitle="A settled market pays out only when someone asks — nothing sweeps for you"
      right={
        rows.length > 0 ? (
          <Pill tone="up">
            {total.toFixed(4)} {COLLATERAL_SYMBOL} owed
          </Pill>
        ) : (
          <Pill>{claimable.loading ? "scanning…" : "nothing owed"}</Pill>
        )
      }
    >
      {claimable.loading && !claimable.data && <PanelState state="loading" />}
      {claimable.error && (
        <PanelState state="error">
          Could not scan settled markets: {claimable.error.message}
        </PanelState>
      )}
      {claimable.data && rows.length === 0 && !claimable.error && (
        <PanelState
          state="empty"
          empty="Nothing to claim. Every settled window this wallet holds a winning position in has already been redeemed."
        />
      )}

      {rows.length > 0 && review === null && (
        <>
          <ul className="divide-y divide-white/5">
            {rows.map((r) => (
              <li key={`${r.marketId}-${r.outcomeIdx}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <span className="text-[13px] text-slate-200">{r.asset}</span>
                {r.interval && <span className="mono text-[10px] text-slate-500">{r.interval}</span>}
                <Pill tone={r.voided ? "warn" : r.outcomeIdx === 0 ? "up" : "down"}>
                  {r.voided ? "void" : r.outcomeIdx === 0 ? "YES won" : "NO won"}
                </Pill>
                <span className="mono text-[12px] text-slate-300">
                  {r.shares.toFixed(2)} {r.outcomeIdx === 0 ? "YES" : "NO"}
                </span>
                <span className="mono text-[13px] font-semibold text-up">
                  +{r.payout.toFixed(4)} {COLLATERAL_SYMBOL}
                </span>
                <button
                  type="button"
                  disabled={!canTrade || busy}
                  onClick={() => { setReview([r]); setError(null); setDone(null); }}
                  className="ml-auto rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/25 hover:bg-white/5 disabled:opacity-40"
                >
                  Claim
                </button>
              </li>
            ))}
          </ul>

          {voidCount > 0 && (
            <p className="border-t border-white/5 px-4 py-2.5 text-[11.5px] leading-relaxed text-amber-300/90">
              {voidCount} of these {voidCount === 1 ? "is" : "are"} a <strong>voided</strong> window.
              A void has no winner: both YES and NO redeem at 0.5, with no settlement fee. That is a
              refund of half your stake per leg, not a loss — and if you held both legs you get the
              whole thing back.
            </p>
          )}

          <div className="border-t border-white/10 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-slate-300">
                <span className="mono text-[14px] font-semibold text-up">
                  {total.toFixed(4)} {COLLATERAL_SYMBOL}
                </span>{" "}
                across {rows.length} settled position{rows.length === 1 ? "" : "s"} is sitting
                unclaimed. It will keep sitting there until you claim it.
              </p>
              <button
                type="button"
                disabled={!canTrade || busy}
                onClick={() => { setReview(rows); setError(null); setDone(null); }}
                className="rounded-lg border border-up/40 bg-up/15 px-4 py-2 text-[13px] font-semibold text-up transition hover:bg-up/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Claim all {rows.length}
              </button>
            </div>
            {!canTrade && (
              <p className="mt-2 text-[11px] text-slate-500">
                Connect a wallet on Somnia testnet to claim.
              </p>
            )}
          </div>
        </>
      )}

      {/* ------------------------------------------------------------ review */}
      {review !== null && (
        <div className="px-4 py-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Confirm before signing
          </h3>
          <div className="mt-2 divide-y divide-white/5 rounded-lg border border-white/10 bg-ink-950/50 px-3 py-1">
            {review.map((r) => (
              <ReviewRow
                key={`${r.marketId}-${r.outcomeIdx}`}
                label={`${r.asset}${r.interval ? ` ${r.interval}` : ""} · ${r.shares.toFixed(2)} ${r.outcomeIdx === 0 ? "YES" : "NO"}`}
                tone={r.voided ? "warn" : "up"}
                value={`+${r.payout.toFixed(4)} ${COLLATERAL_SYMBOL}`}
                note={
                  r.voided
                    ? "voided window — both sides redeem at 0.5, no fee"
                    : "winning side — redeems at 1 minus the venue settlement fee"
                }
              />
            ))}
            <ReviewRow
              label="Total received"
              tone="up"
              value={`${review.reduce((a, r) => a + r.payout, 0).toFixed(4)} ${COLLATERAL_SYMBOL}`}
              note="paid straight to your wallet by the settlement contract"
            />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            {review.length > 1
              ? "One transaction redeems all of these. It is all-or-nothing: if any single entry cannot be redeemed, the whole batch reverts and nothing changes."
              : "One transaction redeems this position. The payout goes to your own wallet — the settlement contract pins the recipient to the token holder."}{" "}
            The payout is an estimate from the venue's frozen settlement fee; the exact figure is
            whatever the contract transfers.
          </p>

          {error !== null && (
            <div className="mt-3">
              <WriteError error={error} />
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => { setReview(null); setError(null); }}
              className="rounded-lg border border-white/10 px-3 py-2 text-[13px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              disabled={busy || !canTrade}
              onClick={() => void claim(review)}
              className="flex-1 rounded-lg border border-up/40 bg-up/20 px-4 py-2 text-[13px] font-semibold text-up transition hover:bg-up/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Waiting for your wallet…" : `Sign and claim ${review.length} position${review.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="border-t border-white/10 px-4 py-3">
          <p className="text-[12.5px] font-semibold text-up">
            Claimed {done.total.toFixed(4)} {COLLATERAL_SYMBOL} across {done.count} position
            {done.count === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-[11px]">
            <TxLink hash={done.hash} />
          </p>
        </div>
      )}
    </Card>
  );
}
