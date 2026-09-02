"use client";

/**
 * The wallet control, in the site's existing visual language: a `.card` shell,
 * `Pill`s for status, the ink palette, no new colours.
 *
 * It has four states and each one says something different:
 *
 *   disconnected  — one button, or a picker when more than one connector exists
 *   connecting    — the button says so and is disabled; no spinner theatre
 *   wrong network — an amber pill plus a one-click switch (which ADDS Somnia to
 *                   the wallet first, because almost no wallet has it)
 *   connected     — truncated address, native STT and tUSDC, and a disconnect
 *
 * Errors are rendered, not swallowed. A user who cancels a wallet prompt sees
 * nothing (that is not a failure); anything else is shown verbatim, because a
 * silent failure on a page that signs transactions is worse than an ugly one.
 */

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Pill } from "../ui";
import { COLLATERAL_SYMBOL, SOMNIA_EXPLORER } from "./chain";
import { truncateAddress } from "./format";
import { useBalances } from "./useBalances";
import { isUserRejection, useSomniaChain } from "./useSomniaChain";

/**
 * Errors, shown rather than swallowed.
 *
 * The one exception is a dismissed wallet prompt: the user meant to do that, so
 * a red banner would be scolding them for it. Everything else is printed as the
 * wallet or the chain reported it — this page signs transactions, and a failure
 * it hid would be a failure the user goes on to retry blind.
 */
function ErrorNote({ error }: { error: Error | null }) {
  if (!error || isUserRejection(error)) return null;
  const notFound =
    error.name === "ConnectorNotFoundError" ||
    /connector not found|provider not found|no injected/i.test(error.message);
  return (
    <p className="mt-2 max-w-xs text-[11px] leading-relaxed text-down" role="status" aria-live="polite">
      {notFound
        ? "No browser wallet responded. Install or unlock one (MetaMask, Rabby, …) and try again."
        : error.message}
    </p>
  );
}

/** A balance pill: short value on the face, exact value in the tooltip. */
function BalancePill({
  label, short, exact, truncated, loading,
}: {
  label: string; short?: string; exact?: string; truncated?: boolean; loading: boolean;
}) {
  return (
    <span
      className="mono inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300"
      title={truncated && exact ? `${exact} ${label}` : undefined}
    >
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">{loading || short === undefined ? "…" : short}</span>
    </span>
  );
}

export default function ConnectButton() {
  const { address, isConnected, isConnecting, isReconnecting, connector } = useAccount();
  const { connect, connectors, isPending: isConnectPending, error: connectError, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { chainOk, chainId, isSwitching, error: switchError, switchToSomnia } = useSomniaChain();
  const balances = useBalances(chainOk ? address : undefined);

  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the connector picker on an outside click or Escape — a dropdown that
  // only closes by re-clicking the trigger traps a keyboard user.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const busy = isConnecting || isReconnecting || isConnectPending;

  // ---- disconnected ----------------------------------------------------
  if (!isConnected) {
    const only = connectors.length === 1 ? connectors[0] : undefined;
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          disabled={busy || connectors.length === 0}
          onClick={() => {
            reset();
            if (only) connect({ connector: only });
            else setPickerOpen((v) => !v);
          }}
          aria-haspopup={only ? undefined : "menu"}
          aria-expanded={only ? undefined : pickerOpen}
          className="rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-[13px] font-semibold text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect wallet"}
        </button>

        {pickerOpen && !only && (
          <div
            role="menu"
            className="card absolute right-0 z-30 mt-2 w-52 overflow-hidden p-1"
          >
            {connectors.map((c) => (
              <button
                key={c.uid}
                type="button"
                role="menuitem"
                onClick={() => { setPickerOpen(false); reset(); connect({ connector: c }); }}
                className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-slate-200 transition hover:bg-white/5"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {connectors.length === 0 && (
          <p className="mt-2 max-w-xs text-[11px] leading-relaxed text-slate-400">
            No wallet detected. Install a browser wallet, then reload.
          </p>
        )}
        <ErrorNote error={(connectError as Error | null) ?? null} />
      </div>
    );
  }

  // ---- connected, wrong network ---------------------------------------
  if (!chainOk) {
    return (
      <div className="flex flex-col items-end">
        <div className="flex items-center gap-2">
          <Pill tone="warn">
            Wrong network{chainId !== undefined ? ` · chain ${chainId}` : ""}
          </Pill>
          <button
            type="button"
            disabled={isSwitching}
            onClick={() => void switchToSomnia()}
            className="rounded-lg border border-amber-400/40 bg-amber-400/15 px-3 py-1.5 text-[13px] font-semibold text-amber-300 transition hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSwitching ? "Switching…" : "Switch to Somnia testnet"}
          </button>
          <button
            type="button"
            onClick={() => disconnect()}
            className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
          >
            Disconnect
          </button>
        </div>
        <p className="mt-2 max-w-sm text-right text-[11px] leading-relaxed text-slate-400">
          Vaticr trades only on Somnia Shannon testnet (50312). Your wallet will
          be asked to add the network if it does not have it.
        </p>
        <ErrorNote error={switchError} />
      </div>
    );
  }

  // ---- connected, right network ---------------------------------------
  return (
    <div className="flex flex-col items-end">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <BalancePill
          label="STT"
          short={balances.native?.short}
          exact={balances.native?.exact}
          truncated={balances.native?.isTruncated}
          loading={balances.isLoading}
        />
        <BalancePill
          label={COLLATERAL_SYMBOL}
          short={balances.collateral?.short}
          exact={balances.collateral?.exact}
          truncated={balances.collateral?.isTruncated}
          loading={balances.isLoading}
        />
        <a
          href={`${SOMNIA_EXPLORER}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          title={address}
          className="mono rounded-full border border-up/30 bg-up/15 px-2 py-0.5 text-[11px] text-up transition hover:bg-up/25"
        >
          {address ? truncateAddress(address) : ""}
        </a>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          Disconnect
        </button>
      </div>
      {connector?.name && (
        <p className="mt-1 text-[11px] text-slate-500">
          {connector.name} · Somnia testnet
        </p>
      )}
      {balances.isError && (
        <p className="mt-1 text-[11px] text-down" role="status" aria-live="polite">
          Balance read failed{balances.error ? `: ${balances.error.message}` : ""}
        </p>
      )}
    </div>
  );
}
