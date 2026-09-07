const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VaticrForecastRegistry", function () {
  let registry, agent, other;
  const MARKET = ethers.id("BTC-900s-window-1");
  const EVIDENCE = ethers.id("headline-set-a");

  const future = async (secs = 900) => (await time.latest()) + secs;

  beforeEach(async function () {
    [agent, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("VaticrForecastRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
  });

  it("records a forecast and emits it", async function () {
    const expiry = await future();
    await expect(registry.commit(MARKET, 6130, 6140, expiry, EVIDENCE))
      .to.emit(registry, "ForecastCommitted")
      .withArgs(agent.address, MARKET, 6130, 6140, expiry, EVIDENCE);

    const f = await registry.getForecast(agent.address, MARKET);
    expect(f.probabilityBps).to.equal(6130);
    expect(f.priorBps).to.equal(6140);
    expect(f.expiry).to.equal(expiry);
    expect(f.evidenceHash).to.equal(EVIDENCE);
    expect(await registry.hasForecast(agent.address, MARKET)).to.equal(true);
    expect(await registry.forecastCount(agent.address)).to.equal(1);
  });

  it("refuses a forecast on a window that already closed", async function () {
    const past = (await time.latest()) - 1;
    await expect(registry.commit(MARKET, 5000, 5000, past, EVIDENCE))
      .to.be.revertedWithCustomError(registry, "WindowAlreadyClosed");
  });

  it("refuses probabilities outside (0, 1)", async function () {
    const expiry = await future();
    await expect(registry.commit(MARKET, 0, 5000, expiry, EVIDENCE))
      .to.be.revertedWithCustomError(registry, "ProbabilityOutOfRange");
    await expect(registry.commit(MARKET, 10000, 5000, expiry, EVIDENCE))
      .to.be.revertedWithCustomError(registry, "ProbabilityOutOfRange");
  });

  it("is append-only - an agent cannot revise its own history", async function () {
    const expiry = await future();
    await registry.commit(MARKET, 6000, 6000, expiry, EVIDENCE);
    await expect(registry.commit(MARKET, 9000, 9000, expiry, EVIDENCE))
      .to.be.revertedWithCustomError(registry, "AlreadyCommitted");
    // The original stands.
    expect((await registry.getForecast(agent.address, MARKET)).probabilityBps).to.equal(6000);
  });

  it("keeps agents independent", async function () {
    const expiry = await future();
    await registry.commit(MARKET, 6000, 6000, expiry, EVIDENCE);
    await registry.connect(other).commit(MARKET, 3000, 3000, expiry, EVIDENCE);
    expect((await registry.getForecast(agent.address, MARKET)).probabilityBps).to.equal(6000);
    expect((await registry.getForecast(other.address, MARKET)).probabilityBps).to.equal(3000);
  });

  it("paginates an agent's markets without reverting past the end", async function () {
    const expiry = await future();
    for (let i = 0; i < 5; i++) {
      await registry.commit(ethers.id(`m${i}`), 5000 + i, 5000, expiry, EVIDENCE);
    }
    expect((await registry.marketsOf(agent.address, 0, 2)).length).to.equal(2);
    expect((await registry.marketsOf(agent.address, 3, 10)).length).to.equal(2);
    expect((await registry.marketsOf(agent.address, 99, 10)).length).to.equal(0);
    expect((await registry.marketsOf(agent.address, 0, 10))[0]).to.equal(ethers.id("m0"));
  });

  it("reports no forecast for an unknown market", async function () {
    expect(await registry.hasForecast(agent.address, ethers.id("nope"))).to.equal(false);
    expect((await registry.getForecast(agent.address, ethers.id("nope"))).probabilityBps).to.equal(0);
  });
});
