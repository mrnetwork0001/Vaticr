require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./.hardhat-cache", artifacts: "./artifacts" },
  networks: {
    // Somnia Shannon testnet - the network DreamDEX event contracts run on.
    somniaTestnet: {
      url: process.env.RPC_URL || "https://api.infra.testnet.somnia.network",
      chainId: 50312,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    somniaMainnet: {
      url: process.env.RPC_URL || "https://api.infra.mainnet.somnia.network",
      chainId: 5031,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
