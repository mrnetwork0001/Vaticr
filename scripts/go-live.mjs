#!/usr/bin/env node
/**
 * One command to put Vaticr on-chain.
 *
 *   npm run go-live          # dry run: show exactly what it would do
 *   npm run go-live -- --send
 *
 * The hackathon asks for a "working prototype on testnet". Vaticr has only ever
 * run in DRY_RUN, so nothing it does is visible on a block explorer. This script
 * produces that evidence in one pass and writes it to deployments/<chainId>.json
 * and PROOF.md, so the submission can point at real transactions.
 *
 * It does four things, each independently skippable:
 *   1. deploy VaticrForecastRegistry            (hardhat)
 *   2. mint tUSDC from the public testnet faucet
 *   3. commit one real forecast on-chain, taken from the live Vaticr API
 *   4. place ONE small real order on a live event contract
 *
 * The only thing it cannot do for you is obtain native STT for gas — every
 * Somnia faucet is captcha- or human-gated. Fund the address it prints, then
 * re-run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import process from "node:process";

const SEND = process.argv.includes("--send");
const log = (m) => console.log(`\x1b[36m[go-live]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m  ✓\x1b[0m ${m}`);
const bad = (m) => console.log(`\x1b[31m  ✗\x1b[0m ${m}`);
const step = (n, m) => console.log(`\n\x1b[1m${n}. ${m}\x1b[0m`);

function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
  }
}
loadEnv();

const EXPLORER = "https://shannon-explorer.somnia.network";

async function main() {
  const { createPublicClient, http, formatEther, formatUnits } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (!pk) {
    bad("No PRIVATE_KEY in .env.");
    console.log(`
  Generate a throwaway TESTNET key and fund it:

    node -e "const{generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('PRIVATE_KEY='+k);console.log('address    '+privateKeyToAccount(k).address)"

  Put the PRIVATE_KEY line in .env (it is gitignored), then fund the address at
  any Somnia Shannon faucet and re-run:

    https://testnet.somnia.network/
    https://cloud.google.com/application/web3/faucet/somnia/shannon
    https://stakely.io/faucet/somnia-testnet-stt
`);
    process.exit(1);
  }

  const account = privateKeyToAccount(pk);
  const rpc = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
  const pub = createPublicClient({ transport: http(rpc) });

  log(`account   ${account.address}`);
  log(`network   Somnia Shannon testnet (50312)`);
  log(`mode      ${SEND ? "\x1b[1mSEND — real transactions\x1b[0m" : "dry run (pass --send to execute)"}`);

  step(0, "Gas check");
  const gas = await pub.getBalance({ address: account.address });
  console.log(`   native STT: ${formatEther(gas)}`);
  if (gas === 0n) {
    bad("This address has no STT, so nothing on-chain can happen.");
    console.log(`
   Fund it — every Somnia faucet is captcha-gated, so this step needs a human:
     https://testnet.somnia.network/
     https://cloud.google.com/application/web3/faucet/somnia/shannon
     https://stakely.io/faucet/somnia-testnet-stt

   Address to fund:  ${account.address}

   Then re-run:  npm run go-live -- --send
`);
    process.exit(1);
  }
  ok("funded");

  const out = {
    chainId: 50312,
    network: "somniaTestnet",
    account: account.address,
    explorer: `${EXPLORER}/address/${account.address}`,
    steps: {},
  };

  step(1, "Deploy VaticrForecastRegistry");
  if (!SEND) {
    console.log("   would run: npx hardhat run scripts/deploy-registry.cjs --network somniaTestnet");
  } else {
    const r = spawnSync("npx", ["hardhat", "run", "scripts/deploy-registry.cjs", "--network", "somniaTestnet"],
      { stdio: "inherit", env: process.env });
    if (r.status !== 0) { bad("deploy failed"); process.exit(1); }
    const f = "deployments/50312.json";
    if (existsSync(f)) {
      const d = JSON.parse(readFileSync(f, "utf8"));
      out.steps.registry = { address: d.forecastRegistry, tx: d.txHash, explorer: d.explorer };
      ok(`registry ${d.forecastRegistry}`);
    }
  }

  step(2, "Mint tUSDC from the public faucet, commit a forecast, place one order");
  if (!SEND) {
    console.log("   would run: npx tsx scripts/go-live-onchain.ts");
    console.log("   (faucet -> on-chain forecast commit -> one small real order)");
  } else {
    const r = spawnSync("npx", ["tsx", "scripts/go-live-onchain.ts"], { stdio: "inherit", env: process.env });
    if (r.status !== 0) bad("on-chain step reported a failure — see output above");
    if (existsSync("deployments/onchain-proof.json")) {
      out.steps.onchain = JSON.parse(readFileSync("deployments/onchain-proof.json", "utf8"));
    }
  }

  if (SEND) {
    mkdirSync("deployments", { recursive: true });
    writeFileSync("deployments/go-live.json", JSON.stringify(out, null, 2) + "\n");
    ok("wrote deployments/go-live.json");
    console.log(`\n   Account activity: ${out.explorer}\n`);
  } else {
    console.log(`\n   Dry run only. Re-run with --send to execute.\n`);
  }
}

main().catch((e) => { bad(e.message ?? String(e)); process.exit(1); });
