"use client";
/**
 * What a wallet with nothing in it needs, and nothing else.
 *
 * A visitor connects, and the trade ticket tells them the order is too large
 * for their balance. True, and useless: the balance is zero, and nothing on
 * the page says how to change that. They cannot trade, cannot tell whether the
 * app is broken, and leave.
 *
 * Two things are missing at that point and they are not alike. Test collateral
 * is mintable by anyone - `faucet(uint256)` is public on the testnet tUSDC
 * contract - so that is a button here. Native STT for gas cannot be minted; it
 * comes from a faucet we do not run, so that is a link out.
 *
 * The panel appears only while something is actually missing, and removes
 * itself the moment both are present. It is onboarding, not furniture.
 */

import { useCallback, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { COLLATERAL_ADDRESS, COLLATERAL_SYMBOL, SOMNIA_CHAIN_ID } from "./chain";
import { useSomniaChain } from "./useSomniaChain";
import { useBalances } from "./useBalances";

/** Public on the testnet token: `faucet(uint256)` mints to the caller. */
const FAUCET_ABI = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/** Enough to trade with, well under any per-call cap. */
const MINT_UNITS = 1_000n;

/**
 * Gas needed before a write is even admitted to the mempool.
 *
 * Somnia reserves `gas_limit x maxFeePerGas` up front, and the SDK's fixed
 * ceiling makes that 0.6 STT per in-flight transaction - regardless of the
 * ~0.008 it actually costs. A wallet under this cannot send, and the node
 * reports it as a parameter error, so say the real number here.
 */
const GAS_FLOOR = 0.6;

const STT_FAUCETS = [
  { label: "Google Cloud faucet", href: "https://cloud.google.com/application/web3/faucet/somnia/shannon" },
  { label: "Stakely", href: "https://stakely.io/faucet/somnia-testnet-stt" },
];

export default function GetStarted() {
  const { address, isConnected } = useAccount();
  const { chainOk } = useSomniaChain();
  const balances = useBalances(chainOk ? address : undefined);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: SOMNIA_CHAIN_ID });

  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const decimals = balances.collateralDecimals;
  const collateralRaw = balances.collateral?.raw;
  const nativeRaw = balances.native?.raw;

  const needsCollateral = collateralRaw !== undefined && collateralRaw === 0n;
  const needsGas =
    nativeRaw !== undefined && nativeRaw < BigInt(Math.floor(GAS_FLOOR * 1e18));

  const mint = useCallback(async () => {
    setError(null);
    setMinting(true);
    try {
      if (!walletClient) throw new Error("Connect a wallet first.");
      const hash = await walletClient.writeContract({
        address: COLLATERAL_ADDRESS,
        abi: FAUCET_ABI,
        functionName: "faucet",
        args: [MINT_UNITS * 10n ** BigInt(decimals)],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      balances.refetch();
      setDone(true);
    } catch (err) {
      const raw = (err as Error)?.message ?? String(err);
      // A user closing the wallet popup is not a failure worth shouting about.
      setError(
        /user rejected|denied|rejected the request/i.test(raw)
          ? "You dismissed the wallet prompt - nothing was sent."
          : raw.split("\n")[0],
      );
    } finally {
      setMinting(false);
    }
  }, [walletClient, publicClient, decimals, balances]);

  // Nothing to say to a visitor who is not connected, is on the wrong chain, or
  // already holds both. The trade ticket handles everything past that.
  if (!isConnected || !chainOk) return null;
  if (balances.isLoading || (!needsCollateral && !needsGas)) return null;

  return (
    <section
      className="mb-6 rounded-lg border border-model/30 bg-model/[0.06] px-5 py-4"
      aria-labelledby="get-started-title"
    >
      <h2 id="get-started-title" className="text-[14px] font-semibold text-gray-100">
        Two things before you can trade
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-400">
        This is Somnia&apos;s Shannon testnet. Nothing here has monetary value,
        and both of these are free.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {/* Collateral: mintable, so it is a button. */}
        <div className="rounded border border-ink-700 bg-ink-950/60 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-gray-200">
              1. {COLLATERAL_SYMBOL} to trade with
            </h3>
            <span className="mono text-[11px] text-gray-500">
              {balances.collateral?.short ?? "-"}
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray-500">
            {needsCollateral
              ? "The testnet token has a public faucet. This mints straight to your wallet."
              : "You have collateral. Nothing to do here."}
          </p>
          {needsCollateral && (
            <button
              type="button"
              onClick={mint}
              disabled={minting || !walletClient}
              className="mt-3 w-full rounded bg-model px-3 py-2 text-[13px] font-semibold text-ink-950 transition hover:bg-model-dim disabled:cursor-not-allowed disabled:opacity-50"
            >
              {minting ? "Minting…" : `Mint ${MINT_UNITS.toLocaleString()} ${COLLATERAL_SYMBOL}`}
            </button>
          )}
          {done && (
            <p className="mt-2 text-[12px] text-up">Minted. Your balance is updating.</p>
          )}
          {error && (
            <p className="mt-2 break-words text-[12px] text-down">{error}</p>
          )}
        </div>

        {/* Gas: not mintable, so it is a link out. */}
        <div className="rounded border border-ink-700 bg-ink-950/60 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-gray-200">2. STT for gas</h3>
            <span className="mono text-[11px] text-gray-500">
              {balances.native?.short ?? "-"}
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray-500">
            {needsGas ? (
              <>
                Somnia reserves gas up front, so a write needs about{" "}
                <span className="mono text-gray-300">{GAS_FLOOR} STT</span> free
                even though it spends a fraction of that. We cannot mint it -
                these faucets can.
              </>
            ) : (
              "You have gas. Nothing to do here."
            )}
          </p>
          {needsGas && (
            <div className="mt-3 flex flex-wrap gap-2">
              {STT_FAUCETS.map((f) => (
                <a
                  key={f.href}
                  href={f.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-ink-700 px-3 py-1.5 text-[12.5px] text-gray-300 transition hover:border-model hover:text-model"
                >
                  {f.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="mt-3 text-[12px] text-gray-600">
        Your address:{" "}
        <span className="mono text-gray-500">{address as Address}</span>
      </p>
    </section>
  );
}
