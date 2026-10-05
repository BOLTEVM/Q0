// Regression tests for the findings of the 2026-09-21 audit. Each one failed against the code as first built
// (see docs in DEPLOY.md and the plan's audit section) and must keep passing.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, BOOST_BPS, BOOST_THRESHOLD, BOOST_MATURITY, deployQrb, stamp } from "./helpers";

const RATE = E18;
const DAY = Number(BOOST_MATURITY);
const BPS = 10_000n;

describe("audit regressions", function () {
  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const lp = await Mock.deploy("LP", "LP");
    const a = await Mock.deploy("A", "A");
    const b = await Mock.deploy("B", "B");
    const qrb = await deployQrb(owner.address);
    await qrb.mintGenesis(owner.address);
    const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(
      owner.address, await a.getAddress(), await b.getAddress(), await qrb.getAddress(), RATE, RATE
    );
    await a.mint(await chef.getAddress(), 1_000_000n * E18);
    await b.mint(await chef.getAddress(), 1_000_000n * E18);
    await chef.addPool(100, await lp.getAddress());
    for (const u of [alice, bob]) {
      await lp.mint(u.address, 1000n * E18);
      await lp.connect(u).approve(await chef.getAddress(), ethers.MaxUint256);
    }
    return { owner, alice, bob, lp, a, b, qrb, chef };
  }

  /** A farm with no boost and an EMPTY reward inventory, owned by `owner`. */
  async function bareFarm(qrbAddress: string = ethers.ZeroAddress) {
    const [owner, alice] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const lp = await Mock.deploy("LP", "LP");
    const a = await Mock.deploy("A", "A");
    const b = await Mock.deploy("B", "B");
    const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(
      owner.address, await a.getAddress(), await b.getAddress(), qrbAddress, RATE, RATE
    );
    await chef.addPool(100, await lp.getAddress());
    await lp.mint(alice.address, 1000n * E18);
    await lp.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
    return { owner, alice, lp, a, b, chef };
  }

  // -------------------------------------------------------------------------------------------------------------
  describe("F1 (high): a borrowed balance must not earn the boost", function () {
    async function flashSetup() {
      const f = await fixture();
      const farmer = await (await ethers.getContractFactory("FlashBoostFarmer")).deploy(
        await f.chef.getAddress(), await f.qrb.getAddress(), await f.lp.getAddress()
      );
      await f.lp.mint(await farmer.getAddress(), 100n * E18);
      await farmer.stake(0, 100n * E18);
      await time.increase(DAY + 100); // the lender has long since matured
      await f.qrb.approve(await farmer.getAddress(), ethers.MaxUint256);
      return { ...f, farmer };
    }

    it("borrowing QRB for one transaction (a flash swap, a lender contract) earns nothing", async function () {
      const { owner, a, farmer } = await loadFixture(flashSetup);
      const t0 = await stamp(await farmer.stake(0, 0)); // settles nothing; just a timestamp anchor
      void t0;
      await time.increase(1000);
      const before = await a.balanceOf(await farmer.getAddress());
      await farmer.harvestBoosted(0, owner.address, BOOST_THRESHOLD);
      const got = (await a.balanceOf(await farmer.getAddress())) - before;
      // Boosted would be ~1.5x a thousand seconds of emission; unboosted is ~1.0x.
      expect(got).to.be.lt((RATE * 1200n) / 1n);
      expect(got).to.be.gte(RATE * 1000n);
    });

    it("the borrower never kept the token and the lender is whole", async function () {
      const { owner, qrb, farmer } = await loadFixture(flashSetup);
      const before = await qrb.balanceOf(owner.address);
      await farmer.harvestBoosted(0, owner.address, BOOST_THRESHOLD);
      expect(await qrb.balanceOf(await farmer.getAddress())).to.equal(0);
      expect(await qrb.balanceOf(owner.address)).to.equal(before);
    });

    it("one unit of the threshold cannot be passed through wallets to boost each in turn", async function () {
      const { chef, owner, alice, bob, qrb, a } = await loadFixture(fixture);
      await chef.connect(alice).deposit(0, 100n * E18);
      await chef.connect(bob).deposit(0, 100n * E18);
      await time.increase(DAY + 100);

      // The holder (matured) hands the unit to alice, who harvests at once, returns it, and it goes to bob.
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      const beforeA = await a.balanceOf(alice.address);
      await chef.connect(alice).harvest(0);
      const gotA = (await a.balanceOf(alice.address)) - beforeA;
      await qrb.connect(alice).transfer(owner.address, BOOST_THRESHOLD);

      await qrb.transfer(bob.address, BOOST_THRESHOLD);
      const beforeB = await a.balanceOf(bob.address);
      await chef.connect(bob).harvest(0);
      const gotB = (await a.balanceOf(bob.address)) - beforeB;

      // Each holds half the pool for about DAY + 100 s. Unboosted that is ~0.5 x RATE x (DAY + 100); a boost
      // would make it ~0.75 x. Anything under 0.6 x proves neither wallet was boosted.
      const halfPool = (RATE * (BigInt(DAY) + 100n)) / 2n;
      expect(gotA).to.be.lt((halfPool * 12n) / 10n);
      expect(gotB).to.be.lt((halfPool * 12n) / 10n);
    });

    it("a wallet that really holds the threshold for the full period is still boosted", async function () {
      const { chef, alice, qrb, a, owner } = await loadFixture(fixture);
      await qrb.transfer(alice.address, BOOST_THRESHOLD);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(DAY + 100);
      const t1 = await stamp(await chef.connect(alice).harvest(0));
      const base = RATE * (t1 - t0);
      expect(await a.balanceOf(alice.address)).to.equal(base + (base * BOOST_BPS) / BPS);
      void owner;
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("F2 (medium): rewards the farm could not pay are not lost", function () {
    it("stay owed, show in pendingRewards, and are paid after the owner refills the farm", async function () {
      const { alice, a, chef } = await bareFarm();
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(1000);
      const t1 = await stamp(await chef.connect(alice).harvest(0)); // inventory empty: pays 0
      expect(await a.balanceOf(alice.address)).to.equal(0);

      const u = await chef.userInfo(0, alice.address);
      expect(u.unpaidA).to.equal(RATE * (t1 - t0));
      const [pendingA] = await chef.pendingRewards(0, alice.address);
      expect(pendingA).to.be.gte(RATE * (t1 - t0)); // the owed amount is visible, not vanished

      await a.mint(await chef.getAddress(), 1_000_000n * E18); // owner refills
      const t2 = await stamp(await chef.connect(alice).harvest(0));
      expect(await a.balanceOf(alice.address)).to.equal(RATE * (t2 - t0)); // everything, including what was unpaid
      expect((await chef.userInfo(0, alice.address)).unpaidA).to.equal(0);
    });

    it("a partial refill pays what it can first and keeps the rest owed", async function () {
      const { alice, a, chef } = await bareFarm();
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(1000);
      await a.mint(await chef.getAddress(), 300n * E18);
      await chef.connect(alice).harvest(0); // owes ~1000, only 300 there
      expect(await a.balanceOf(alice.address)).to.equal(300n * E18);
      expect((await chef.userInfo(0, alice.address)).unpaidA).to.be.gt(600n * E18);

      await a.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.connect(alice).harvest(0);
      expect((await chef.userInfo(0, alice.address)).unpaidA).to.equal(0);
      expect(await a.balanceOf(alice.address)).to.be.gt(1000n * E18);
    });

    it("can still be claimed after the stake is withdrawn, by harvest or by a zero deposit", async function () {
      const { alice, a, chef, lp } = await bareFarm();
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(1000);
      await chef.connect(alice).withdraw(0, 100n * E18); // pays 0 (empty), stake returned, reward still owed
      expect(await lp.balanceOf(alice.address)).to.equal(1000n * E18);
      const owed = (await chef.userInfo(0, alice.address)).unpaidA;
      expect(owed).to.be.gt(0);

      await a.mint(await chef.getAddress(), 1_000_000n * E18);
      await chef.connect(alice).deposit(0, 0); // a zero deposit is a harvest, and it must pay the unpaid too
      expect(await a.balanceOf(alice.address)).to.equal(owed);
    });

    it("the boost applies to newly earned rewards only, never twice to the amount left unpaid", async function () {
      const [owner, alice] = await ethers.getSigners();
      const mock = await (await ethers.getContractFactory("MockBoost")).deploy();
      await mock.set(alice.address, 5000);
      const { a, chef } = await bareFarm(await mock.getAddress());

      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(500);
      const t1 = await stamp(await chef.connect(alice).harvest(0)); // pays 0; owes boosted E1
      await a.mint(await chef.getAddress(), 1_000_000n * E18);
      await time.increase(500);
      const t2 = await stamp(await chef.connect(alice).harvest(0));

      const e1 = RATE * (t1 - t0);
      const e2 = RATE * (t2 - t1);
      const expected = e1 + (e1 * 5000n) / BPS + (e2 + (e2 * 5000n) / BPS); // (1.5 x E1) + (1.5 x E2), not 2.25 x E1
      expect(await a.balanceOf(alice.address)).to.equal(expected);
      void owner;
    });

    it("emergencyWithdraw is the explicit exit that gives owed rewards up", async function () {
      const { alice, chef } = await bareFarm();
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(1000);
      await chef.connect(alice).harvest(0); // accrues unpaid
      expect((await chef.userInfo(0, alice.address)).unpaidA).to.be.gt(0);
      await chef.connect(alice).emergencyWithdraw(0);
      const u = await chef.userInfo(0, alice.address);
      expect(u.unpaidA).to.equal(0);
      expect(u.unpaidB).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("F3 (medium): changing allocation never rewrites rewards already earned", function () {
    it("adding a pool leaves the past exactly as earned and only changes the rate going forward", async function () {
      const { chef, alice, lp, a } = await loadFixture(fixture);
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(1000);
      const tAdd = await stamp(await chef.addPool(900, await lp.getAddress())); // pool 0 falls from 100% to 10%
      await time.increase(1000);
      const tH = await stamp(await chef.connect(alice).harvest(0));

      const before = RATE * (tAdd - t0); // 100% while it lasted
      const after = (RATE * (tH - tAdd)) / 10n; // 10% since
      expect(await a.balanceOf(alice.address)).to.equal(before + after);
    });

    it("setPool behaves the same way", async function () {
      const { chef, alice, lp, a } = await loadFixture(fixture);
      await chef.addPool(100, await lp.getAddress()); // pool 1
      const t0 = await stamp(await chef.connect(alice).deposit(0, 100n * E18));
      await time.increase(1000);
      const tSet = await stamp(await chef.setPool(1, 900)); // pool 0: 50% -> 10%
      await time.increase(1000);
      const tH = await stamp(await chef.connect(alice).harvest(0));

      const before = (RATE * (tSet - t0)) / 2n;
      const after = (RATE * (tH - tSet)) / 10n;
      expect(await a.balanceOf(alice.address)).to.equal(before + after);
    });

    it("there is no flag left to skip the update", async function () {
      const { chef } = await loadFixture(fixture);
      expect(chef.interface.getFunction("addPool")!.inputs.length).to.equal(2);
      expect(chef.interface.getFunction("setPool")!.inputs.length).to.equal(2);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("F4 (low): the owner cannot brick the farm with an out-of-range value", function () {
    it("rejects emission rates and allocations above the limits", async function () {
      const { chef, lp } = await loadFixture(fixture);
      const maxRate = await chef.MAX_EMISSION_PER_SECOND();
      const maxAlloc = await chef.MAX_ALLOC_POINT();
      await expect(chef.setEmissionRates(maxRate + 1n, 0)).to.be.revertedWithCustomError(chef, "ValueTooHigh");
      await expect(chef.setEmissionRates(0, maxRate + 1n)).to.be.revertedWithCustomError(chef, "ValueTooHigh");
      await expect(chef.addPool(maxAlloc + 1n, await lp.getAddress())).to.be.revertedWithCustomError(chef, "ValueTooHigh");
      await expect(chef.setPool(0, maxAlloc + 1n)).to.be.revertedWithCustomError(chef, "ValueTooHigh");
      await chef.setEmissionRates(maxRate, maxRate); // the limits themselves are allowed
    });

    it("rejects out-of-range rates at construction", async function () {
      const [owner] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
      const factory = await ethers.getContractFactory("CircleswapMasterChef");
      const tooHigh = 10n ** 36n + 1n;
      await expect(
        factory.deploy(owner.address, await a.getAddress(), await b.getAddress(), ethers.ZeroAddress, tooHigh, 1)
      ).to.be.revertedWithCustomError(factory, "ValueTooHigh");
    });

    it("harvest and withdraw keep working at the maximum rate and allocation over a decade", async function () {
      const { chef, alice, lp } = await loadFixture(fixture);
      const maxRate = await chef.MAX_EMISSION_PER_SECOND();
      await chef.setPool(0, await chef.MAX_ALLOC_POINT());
      await chef.setEmissionRates(maxRate, maxRate);
      await chef.connect(alice).deposit(0, 100n * E18);
      await time.increase(10 * 365 * 24 * 3600);
      await chef.connect(alice).harvest(0); // pays what the inventory holds; must not overflow
      await chef.connect(alice).withdraw(0, 100n * E18);
      expect(await lp.balanceOf(alice.address)).to.equal(1000n * E18);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("F5 (low): a boost source that cannot answer is refused up front", function () {
    it("the farm and the NFT both refuse a contract without the boost view", async function () {
      const [owner] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b, notQrb] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b"), await Mock.deploy("n", "n")];
      const chefFactory = await ethers.getContractFactory("CircleswapMasterChef");
      const nftFactory = await ethers.getContractFactory("QrbArtifactNFT");
      await expect(
        chefFactory.deploy(owner.address, await a.getAddress(), await b.getAddress(), await notQrb.getAddress(), 1, 1)
      ).to.be.revertedWithCustomError(chefFactory, "InvalidQrb");
      await expect(
        nftFactory.deploy(owner.address, owner.address, "https://arweave.net/" + "A".repeat(43), await notQrb.getAddress())
      ).to.be.revertedWithCustomError(nftFactory, "InvalidQrb");
    });
  });
});
