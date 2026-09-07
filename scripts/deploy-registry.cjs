/**
 * Deploy VaticrForecastRegistry to Somnia.
 *
 *   PRIVATE_KEY=0x... npx hardhat run scripts/deploy-registry.cjs --network somniaTestnet
 *
 * Writes the address to deployments/<chainId>.json so the bot and the UI pick
 * it up without anyone pasting a hex string twice.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set PRIVATE_KEY in .env before deploying.");
  }

  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`network   ${network.name} (chainId ${chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} native`);

  if (balance === 0n) {
    throw new Error(
      `${deployer.address} holds no native token on ${network.name} - ` +
        `fund it from the Somnia faucet before deploying.`,
    );
  }

  const Factory = await ethers.getContractFactory("VaticrForecastRegistry");
  const registry = await Factory.deploy();
  console.log(`\ndeploying… tx ${registry.deploymentTransaction()?.hash}`);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`\nVaticrForecastRegistry deployed to ${address}`);

  const explorer =
    Number(chainId) === 50312
      ? `https://shannon-explorer.somnia.network/address/${address}`
      : `https://explorer.somnia.network/address/${address}`;
  console.log(`explorer  ${explorer}`);

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${chainId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        chainId: Number(chainId),
        network: network.name,
        forecastRegistry: address,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        txHash: registry.deploymentTransaction()?.hash ?? null,
        explorer,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`recorded  ${path.relative(process.cwd(), file)}`);
  console.log(`\nAdd to .env:  VATICR_REGISTRY=${address}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
