"use client";

/**
 * The wallet control, in the site's existing visual language: a `.card` shell,
 * `Pill`s for status, the ink palette, no new colours.
 *
 * It has four states and each one says something different:
 *
 *   disconnected  - one button, or a picker when more than one connector exists
 *   connecting    - the button says so and is disabled; no spinner theatre
 *   wrong network - an amber pill plus a one-click switch (which ADDS Somnia to
 *                   the wallet first, because almost no wallet has it)
 *   connected     - truncated address, native STT and tUSDC, and a disconnect
 *
 * Errors are rendered, not swallowed. A user who cancels a wallet prompt sees
 * nothing (that is not a failure); anything else is shown verbatim, because a
 * silent failure on a page that signs transactions is worse than an ugly one.
 */

import { Power } from "lucide-react";
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
 * wallet or the chain reported it - this page signs transactions, and a failure
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
/** One balance line: ticker left, figure right, so the two numbers align. */
function Row({
  label, value, loading,
}: {
  label: string;
  value?: { short?: string; exact?: string; isTruncated?: boolean };
  loading: boolean;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-2 py-0.5"
      title={value?.isTruncated && value.exact ? `${value.exact} ${label}` : undefined}
    >
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-gray-600">{label}</dt>
      <dd className="mono text-[12.5px] font-semibold text-gray-100">
        {loading || value?.short === undefined ? "…" : value.short}
      </dd>
    </div>
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

  // Close the connector picker on an outside click or Escape - a dropdown that
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
            // Anchored to the BOTTOM of the trigger and opening upward: this control
            // sits at the foot of the sidebar, where a downward menu would render
            // off the bottom of the viewport.
            className="card absolute bottom-full left-0 right-0 z-40 mb-2 min-w-[11rem] overflow-hidden p-1"
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
  // This lives in a 232px rail, so everything stacks. The earlier row layout
  // was written for a wide header and wrapped into an unreadable pile here.
  if (!chainOk) {
    return (
      <div className="flex w-full flex-col gap-2">
        <Pill tone="warn">
          Wrong network{chainId !== undefined ? ` · chain ${chainId}` : ""}
        </Pill>

        <button
          type="button"
          disabled={isSwitching}
          onClick={() => void switchToSomnia()}
          className="w-full rounded-lg border border-amber-400/40 bg-amber-400/15 px-3 py-2 text-[12.5px] font-semibold leading-tight text-amber-300 transition hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSwitching ? "Check your wallet…" : "Switch to Somnia testnet"}
        </button>

        <p className="text-[11px] leading-snug text-slate-400">
          Vaticr trades only on Somnia Shannon testnet (50312). Most wallets do
          not ship it, so you will be asked to add it first.
        </p>

        <button
          type="button"
          onClick={() => disconnect()}
          className="w-full rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          Disconnect
        </button>

        <ErrorNote error={switchError} />
      </div>
    );
  }

  // ---- connected, right network ---------------------------------------
  //
  // Built for the sidebar rail it lives in: a 232px column, so the account
  // stacks rather than running as a wide segmented bar. Address and disconnect
  // share the top line because they are both "this account"; the balances sit
  // below as a label/value table so the two figures align and can be compared.
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900">
      <div className="flex items-center gap-2 border-b border-ink-700 px-2.5 py-2">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-up" />
        <a
          href={`${SOMNIA_EXPLORER}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          title={`${address}${connector?.name ? ` - ${connector.name}` : ""}`}
          className="mono min-w-0 flex-1 truncate text-[12px] text-gray-200 transition hover:text-white"
        >
          {address ? truncateAddress(address) : ""}
          <span className="sr-only">
            {connector?.name ? `, connected with ${connector.name}` : ""} - open in the explorer
          </span>
        </a>
        <button
          type="button"
          onClick={() => disconnect()}
          title="Disconnect this wallet"
          className="shrink-0 rounded p-1 text-gray-500 transition hover:bg-ink-800 hover:text-down"
        >
          <Power size={13} aria-hidden />
          <span className="sr-only">Disconnect</span>
        </button>
      </div>

      <dl className="px-2.5 py-2">
        <Row label="STT" value={balances.native} loading={balances.isLoading} />
        <Row label={COLLATERAL_SYMBOL} value={balances.collateral} loading={balances.isLoading} />
      </dl>
      {balances.isError && (
        <p className="mt-1 text-[11px] text-down" role="status" aria-live="polite">
          Balance read failed{balances.error ? `: ${balances.error.message}` : ""}
        </p>
      )}
    </div>
  );
}
