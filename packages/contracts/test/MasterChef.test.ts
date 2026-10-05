import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, BOOST_BPS, BOOST_THRESHOLD, BOOST_MATURITY, deployQrb, stamp } from "./helpers";

const RATE_A = 1n * E18; // BoltDelta per second, all pools
const RATE_B = 3n * E18; // Q0 per second, all pools
const BPS = 10_000n;

describe("CircleswapMasterChef", function () {
  async function deployChef(owner: string, a: string, b: string, qrb: string, ra = RATE_A, rb = RATE_B) {
    const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(owner, a, b, qrb, ra, rb);
    await chef.waitForDeployment();
    return chef;
  }

  async function fixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const lp0 = await Mock.deploy("Q0-WQUAI LP", "LP0");
    const lp1 = await Mock.deploy("LAPTOP-WQUAI LP", "LP1");
    const bdelta = await Mock.deploy("BoltDelta", "BDELTA");
    const q0 = await Mock.deploy("QBOLT", "Q0");
    const qrb = await deployQrb(owner.address);
    const chef = await deployChef(
      owner.address,
      await bdelta.getAddress(),
      await q0.getAddress(),
      await qrb.getAddress()
    );
    const chefAddr = await chef.getAddress();

    // Reward inventory and stakers' LP.
    await bdelta.mint(chefAddr, 1_000_000n * E18);
    await q0.mint(chefAddr, 1_000_000n * E18);
    for (const u of [alice, bob, carol]) {
      for (const lp of [lp0, lp1]) {
        await lp.mint(u.address, 1000n * E18);
        await lp.connect(u).approve(chefAddr, ethers.MaxUint256);
      }
    }
    return { owner, alice, bob, carol, lp0, lp1, bdelta, q0, qrb, chef, chefAddr };
  }

  async function withPool() {
    const f = await fixture();
    await f.chef.addPool(100, await f.lp0.getAddress());
    return f;
  }

  // ---------------------------------------------------------------- constructor

  describe("constructor", function () {
    it("stores its configuration", async function () {
      const { chef, owner, bdelta, q0, qrb } = await loadFixture(fixture);
      expect(await chef.owner()).to.equal(owner.address);
      expect(await chef.rewardTokenA()).to.equal(await bdelta.getAddress());
      expect(await chef.rewardTokenB()).to.equal(await q0.getAddress());
      expect(await chef.qrb()).to.equal(await qrb.getAddress());
      expect(await chef.rewardAPerSecond()).to.equal(RATE_A);
      expect(await chef.rewardBPerSecond()).to.equal(RATE_B);
      expect(await chef.poolLength()).to.equal(0);
      expect(await chef.totalAllocPoint()).to.equal(0);
    });

    it("rejects a zero reward token", async function () {
      const { owner, bdelta, q0, qrb } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("CircleswapMasterChef");
      const [a, b, q] = [await bdelta.getAddress(), await q0.getAddress(), await qrb.getAddress()];
      await expect(factory.deploy(owner.address, ethers.ZeroAddress, b, q, 1, 1)).to.be.revertedWithCustomError(factory, "InvalidToken");
      await expect(factory.deploy(owner.address, a, ethers.ZeroAddress, q, 1, 1)).to.be.revertedWithCustomError(factory, "InvalidToken");
    });

    it("rejects a boost source that is not a contract, but allows none at all", async function () {
      const { owner, alice, bdelta, q0 } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("CircleswapMasterChef");
      const [a, b] = [await bdelta.getAddress(), await q0.getAddress()];
      await expect(factory.deploy(owner.address, a, b, alice.address, 1, 1)).to.be.revertedWithCustomError(factory, "InvalidQrb");
      // A contract that does not answer the boost interface would silently never boost: refused as well.
      await expect(factory.deploy(owner.address, a, b, a, 1, 1)).to.be.revertedWithCustomError(factory, "InvalidQrb");
      const noBoost = await deployChef(owner.address, a, b, ethers.ZeroAddress);
      expect(await noBoost.qrb()).to.equal(ethers.ZeroAddress);
    });

    it("has no way to change the boost source or a boost figure of its own", async function () {
      const { chef } = await loadFixture(fixture);
      const names = chef.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
      expect(names).to.not.include.members(["setQrbContract", "setQrb", "qrbBoostBps", "setBoost", "BOOST_BPS"]);
      expect(names).to.include("qrb");
    });
  });

  // ---------------------------------------------------------------- pools

  describe("pools", function () {
    it("adds pools, tracks allocation and emits PoolAdded", async function () {
      const { chef, lp0, lp1 } = await loadFixture(fixture);
      await expect(chef.addPool(400, await lp0.getAddress())).to.emit(chef, "PoolAdded").withArgs(0, await lp0.getAddress(), 400);
      await expect(chef.addPool(100, await lp1.getAddress())).to.emit(chef, "PoolAdded").withArgs(1, await lp1.getAddress(), 100);
      expect(await chef.poolLength()).to.equal(2);
      expect(await chef.totalAllocPoint()).to.equal(500);
      expect((await chef.poolInfo(0)).lpToken).to.equal(await lp0.getAddress());
      expect((await chef.poolInfo(1)).allocPoint).to.equal(100);
    });

    it("rejects a zero LP token", async function () {
      const { chef } = await loadFixture(fixture);
      await expect(chef.addPool(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(chef, "InvalidToken");
    });

    it("setPool retunes allocation and emits PoolUpdated", async function () {
      const { chef, lp0, lp1 } = await loadFixture(fixture);
      await chef.addPool(400, await lp0.getAddress());
      await chef.addPool(100, await lp1.getAddress());
      await expect(chef.setPool(1, 400)).to.emit(chef, "PoolUpdated").withArgs(1, 400);
      expect(await chef.totalAllocPoint()).to.equal(800);
      await chef.setPool(0, 0);
      expect(await chef.totalAllocPoint()).to.equal(400);
    });

    it("only the owner can add or retune pools or change emissions", async function () {
      const { chef, alice, lp0 } = await loadFixture(withPool);
      await expect(chef.connect(alice).addPool(1, await lp0.getAddress())).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
      await expect(chef.connect(alice).setPool(0, 1)).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
      await expect(chef.connect(alice).setEmissionRates(1, 1)).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
      await expect(chef.connect(alice).pause()).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
    });

    it("every entry point rejects an unknown pool id", async function () {
      const { chef, alice } = await loadFixture(withPool);
      await expect(chef.connect(alice).deposit(7, 1)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.connect(alice).withdraw(7, 1)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.connect(alice).harvest(7)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.connect(alice).emergencyWithdraw(7)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.pendingRewards(7, alice.address)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.updatePool(7)).to.be.revertedWithCustomError(chef, "InvalidPool");
      await expect(chef.setPool(7, 1)).to.be.revertedWithCustomError(chef, "InvalidPool");
    });
  });

  // ---------------------------------------------------------------- rewards

  describe("dual rewards", function () {
    it("pays both tokens in the emission ratio to a sole staker, to the wei", async function () {
      const { chef, alice, bdelta, q0 } = await loadFixture(withPool);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(100);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
      expect(await q0.balanceOf(alice.address)).to.equal(RATE_B * (t1 - t0));
    });

    it("emits Harvest with exactly what was transferred", async function () {
      const { chef, alice, bdelta, q0 } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(50);
      const tx = await chef.connect(alice).harvest(0);
      const [ev] = await chef.queryFilter(chef.filters.Harvest(), (await tx.wait())!.blockNumber);
      expect(ev.args.user).to.equal(alice.address);
      expect(ev.args.pid).to.equal(0);
      expect(ev.args.amountA).to.equal(await bdelta.balanceOf(alice.address));
      expect(ev.args.amountB).to.equal(await q0.balanceOf(alice.address));
    });

    it("splits between two stakers pro rata, exactly, including the solo period", async function () {
      const { chef, alice, bob, bdelta } = await loadFixture(withPool);
      const tA = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(20);
      const tB = await stamp(await chef.connect(bob).deposit(0, 300n * E18));
      await time.increase(200);
      const hA = await stamp(await chef.connect(alice).harvest(0));
      const hB = await stamp(await chef.connect(bob).harvest(0));

      // Alice: whole pool until Bob joined, then a quarter. Bob: three quarters since joining.
      const aliceExpected = RATE_A * (tB - tA) + (RATE_A * (hA - tB)) / 4n;
      const bobExpected = (RATE_A * 3n * (hB - tB)) / 4n;
      expect(await bdelta.balanceOf(alice.address)).to.equal(aliceExpected);
      expect(await bdelta.balanceOf(bob.address)).to.equal(bobExpected);
    });

    it("splits emissions across pools by allocation points", async function () {
      const { chef, alice, bob, lp1 } = await loadFixture(withPool);
      await chef.addPool(300, await lp1.getAddress()); // pool 1 has 3x pool 0's allocation
      const tA = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      const tB = await stamp(await chef.connect(bob).deposit(1, 100n * E18));
      await time.increase(1000);
      const [a0] = await chef.pendingRewards(0, alice.address);
      const [a1] = await chef.pendingRewards(1, bob.address);
      // Pool 0 earned 1/4 then (after pool 1 existed) 1/4 of emissions; pool 1 earned 3/4. Compare the rates.
      expect(Number(a1) / Number(a0)).to.be.closeTo(3, 0.05);
      void tA;
      void tB;
    });

    it("deposit(0) harvests without changing the stake", async function () {
      const { chef, alice, bdelta } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(30);
      await chef.connect(alice).deposit(0, 0);
      expect(await bdelta.balanceOf(alice.address)).to.be.gt(0);
      expect((await chef.userInfo(0, alice.address)).amount).to.equal(100n * E18);
    });

    it("a second deposit pays the pending rewards first", async function () {
      const { chef, alice, bdelta } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(30);
      await chef.connect(alice).deposit(0, 50n * E18);
      expect(await bdelta.balanceOf(alice.address)).to.be.gt(0);
      expect((await chef.userInfo(0, alice.address)).amount).to.equal(150n * E18);
    });

    it("harvest with no stake pays nothing and does not revert", async function () {
      const { chef, bob, bdelta, q0 } = await loadFixture(withPool);
      await chef.connect(bob).harvest(0);
      expect(await bdelta.balanceOf(bob.address)).to.equal(0);
      expect(await q0.balanceOf(bob.address)).to.equal(0);
    });

    it("emission accrued while nobody was staked is not paid retroactively", async function () {
      const { chef, alice, bdelta } = await loadFixture(withPool);
      await time.increase(1000); // pool exists, empty
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
    });

    it("partial withdraw pays what is owed and keeps accruing on the remainder", async function () {
      const { chef, alice, bdelta, lp0 } = await loadFixture(withPool);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(40);
      const t1 = await stamp(await chef.connect(alice).withdraw(0, 40n * E18));
      expect(await lp0.balanceOf(alice.address)).to.equal(940n * E18);
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
      await time.increase(40);
      const t2 = await stamp(await chef.connect(alice).harvest(0));
      // Sole staker of the pool, so still the whole emission regardless of stake size. Accounting is scaled by
      // 1e24 per share, so a supply that no longer divides evenly (60e18) floors by well under a wei: dust, not
      // drift. (At the old 1e12 scale a large supply with a small emission lost tens of percent of it; see
      // test/foundry/MasterChefPrecision.t.sol.)
      const expected = RATE_A * (t2 - t0);
      const diff = expected - (await bdelta.balanceOf(alice.address));
      expect(diff).to.be.gte(0);
      expect(diff).to.be.lte(10n ** 9n);
    });

    it("a full withdraw returns the LP and settles rewards in one call", async function () {
      const { chef, alice, bdelta, q0, lp0 } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(50);
      await chef.connect(alice).withdraw(0, 100n * E18);
      expect(await lp0.balanceOf(alice.address)).to.equal(1000n * E18);
      expect(await bdelta.balanceOf(alice.address)).to.be.gt(0);
      expect(await q0.balanceOf(alice.address)).to.be.gt(0);
      expect((await chef.userInfo(0, alice.address)).amount).to.equal(0);
    });

    it("rejects withdrawing more than was staked", async function () {
      const { chef, alice } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 10n * E18);
      await expect(chef.connect(alice).withdraw(0, 11n * E18)).to.be.revertedWithCustomError(chef, "InsufficientBalance");
    });

    it("a rate change applies from the moment it is set", async function () {
      const { chef, alice, bdelta } = await loadFixture(withPool);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(50);
      const t1 = await stamp(await chef.setEmissionRates(2n * RATE_A, RATE_B));
      await time.increase(50);
      const t2 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0) + 2n * RATE_A * (t2 - t1));
    });

    it("pendingRewards tracks what harvest then pays (within the block-timestamp skew)", async function () {
      const { chef, alice, bdelta } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(500);
      const [pendingA] = await chef.pendingRewards(0, alice.address);
      await chef.connect(alice).harvest(0);
      const paid = await bdelta.balanceOf(alice.address);
      expect(paid).to.be.gte(pendingA);
      expect(paid - pendingA).to.be.lte(RATE_A * 3n);
    });
  });

  // ---------------------------------------------------------------- boost

  describe("boost from the Qrb ERC-20 (threshold AND holding time)", function () {
    const DAY = Number(BOOST_MATURITY);

    async function boostFixture() {
      const f = await withPool();
      await f.qrb.mintGenesis(f.owner.address);
      return f;
    }

    it("pays exactly BOOST_BPS more on both tokens to a holder that has held the threshold for the full period", async function () {
      const { chef, alice, qrb, bdelta, q0 } = await loadFixture(boostFixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(DAY + 100);
      const t1 = await stamp(await chef.connect(alice).harvest(0));

      const baseA = RATE_A * (t1 - t0);
      const baseB = RATE_B * (t1 - t0);
      expect(await bdelta.balanceOf(alice.address)).to.equal(baseA + (baseA * BOOST_BPS) / BPS);
      expect(await q0.balanceOf(alice.address)).to.equal(baseB + (baseB * BOOST_BPS) / BPS);
    });

    it("pays no boost before the holding period is complete", async function () {
      const { chef, alice, qrb, bdelta } = await loadFixture(boostFixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(DAY - 1000);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
    });

    it("pays no boost one wei below the threshold, however long it is held", async function () {
      const { chef, alice, qrb, bdelta } = await loadFixture(boostFixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD - 1n);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(DAY * 10);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
    });

    it("pays no boost with no QRB at all", async function () {
      const { chef, bob, bdelta } = await loadFixture(boostFixture);
      const t0 = await stamp(await chef.connect(bob).deposit(0, 100n * E18));
      await time.increase(DAY + 100);
      const t1 = await stamp(await chef.connect(bob).harvest(0));
      expect(await bdelta.balanceOf(bob.address)).to.equal(RATE_A * (t1 - t0));
    });

    it("is read at harvest: QRB held long enough counts, QRB sold before harvest does not", async function () {
      const { chef, alice, bob, qrb, bdelta } = await loadFixture(boostFixture);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await qrb.transfer(alice.address, BOOST_THRESHOLD); // acquired after staking
      await time.increase(DAY + 100);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      const base1 = RATE_A * (t1 - t0);
      expect(await bdelta.balanceOf(alice.address)).to.equal(base1 + (base1 * BOOST_BPS) / BPS);

      await time.increase(100);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD); // sold
      const before = await bdelta.balanceOf(alice.address);
      const t2 = await stamp(await chef.connect(alice).harvest(0));
      expect((await bdelta.balanceOf(alice.address)) - before).to.equal(RATE_A * (t2 - t1));
    });

    it("pendingRewards includes the boost once it has matured", async function () {
      const { chef, alice, bob, qrb } = await loadFixture(boostFixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      await chef.connect(alice).deposit(0, 100n * E18);
      await chef.connect(bob).deposit(0, 100n * E18);
      await time.increase(DAY + 1000);
      const [pa] = await chef.pendingRewards(0, alice.address);
      const [pb] = await chef.pendingRewards(0, bob.address);
      expect(Number(pa) / Number(pb)).to.be.closeTo(1.5, 0.02);
    });

    it("the farm reads the same boost the Qrb contract reports, from the one source it was built with", async function () {
      const { chef, alice, qrb } = await loadFixture(boostFixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(BOOST_BPS);
      expect(await chef.qrb()).to.equal(await qrb.getAddress());
    });
  });

  describe("the farm reads only the IQrbBoost interface", function () {
    it("pays whatever the source reports, per account", async function () {
      const { owner, alice, bob, bdelta, q0, lp0, chefAddr } = await loadFixture(fixture);
      const mock = await (await ethers.getContractFactory("MockBoost")).deploy();
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), await mock.getAddress());
      await bdelta.mint(await chef.getAddress(), 1_000_000n * E18);
      await q0.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.addPool(100, await lp0.getAddress());
      for (const u of [alice, bob]) await lp0.connect(u).approve(await chef.getAddress(), ethers.MaxUint256);
      await mock.set(alice.address, 2500); // +25%
      await mock.set(bob.address, 10_000); // +100%

      const tA = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(100);
      const hA = await stamp(await chef.connect(alice).harvest(0));
      const baseA = RATE_A * (hA - tA);
      expect(await bdelta.balanceOf(alice.address)).to.equal(baseA + (baseA * 2500n) / BPS);
      await chef.connect(alice).withdraw(0, 100n * E18);

      const tB = await stamp(await chef.connect(bob).deposit(0, 100n * E18));
      await time.increase(100);
      const hB = await stamp(await chef.connect(bob).harvest(0));
      const baseB = RATE_A * (hB - tB);
      expect(await bdelta.balanceOf(bob.address)).to.equal(baseB * 2n);
      void chefAddr;
    });

    it("never pays more than +100% whatever the source claims", async function () {
      const { owner, alice, bdelta, q0, lp0 } = await loadFixture(fixture);
      const mock = await (await ethers.getContractFactory("MockBoost")).deploy();
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), await mock.getAddress());
      await bdelta.mint(await chef.getAddress(), 1_000_000n * E18);
      await q0.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.addPool(100, await lp0.getAddress());
      await lp0.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
      await mock.set(alice.address, 50_000); // a buggy or hostile source claiming +500%
      expect(await chef.MAX_BOOST_BPS()).to.equal(10_000n);

      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(100);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0) * 2n);
    });

    it("a boost source that reverts cannot brick deposit, harvest, withdraw or the pending view", async function () {
      const { owner, alice, bdelta, q0, lp0 } = await loadFixture(fixture);
      const broken = await (await ethers.getContractFactory("RevertingBoost")).deploy();
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), await broken.getAddress());
      await bdelta.mint(await chef.getAddress(), 1_000_000n * E18);
      await q0.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.addPool(100, await lp0.getAddress());
      await lp0.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);

      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(60);
      await chef.pendingRewards(0, alice.address);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0)); // no boost, no revert
      await chef.connect(alice).withdraw(0, 100n * E18);
      expect(await lp0.balanceOf(alice.address)).to.equal(1000n * E18);
    });

    it("a farm deployed with no boost source never boosts", async function () {
      const { owner, alice, bdelta, q0, lp0 } = await loadFixture(fixture);
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), ethers.ZeroAddress);
      await bdelta.mint(await chef.getAddress(), 1_000_000n * E18);
      await q0.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.addPool(100, await lp0.getAddress());
      await lp0.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(60);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      expect(await bdelta.balanceOf(alice.address)).to.equal(RATE_A * (t1 - t0));
    });
  });

  // ---------------------------------------------------------------- solvency

  describe("solvency", function () {
    async function bare() {
      // A farm with NO reward inventory, whose pool stakes the Q0 reward token itself.
      const [owner, alice, bob] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const bdelta = await Mock.deploy("BoltDelta", "BDELTA");
      const q0 = await Mock.deploy("QBOLT", "Q0");
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), ethers.ZeroAddress);
      const chefAddr = await chef.getAddress();
      await chef.addPool(100, await q0.getAddress()); // pid 0: stake Q0, which is also reward B
      for (const u of [alice, bob]) {
        await q0.mint(u.address, 1000n * E18);
        await q0.connect(u).approve(chefAddr, ethers.MaxUint256);
      }
      return { owner, alice, bob, bdelta, q0, chef, chefAddr };
    }

    it("never pays rewards out of depositors' principal", async function () {
      const { chef, chefAddr, alice, q0 } = await loadFixture(bare);
      await chef.connect(alice).deposit(0, 1000n * E18);
      await time.increase(1000); // owed: 3000 Q0, but the inventory is empty
      await chef.connect(alice).harvest(0);
      expect(await q0.balanceOf(chefAddr)).to.equal(1000n * E18); // principal untouched
      await chef.connect(alice).withdraw(0, 1000n * E18);
      expect(await q0.balanceOf(alice.address)).to.equal(1000n * E18);
    });

    it("a partly funded inventory is paid out and capped, still without touching principal", async function () {
      const { chef, chefAddr, alice, bob, q0 } = await loadFixture(bare);
      await chef.connect(alice).deposit(0, 600n * E18);
      await chef.connect(bob).deposit(0, 400n * E18);
      await q0.mint(chefAddr, 10n * E18); // inventory: just 10 Q0 above the 1000 staked
      await time.increase(1000);
      const before = await q0.balanceOf(alice.address);
      await chef.connect(alice).harvest(0);
      expect((await q0.balanceOf(alice.address)) - before).to.equal(10n * E18); // capped at the inventory
      expect(await q0.balanceOf(chefAddr)).to.equal(1000n * E18); // both principals intact
      await chef.connect(bob).withdraw(0, 400n * E18);
      await chef.connect(alice).withdraw(0, 600n * E18);
      expect(await q0.balanceOf(chefAddr)).to.equal(0);
    });

    it("Harvest reports what was actually paid, not what was owed", async function () {
      const { chef, chefAddr, alice, q0 } = await loadFixture(bare);
      await chef.connect(alice).deposit(0, 1000n * E18);
      await q0.mint(chefAddr, 7n * E18);
      await time.increase(500);
      const tx = await chef.connect(alice).harvest(0);
      const [ev] = await chef.queryFilter(chef.filters.Harvest(), (await tx.wait())!.blockNumber);
      expect(ev.args.amountB).to.equal(7n * E18);
      expect(ev.args.amountA).to.equal(0); // no BDELTA inventory at all
    });

    it("tracks stake per token across pools, deposits, withdrawals and emergency exits", async function () {
      const { chef, alice, bob, q0 } = await loadFixture(bare);
      await chef.addPool(50, await q0.getAddress()); // a second pool for the same token
      await chef.connect(alice).deposit(0, 100n * E18);
      await chef.connect(bob).deposit(1, 250n * E18);
      expect(await chef.stakedByToken(await q0.getAddress())).to.equal(350n * E18);
      await chef.connect(alice).withdraw(0, 40n * E18);
      expect(await chef.stakedByToken(await q0.getAddress())).to.equal(310n * E18);
      await chef.connect(bob).emergencyWithdraw(1);
      expect(await chef.stakedByToken(await q0.getAddress())).to.equal(60n * E18);
    });
  });

  // ---------------------------------------------------------------- shortfall

  describe("under-funded reward inventory", function () {
    it("pays what it has, reports it, and never reverts the harvest", async function () {
      const { owner, alice, bdelta, q0, lp0 } = await loadFixture(fixture);
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), ethers.ZeroAddress);
      await chef.addPool(100, await lp0.getAddress());
      await lp0.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
      await bdelta.mint(await chef.getAddress(), 5n * E18); // BDELTA short; Q0 empty
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(100);
      await chef.connect(alice).harvest(0);
      expect(await bdelta.balanceOf(alice.address)).to.equal(5n * E18);
      expect(await q0.balanceOf(alice.address)).to.equal(0);
    });
  });

  // ---------------------------------------------------------------- pause & emergency

  describe("pause and emergency exit", function () {
    it("pause blocks deposit and harvest but never withdrawals or the emergency exit", async function () {
      const { chef, alice, bob, lp0 } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await chef.connect(bob).deposit(0, 100n * E18);
      await chef.pause();
      await expect(chef.connect(alice).deposit(0, 1)).to.be.revertedWithCustomError(chef, "EnforcedPause");
      await expect(chef.connect(alice).harvest(0)).to.be.revertedWithCustomError(chef, "EnforcedPause");
      await chef.connect(alice).withdraw(0, 100n * E18);
      await chef.connect(bob).emergencyWithdraw(0);
      expect(await lp0.balanceOf(alice.address)).to.equal(1000n * E18);
      expect(await lp0.balanceOf(bob.address)).to.equal(1000n * E18);
    });

    it("unpause restores deposit and harvest", async function () {
      const { chef, alice } = await loadFixture(withPool);
      await chef.pause();
      await chef.unpause();
      await chef.connect(alice).deposit(0, 1);
      await chef.connect(alice).harvest(0);
    });

    it("emergencyWithdraw returns the whole stake, forfeits rewards and fixes the totals", async function () {
      const { chef, alice, bdelta, q0, lp0 } = await loadFixture(withPool);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(500);
      await expect(chef.connect(alice).emergencyWithdraw(0)).to.emit(chef, "EmergencyWithdraw").withArgs(alice.address, 0, 100n * E18);
      expect(await lp0.balanceOf(alice.address)).to.equal(1000n * E18);
      expect(await bdelta.balanceOf(alice.address)).to.equal(0);
      expect(await q0.balanceOf(alice.address)).to.equal(0);
      expect((await chef.poolInfo(0)).totalStaked).to.equal(0);
      expect(await chef.stakedByToken(await lp0.getAddress())).to.equal(0);
      const u = await chef.userInfo(0, alice.address);
      expect(u.amount).to.equal(0);
      expect(u.rewardDebtA).to.equal(0);
    });

    it("emergencyWithdraw with nothing staked is a harmless no-op", async function () {
      const { chef, bob } = await loadFixture(withPool);
      await chef.connect(bob).emergencyWithdraw(0);
    });
  });

  // ---------------------------------------------------------------- reentrancy

  describe("reentrancy", function () {
    it("a hostile stake token cannot re-enter deposit from its transfer hook", async function () {
      const [owner, alice] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const bdelta = await Mock.deploy("BoltDelta", "BDELTA");
      const q0 = await Mock.deploy("QBOLT", "Q0");
      const evil = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      const chef = await deployChef(owner.address, await bdelta.getAddress(), await q0.getAddress(), ethers.ZeroAddress);
      await chef.addPool(100, await evil.getAddress());
      await evil.mint(alice.address, 10n * E18);
      await evil.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
      await evil.arm(await chef.getAddress(), chef.interface.encodeFunctionData("deposit", [0, 1]));

      await chef.connect(alice).deposit(0, 5n * E18); // outer call succeeds
      expect(await evil.attempted()).to.equal(true);
      expect(await evil.lastCallSucceeded()).to.equal(false); // inner call refused
      expect((await chef.userInfo(0, alice.address)).amount).to.equal(5n * E18);
    });
  });

  // ---------------------------------------------------------------- ownership

  describe("ownership (two-step)", function () {
    it("transfer requires acceptance", async function () {
      const { chef, owner, alice, bob } = await loadFixture(withPool);
      await chef.transferOwnership(alice.address);
      expect(await chef.owner()).to.equal(owner.address);
      await expect(chef.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
      await chef.connect(alice).acceptOwnership();
      expect(await chef.owner()).to.equal(alice.address);
      await expect(chef.pause()).to.be.revertedWithCustomError(chef, "OwnableUnauthorizedAccount");
      await chef.connect(alice).pause();
    });
  });
});
