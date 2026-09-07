/**
 * On-chain forecast commitments (`contracts/VaticrForecastRegistry.sol`).
 *
 * Opt-in: set `VATICR_REGISTRY` to the deployed address. When it is unset the
 * bot still records forecasts off-chain through the Python API, which is enough
 * to score itself - the registry is what makes that record checkable by someone
 * who does not trust the agent.
 *
 * One commitment per market, written while the window is still open. The
 * contract refuses a late one, so a missed window is skipped rather than
 * back-filled.
 *
 * SHARING THE KEY WITH THE TRADER
 *
 * The registry is not on the Bot Kit's module ABIs, so it cannot go through
 * `exchange.trader` - that tier only speaks pool/module/settlement calls. It
 * therefore signs with its own viem wallet client, on the SAME private key the
 * SDK trader is sending orders from in the same loop, and two senders on one
 * key race each other's nonce. The Bot Kit says so in as many words
 * (vendor/ec-core/src/claim.ts): "two senders on one key race each other's
 * nonce ('nonce too low', one of them lost)", which is why claiming is driven
 * from the trading loop rather than a timer.
 *
 * Two things keep that from happening here, and both are needed:
 *
 *   1. ONE nonce source. The SDK's writer derives its account with viem's
 *      shared `nonceManager` singleton (markets-sdk `writer.ts` ->
 *      `resolveSigner(config, "createTrader", { nonceManager })`), which
 *      fetches the chain nonce once and then increments in memory - so during
 *      a burst its counter is deliberately AHEAD of what the node reports as
 *      pending. An independent `privateKeyToAccount(pk)` has no nonce manager,
 *      so viem falls back to `eth_getTransactionCount(pending)` and happily
 *      reuses a nonce the SDK has already spent. Passing the same singleton in
 *      makes both signers consume from one counter keyed on (address, chainId)
 *      - viem dedupes to one module instance, so it really is the same object.
 *   2. NEVER IN FLIGHT ALONGSIDE A TRADE. `commit()` waits for the receipt
 *      before it returns, and the runner awaits `commit()` before it places
 *      anything, so the commitment is mined before the first order of that
 *      market pass is signed. Belt and braces on top of (1), and it is what
 *      makes the receipt check below possible at all.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { makeChain, type EcContext } from "@dreamdex-bot-kit/ec-core";
import { log, warn } from "./config.js";
import type { ForecastEnvelope } from "./signal.js";

const ABI = [
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "probabilityBps", type: "uint16" },
      { name: "priorBps", type: "uint16" },
      { name: "expiry", type: "uint64" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasForecast",
    stateMutability: "view",
    inputs: [
      { name: "agent", type: "address" },
      { name: "marketId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ZERO_HASH: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Don't let a stuck receipt wedge the trading loop behind an audit write. */
const RECEIPT_TIMEOUT_MS = 30_000;

/** Probability in (0,1) to basis points, clamped to the contract's 1..9999. */
const toBps = (p: number): number =>
  Math.max(1, Math.min(9999, Math.round(p * 10_000)));

/** keccak256 over the evidence set, so the agent can later reveal exactly what it used. */
function evidenceHash(env: ForecastEnvelope): Hex {
  const ids = env.forecast.evidence.map((e) => e.headline_id).sort();
  if (ids.length === 0) return ZERO_HASH;
  return keccak256(toHex(ids.join(",")));
}

export class ForecastRegistry {
  /**
   * Markets whose commitment is CONFIRMED on chain - never merely attempted.
   * A market goes in here only after a receipt says success (or `hasForecast`
   * already says so), because a market recorded on a failed write is a market
   * that never gets retried: the window is minutes long, this loop runs every
   * few seconds, and a single dropped transaction would otherwise cost the
   * whole forecast rather than one cycle.
   */
  private readonly committed = new Set<string>();

  private constructor(
    private readonly address: Address,
    private readonly wallet: ReturnType<typeof createWalletClient>,
    private readonly publicClient: ReturnType<typeof createPublicClient>,
    private readonly account: Address,
  ) {}

  /** Returns null when unconfigured - the caller simply skips on-chain commits. */
  static create(ctx: EcContext): ForecastRegistry | null {
    const address = (process.env.VATICR_REGISTRY ?? "").trim();
    if (!address) return null;
    const pk = ctx.config.privateKey;
    if (!pk) {
      warn("VATICR_REGISTRY is set but there is no PRIVATE_KEY - skipping on-chain commits");
      return null;
    }
    const chain = makeChain(ctx.config);
    // `nonceManager` is viem's module singleton, and it is the very object the
    // SDK's trader signs through - see the header. Dropping it here is the
    // whole bug: two independent nonce sources on one key.
    const account = privateKeyToAccount(pk, { nonceManager });
    return new ForecastRegistry(
      address as Address,
      createWalletClient({ account, chain, transport: http(ctx.config.rpcUrl) }),
      createPublicClient({ chain, transport: http(ctx.config.rpcUrl) }),
      account.address,
    );
  }

  /**
   * Commit one forecast, and return true only when the chain says it landed.
   *
   * Best-effort in the sense that publishing a track record must never
   * interrupt trading: every failure is logged and swallowed. It is NOT
   * best-effort about what it claims - a reverted or dropped write leaves the
   * market un-recorded, so the next cycle tries again while the window is open.
   */
  async commit(env: ForecastEnvelope): Promise<boolean> {
    const marketId = env.forecast.market_id;
    if (!marketId) return false;
    if (this.committed.has(marketId)) return false;
    // The contract refuses a forecast on a closed window; don't waste the gas.
    if (env.expiry <= Math.floor(Date.now() / 1000)) return false;

    try {
      const already = await this.publicClient.readContract({
        address: this.address,
        abi: ABI,
        functionName: "hasForecast",
        args: [this.account, marketId as Hex],
      });
      if (already) {
        this.committed.add(marketId);
        return false;
      }

      const hash = await this.wallet.writeContract({
        address: this.address,
        abi: ABI,
        functionName: "commit",
        args: [
          marketId as Hex,
          toBps(env.forecast.posterior),
          toBps(env.forecast.prior),
          BigInt(env.expiry),
          evidenceHash(env),
        ],
        chain: this.wallet.chain,
        account: this.wallet.account!,
      });

      // A transaction hash is a receipt for nothing. `writeContract` sends with
      // no simulation, so a commit on an already-committed market, a closed
      // window, or a wrong registry address all resolve with a perfectly good
      // hash and a reverted receipt - the same trap `assertTxOk` exists for on
      // the Bot Kit's own writes.
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status !== "success") {
        warn(`registry commit REVERTED for ${env.forecast.symbol} (tx ${hash}) - retrying next cycle`);
        return false;
      }

      this.committed.add(marketId);
      log(`     registry: committed ${env.forecast.symbol} on-chain - tx ${hash}`);
      return true;
    } catch (err) {
      warn(`registry commit failed (continuing): ${(err as Error).message}`);
      return false;
    }
  }
}
