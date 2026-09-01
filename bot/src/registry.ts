/**
 * On-chain forecast commitments (`contracts/VaticrForecastRegistry.sol`).
 *
 * Opt-in: set `VATICR_REGISTRY` to the deployed address. When it is unset the
 * bot still records forecasts off-chain through the Python API, which is enough
 * to score itself — the registry is what makes that record checkable by someone
 * who does not trust the agent.
 *
 * One commitment per market, written while the window is still open. The
 * contract refuses a late one, so a missed window is skipped rather than
 * back-filled.
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
import { privateKeyToAccount } from "viem/accounts";
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
  private readonly seen = new Set<string>();

  private constructor(
    private readonly address: Address,
    private readonly wallet: ReturnType<typeof createWalletClient>,
    private readonly publicClient: ReturnType<typeof createPublicClient>,
    private readonly account: Address,
  ) {}

  /** Returns null when unconfigured — the caller simply skips on-chain commits. */
  static create(ctx: EcContext): ForecastRegistry | null {
    const address = (process.env.VATICR_REGISTRY ?? "").trim();
    if (!address) return null;
    const pk = ctx.config.privateKey;
    if (!pk) {
      warn("VATICR_REGISTRY is set but there is no PRIVATE_KEY — skipping on-chain commits");
      return null;
    }
    const chain = makeChain(ctx.config);
    const account = privateKeyToAccount(pk);
    return new ForecastRegistry(
      address as Address,
      createWalletClient({ account, chain, transport: http(ctx.config.rpcUrl) }),
      createPublicClient({ chain, transport: http(ctx.config.rpcUrl) }),
      account.address,
    );
  }

  /**
   * Commit one forecast. Best-effort: publishing a track record must never
   * interrupt trading, so every failure is logged and swallowed.
   */
  async commit(env: ForecastEnvelope): Promise<boolean> {
    const marketId = env.forecast.market_id;
    if (!marketId) return false;
    if (this.seen.has(marketId)) return false;
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
        this.seen.add(marketId);
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
      this.seen.add(marketId);
      log(`     registry: committed ${env.forecast.symbol} on-chain — tx ${hash}`);
      return true;
    } catch (err) {
      warn(`registry commit failed (continuing): ${(err as Error).message}`);
      return false;
    }
  }
}
