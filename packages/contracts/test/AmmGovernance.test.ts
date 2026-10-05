import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, deadline, deployAmm } from "./ammHelpers";

const DAY = 86_400;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = ethers.ZeroAddress;
const NO_PRED = ethers.ZeroHash;

/** Talks to the pool directly (no router, no factory registry): what a user does when everything else is down. */
async function poolDeposit(pair: any, who: any, A: any, B: any, x: bigint, y: bigint) {
  await A.connect(who).transfer(await pair.getAddress(), x);
  await B.connect(who).transfer(await pair.getAddress(), y);
  await pair.mint(who.address);
}
async function poolSwapAForB(pair: any, who: any, A: any, B: any, amountIn: bigint) {
  const [r0, r1] = await pair.getReserves();
  const aIs0 = (await pair.token0()) === (await A.getAddress());
  const [rin, rout] = aIs0 ? [r0, r1] : [r1, r0];
  const out = (amountIn * 997n * rout) / (rin * 1000n + amountIn * 997n);
  await A.connect(who).transfer(await pair.getAddress(), amountIn);
  await pair.swap(aIs0 ? 0n : out, aIs0 ? out : 0n, who.address, "0x");
}
const slotAddress = async (addr: string, slot: string) => ethers.getAddress("0x" + (await ethers.provider.getStorage(addr, slot)).slice(-40));

/**
 * The whole AMM governed the way it will be deployed: the factory and router proxies are owned by a timelock, the
 * deployer keeps nothing, and the proposer is a separate account standing in for the multisig.
 */
async function governed(delay = 2 * DAY) {
  const [deployer, proposer, alice, bob, attacker] = await ethers.getSigners();
  const timelock = await (await ethers.getContractFactory("CircleswapTimelock")).deploy(delay, [proposer.address], [ZERO]);
  const tlAddr = await timelock.getAddress();

  const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
  const Factory = await ethers.getContractFactory("CircleswapFactory");
  const Router = await ethers.getContractFactory("CircleswapRouter");
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const factoryImpl = await Factory.deploy();
  const factory = Factory.attach(
    await (await Proxy.deploy(await factoryImpl.getAddress(), Factory.interface.encodeFunctionData("initialize", [tlAddr]))).getAddress()
  ) as any;
  const routerImpl = await Router.deploy();
  const router = Router.attach(
    await (await Proxy.deploy(await routerImpl.getAddress(), Router.interface.encodeFunctionData("initialize", [await factory.getAddress(), await wquai.getAddress(), tlAddr]))).getAddress()
  ) as any;

  const Token = await ethers.getContractFactory("MockToken");
  const A = await Token.deploy("A", "A", 18);
  const B = await Token.deploy("B", "B", 18);
  for (const u of [alice, bob]) for (const t of [A, B]) {
    await t.mint(u.address, 1_000_000n * E18);
    await t.connect(u).approve(await router.getAddress(), ethers.MaxUint256);
  }
  // A pool with real liquidity, made through the router.
  await router.connect(alice).addLiquidity(await A.getAddress(), await B.getAddress(), 1000n * E18, 1000n * E18, 0, 0, alice.address, await deadline());
  const pair = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await B.getAddress()));
  const beacon = await ethers.getContractAt("UpgradeableBeacon", await factory.pairBeacon());

  /** Schedule one call from the proposer, wait the delay, execute it (by anyone). Returns the execute tx. */
  const viaTimelock = async (target: string, data: string, wait = delay, salt = ethers.id(String(Math.random()))) => {
    await timelock.connect(proposer).schedule(target, 0, data, NO_PRED, salt, delay);
    await time.increase(wait);
    return timelock.connect(attacker).execute(target, 0, data, NO_PRED, salt); // anyone may execute a ready operation
  };
  const schedule = (target: string, data: string, salt = ethers.id("s" + Math.random())) =>
    timelock.connect(proposer).schedule(target, 0, data, NO_PRED, salt, delay).then(() => salt);

  return { deployer, proposer, alice, bob, attacker, timelock, tlAddr, delay, wquai, factory, factoryImpl, router, routerImpl, A, B, pair, beacon, Factory, Router, viaTimelock, schedule };
}

describe("Circleswap governance: the owner cannot pull liquidity or ship a harmful upgrade", function () {
  describe("the timelock", function () {
    it("has no admin and no deployer privileges: nobody can bypass the delay", async function () {
      const { timelock, tlAddr, deployer, proposer, attacker } = await loadFixture(governed);
      const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
      expect(await timelock.hasRole(ADMIN, tlAddr)).to.equal(true); // only itself
      for (const who of [deployer, proposer, attacker]) expect(await timelock.hasRole(ADMIN, who.address)).to.equal(false);
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), proposer.address)).to.equal(true);
      expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), proposer.address)).to.equal(true);
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), deployer.address)).to.equal(false);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZERO)).to.equal(true); // open execution
    });

    it("refuses a delay outside 1..30 days, at deploy and when changed later", async function () {
      const [, proposer] = await ethers.getSigners();
      const T = await ethers.getContractFactory("CircleswapTimelock");
      await expect(T.deploy(DAY - 1, [proposer.address], [ZERO])).to.be.revertedWithCustomError(T, "DelayOutOfRange");
      await expect(T.deploy(31 * DAY, [proposer.address], [ZERO])).to.be.revertedWithCustomError(T, "DelayOutOfRange");
      await expect(T.deploy(0, [proposer.address], [ZERO])).to.be.revertedWithCustomError(T, "DelayOutOfRange");

      const { timelock, tlAddr, viaTimelock } = await loadFixture(governed);
      // Not even a scheduled operation can lower the delay below the floor.
      const data = timelock.interface.encodeFunctionData("updateDelay", [1]);
      await expect(viaTimelock(tlAddr, data)).to.be.reverted; // execution fails: the call reverts DelayOutOfRange
      expect(await timelock.getMinDelay()).to.equal(2 * DAY);
      // A legal change goes through, and takes a delay to arrive.
      await viaTimelock(tlAddr, timelock.interface.encodeFunctionData("updateDelay", [3 * DAY]));
      expect(await timelock.getMinDelay()).to.equal(3 * DAY);
    });

    it("only a proposer can schedule; an operation cannot run early; anyone can run it when ready", async function () {
      const { timelock, factory, factoryImpl, Factory, proposer, attacker, delay } = await loadFixture(governed);
      const data = Factory.interface.encodeFunctionData("setFeeTo", [attacker.address]);
      const target = await factory.getAddress();
      await expect(timelock.connect(attacker).schedule(target, 0, data, NO_PRED, ethers.id("x"), delay)).to.be.reverted;
      await expect(timelock.connect(proposer).schedule(target, 0, data, NO_PRED, ethers.id("x"), delay - 1)).to.be.reverted; // shorter than the minimum
      await timelock.connect(proposer).schedule(target, 0, data, NO_PRED, ethers.id("x"), delay);
      await expect(timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("x"))).to.be.reverted; // too early
      await time.increase(delay - 5);
      await expect(timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("x"))).to.be.reverted;
      await time.increase(10);
      await timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("x"));
      expect(await factory.feeTo()).to.equal(attacker.address);
      void factoryImpl;
    });

    it("a proposal can be cancelled before it runs, by a proposer only", async function () {
      const { timelock, factory, Factory, proposer, attacker, delay } = await loadFixture(governed);
      const data = Factory.interface.encodeFunctionData("setFeeTo", [attacker.address]);
      const target = await factory.getAddress();
      await timelock.connect(proposer).schedule(target, 0, data, NO_PRED, ethers.id("c"), delay);
      const id = await timelock.hashOperation(target, 0, data, NO_PRED, ethers.id("c"));
      await expect(timelock.connect(attacker).cancel(id)).to.be.reverted;
      await timelock.connect(proposer).cancel(id);
      await time.increase(delay + 1);
      await expect(timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("c"))).to.be.reverted;
      expect(await factory.feeTo()).to.equal(ZERO);
    });
  });

  describe("nobody but the timelock can do anything an owner can", function () {
    it("every owner-only function on the factory and router refuses everyone else, including the deployer and the proposer", async function () {
      const { factory, router, Factory, factoryImpl, routerImpl, deployer, proposer, attacker, pair, beacon } = await loadFixture(governed);
      const fImpl = await factoryImpl.getAddress();
      const rImpl = await routerImpl.getAddress();
      for (const who of [deployer, proposer, attacker]) {
        await expect(factory.connect(who).setFeeTo(who.address)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        await expect(factory.connect(who).setPairBeacon(await beacon.getAddress())).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        await expect(factory.connect(who).upgradePairImplementation(fImpl)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        await expect(factory.connect(who).freezePairUpgrades()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        await expect(factory.connect(who).upgradeToAndCall(fImpl, "0x")).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        await expect(router.connect(who).upgradeToAndCall(rImpl, "0x")).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
        await expect(beacon.connect(who).upgradeTo(fImpl)).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount");
        await expect(beacon.connect(who).renounceOwnership()).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount");
        await expect(beacon.connect(who).transferOwnership(who.address)).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount");
      }
      void Factory; void pair;
    });

    it("the pool beacon is owned by the factory, not by any person", async function () {
      const { beacon, factory, deployer, proposer } = await loadFixture(governed);
      expect(await beacon.owner()).to.equal(await factory.getAddress());
      expect(await beacon.owner()).to.not.equal(deployer.address);
      expect(await beacon.owner()).to.not.equal(proposer.address);
    });
  });

  describe("upgrades go through the delay and keep every balance", function () {
    it("a pool upgrade is announced, waits the delay, then moves every pool without touching reserves or LP balances", async function () {
      const { factory, pair, alice, A, B, timelock, delay, proposer, attacker, Factory } = await loadFixture(governed);
      const V2 = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      const v2 = await V2.getAddress();
      const reservesBefore = await pair.getReserves();
      const lpBefore = await pair.balanceOf(alice.address);
      const supplyBefore = await pair.totalSupply();

      const data = Factory.interface.encodeFunctionData("upgradePairImplementation", [v2]);
      const target = await factory.getAddress();
      await timelock.connect(proposer).schedule(target, 0, data, NO_PRED, ethers.id("u"), delay);
      // During the delay nothing has changed, and everyone can see exactly what is coming.
      expect(await factory.pairImplementation()).to.not.equal(v2);
      expect(await timelock.isOperationPending(await timelock.hashOperation(target, 0, data, NO_PRED, ethers.id("u")))).to.equal(true);
      await time.increase(delay + 1);
      await timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("u"));

      expect(await factory.pairImplementation()).to.equal(v2);
      const upgraded = await ethers.getContractAt("CircleswapPairV2", await pair.getAddress());
      expect(await upgraded.version()).to.equal("PairV2");
      const after = await upgraded.getReserves();
      expect(after[0]).to.equal(reservesBefore[0]);
      expect(after[1]).to.equal(reservesBefore[1]);
      expect(await upgraded.balanceOf(alice.address)).to.equal(lpBefore);
      expect(await upgraded.totalSupply()).to.equal(supplyBefore);
      void A; void B;
    });

    it("the factory and router can be upgraded only through the timelock, and keep their state", async function () {
      const { factory, router, viaTimelock, Factory, Router, A, B, wquai, tlAddr } = await loadFixture(governed);
      const fv2 = await (await ethers.getContractFactory("CircleswapFactoryV2")).deploy();
      const rv2 = await (await ethers.getContractFactory("CircleswapRouterV2")).deploy();
      const pairBefore = await factory.getPair(await A.getAddress(), await B.getAddress());
      await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [await fv2.getAddress(), "0x"]));
      await viaTimelock(await router.getAddress(), Router.interface.encodeFunctionData("upgradeToAndCall", [await rv2.getAddress(), "0x"]));
      expect(await slotAddress(await factory.getAddress(), IMPL_SLOT)).to.equal(await fv2.getAddress());
      expect(await slotAddress(await router.getAddress(), IMPL_SLOT)).to.equal(await rv2.getAddress());
      expect(await factory.getPair(await A.getAddress(), await B.getAddress())).to.equal(pairBefore);
      expect(await factory.owner()).to.equal(tlAddr);
      expect(await router.owner()).to.equal(tlAddr);
      expect(await router.factory()).to.equal(await factory.getAddress());
      expect(await router.WETH()).to.equal(await wquai.getAddress());
    });
  });

  describe("freezing pool upgrades: after it, no one can touch existing liquidity", function () {
    async function frozen() {
      const g = await governed();
      await g.viaTimelock(await g.factory.getAddress(), g.Factory.interface.encodeFunctionData("freezePairUpgrades"));
      return g;
    }

    it("renounces the beacon: its owner is nobody, and the flag says so", async function () {
      const { factory, beacon, pair } = await loadFixture(frozen);
      expect(await beacon.owner()).to.equal(ZERO);
      expect(await factory.pairUpgradesFrozen()).to.equal(true);
      // The pool follows exactly that beacon (its ERC-1967 beacon slot), so it is covered.
      expect(await slotAddress(await pair.getAddress(), BEACON_SLOT)).to.equal(await beacon.getAddress());
    });

    it("upgradePairImplementation and freeze both refuse, even for the timelock", async function () {
      const { factory, viaTimelock, Factory } = await loadFixture(frozen);
      const v2 = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradePairImplementation", [await v2.getAddress()]))).to.be.reverted;
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("freezePairUpgrades"))).to.be.reverted;
    });

    it("the beacon cannot be upgraded or re-owned by anyone: the factory, the timelock, a person", async function () {
      const { beacon, factory, tlAddr, viaTimelock, attacker } = await loadFixture(frozen);
      const v2 = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      await expect(beacon.connect(attacker).upgradeTo(await v2.getAddress())).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount");
      await expect(viaTimelock(await beacon.getAddress(), beacon.interface.encodeFunctionData("upgradeTo", [await v2.getAddress()]))).to.be.reverted;
      await expect(viaTimelock(await beacon.getAddress(), beacon.interface.encodeFunctionData("transferOwnership", [tlAddr]))).to.be.reverted;
      void factory;
    });

    it("a malicious factory upgrade cannot get the pools back: the beacon has no owner left to impersonate", async function () {
      const { factory, beacon, pair, viaTimelock, Factory, A, B, alice } = await loadFixture(frozen);
      // A factory that tries everything: takes the beacon, upgrades it, rewrites the registry.
      const Evil = await ethers.getContractFactory("EvilFactory");
      const evil = await Evil.deploy();
      await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [await evil.getAddress(), "0x"]));
      const evilFactory = await ethers.getContractAt("EvilFactory", await factory.getAddress());
      const rug = await (await ethers.getContractFactory("CircleswapPairRug")).deploy();
      expect(await evilFactory.attack.staticCall(await rug.getAddress())).to.equal(0); // every route to the beacon fails
      await evilFactory.attack(await rug.getAddress());
      expect(await beacon.owner()).to.equal(ZERO);
      expect(await beacon.implementation()).to.not.equal(await rug.getAddress());
      // The pool still works and still holds everything.
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(1000n * E18);
      expect(r1).to.equal(1000n * E18);
      await poolSwapAForB(pair, alice, A, B, E18);
      const lp = await pair.balanceOf(alice.address);
      await pair.connect(alice).transfer(await pair.getAddress(), lp);
      await pair.connect(alice).burn(alice.address); // and she can still leave with her share
      expect(await pair.balanceOf(alice.address)).to.equal(0n);
    });

    it("pools made later (from a new beacon) are a separate, opt-in version; the frozen ones are untouched", async function () {
      const { factory, beacon, pair, viaTimelock, Factory, router, alice, tlAddr } = await loadFixture(frozen);
      const Token = await ethers.getContractFactory("MockToken");
      const C = await Token.deploy("C", "C", 18);
      const D = await Token.deploy("D", "D", 18);
      for (const t of [C, D]) { await t.mint(alice.address, 1000n * E18); await t.connect(alice).approve(await router.getAddress(), ethers.MaxUint256); }

      // The owner (through the timelock) can start a new pool version for new pools only.
      const impl2 = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      const Beacon = await ethers.getContractFactory("UpgradeableBeacon");
      const beacon2 = await Beacon.deploy(await impl2.getAddress(), await factory.getAddress());
      await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("setPairBeacon", [await beacon2.getAddress()]));
      await router.connect(alice).addLiquidity(await C.getAddress(), await D.getAddress(), 10n * E18, 10n * E18, 0, 0, alice.address, await deadline());

      const newPool = await factory.getPair(await C.getAddress(), await D.getAddress());
      expect(await slotAddress(newPool, BEACON_SLOT)).to.equal(await beacon2.getAddress());
      expect(await slotAddress(await pair.getAddress(), BEACON_SLOT)).to.equal(await beacon.getAddress()); // old pool did not move
      expect(await beacon.owner()).to.equal(ZERO);
      void tlAddr;
    });

    it("freezing is irreversible by design even for the owner who set it", async function () {
      const { beacon, factory } = await loadFixture(frozen);
      expect(await factory.pairUpgradesFrozen()).to.equal(true);
      expect(await beacon.owner()).to.equal(ZERO);
    });
  });

  describe("before the freeze, a malicious pool upgrade is visible and cancellable, and cannot run early", function () {
    it("a rug implementation queued by a compromised proposer is public for the whole delay and can be cancelled", async function () {
      const { factory, pair, timelock, proposer, attacker, delay, Factory, alice } = await loadFixture(governed);
      const rug = await (await ethers.getContractFactory("CircleswapPairRug")).deploy();
      const data = Factory.interface.encodeFunctionData("upgradePairImplementation", [await rug.getAddress()]);
      const target = await factory.getAddress();
      await timelock.connect(proposer).schedule(target, 0, data, NO_PRED, ethers.id("rug"), delay);
      const id = await timelock.hashOperation(target, 0, data, NO_PRED, ethers.id("rug"));

      // The queue is on chain: anyone watching sees the target, the call and the time it becomes ready.
      expect(await timelock.isOperationPending(id)).to.equal(true);
      expect(await timelock.getTimestamp(id)).to.be.greaterThan(await time.latest());
      // Liquidity providers have the whole delay to leave, and they can: exits do not depend on the owner.
      const lp = await pair.balanceOf(alice.address);
      await pair.connect(alice).transfer(await pair.getAddress(), lp);
      await pair.connect(alice).burn(alice.address);
      // And it cannot run early.
      await time.increase(delay - 60);
      await expect(timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("rug"))).to.be.reverted;
      // The guardian (a proposer) withdraws it.
      await timelock.connect(proposer).cancel(id);
      await time.increase(120);
      await expect(timelock.connect(attacker).execute(target, 0, data, NO_PRED, ethers.id("rug"))).to.be.reverted;
      expect(await factory.pairImplementation()).to.not.equal(await rug.getAddress());
    });
  });

  describe("a hostile factory upgrade cannot lock liquidity providers in", function () {
    // Pools ask the factory for feeTo() on every mint and burn. If that call could revert, burn all gas or return a
    // huge payload, upgrading the factory would be enough to stop every withdrawal. It must not be.
    const MODES = { REVERT: 1, BURN_GAS: 2, HUGE_REPLY: 3, SHORT_REPLY: 4, GARBAGE_ADDRESS: 5 };
    for (const [name, mode] of Object.entries(MODES)) {
      it(`feeTo() that does ${name}: deposits, swaps and full withdrawals still work`, async function () {
        const { factory, viaTimelock, Factory, pair, alice, bob, A, B } = await loadFixture(governed);
        const evilImpl = await (await ethers.getContractFactory("EvilFactory")).deploy();
        await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [await evilImpl.getAddress(), "0x"]));
        const evil = await ethers.getContractAt("EvilFactory", await factory.getAddress());
        await evil.setMode(mode, ethers.ZeroAddress);

        // A new deposit (mint), a swap, and the first LP leaving completely (burn).
        await poolDeposit(pair, bob, A, B, 100n * E18, 100n * E18);
        await poolSwapAForB(pair, bob, A, B, E18);
        const aliceA = await A.balanceOf(alice.address);
        const lp = await pair.balanceOf(alice.address);
        await pair.connect(alice).transfer(await pair.getAddress(), lp);
        await pair.connect(alice).burn(alice.address);
        expect(await A.balanceOf(alice.address)).to.be.greaterThan(aliceA + 900n * E18); // got her side of the pool back
        expect(await pair.balanceOf(alice.address)).to.equal(0n);
      });
    }

    it("the worst a hostile factory can do to a pool is switch on the protocol fee, which is bounded and was always an owner power", async function () {
      const { factory, viaTimelock, Factory, pair, alice, bob, A, B, attacker } = await loadFixture(governed);
      const evilImpl = await (await ethers.getContractFactory("EvilFactory")).deploy();
      await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [await evilImpl.getAddress(), "0x"]));
      const evil = await ethers.getContractAt("EvilFactory", await factory.getAddress());
      await evil.setMode(0, attacker.address); // honest reply, but pointing the fee at the attacker
      await poolDeposit(pair, bob, A, B, 100n * E18, 100n * E18);
      for (let i = 0; i < 5; i++) {
        await poolSwapAForB(pair, bob, A, B, 50n * E18);
        await poolSwapAForB(pair, bob, B, A, 50n * E18);
      }
      await poolDeposit(pair, bob, A, B, 1n * E18, 1n * E18); // triggers the fee mint
      const stolen = await pair.balanceOf(attacker.address);
      const supply = await pair.totalSupply();
      expect(stolen).to.be.greaterThan(0n);
      // At most one sixth of the swap-fee growth (0.05% of volume): well under 1% of the pool here, never the reserves.
      expect((stolen * 10_000n) / supply).to.be.lessThan(100n);
      expect(await pair.balanceOf(alice.address)).to.be.greaterThan(0n);
    });
  });

  describe("making the router and factory permanent", function () {
    it("renouncing ownership through the timelock freezes the code forever", async function () {
      const { factory, router, viaTimelock, Factory, Router, tlAddr } = await loadFixture(governed);
      const fv2 = await (await ethers.getContractFactory("CircleswapFactoryV2")).deploy();
      const rv2 = await (await ethers.getContractFactory("CircleswapRouterV2")).deploy();
      await viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("renounceOwnership"));
      await viaTimelock(await router.getAddress(), Router.interface.encodeFunctionData("renounceOwnership"));
      expect(await factory.owner()).to.equal(ZERO);
      expect(await router.owner()).to.equal(ZERO);
      await expect(factory.upgradeToAndCall(await fv2.getAddress(), "0x")).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(router.upgradeToAndCall(await rv2.getAddress(), "0x")).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
      void tlAddr;
    });
  });

  describe("the pool-version functions report exactly why they refuse", function () {
    it("after freezing, upgrading or freezing again names the cause", async function () {
      const { factory, owner } = await deployAmm();
      const v2 = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      await factory.connect(owner).freezePairUpgrades();
      await expect(factory.connect(owner).upgradePairImplementation(await v2.getAddress())).to.be.revertedWithCustomError(factory, "PairUpgradesAlreadyFrozen");
      await expect(factory.connect(owner).freezePairUpgrades()).to.be.revertedWithCustomError(factory, "PairUpgradesAlreadyFrozen");
    });

    it("an implementation with no code is refused before the beacon is touched", async function () {
      const { factory, owner, alice } = await deployAmm();
      await expect(factory.connect(owner).upgradePairImplementation(alice.address)).to.be.revertedWithCustomError(factory, "InvalidImplementation");
      await expect(factory.connect(owner).upgradePairImplementation(ZERO)).to.be.revertedWithCustomError(factory, "InvalidImplementation");
    });

    it("a new pool version cannot be handed to a person: setPairBeacon only accepts a beacon the factory owns", async function () {
      const { factory, owner } = await deployAmm();
      const impl = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      const Beacon = await ethers.getContractFactory("UpgradeableBeacon");
      const personal = await Beacon.deploy(await impl.getAddress(), owner.address);
      await expect(factory.connect(owner).setPairBeacon(await personal.getAddress())).to.be.revertedWithCustomError(factory, "BeaconNotOwnedByFactory");
      const renounced = await Beacon.deploy(await impl.getAddress(), await factory.getAddress());
      const ok = await factory.connect(owner).setPairBeacon(await renounced.getAddress());
      await expect(ok).to.emit(factory, "PairBeaconUpdated");
    });
  });

  describe("proxy hygiene", function () {
    it("implementations are locked, proxies cannot be initialised twice, and no admin slot is set", async function () {
      const { factory, router, factoryImpl, routerImpl, attacker, wquai } = await loadFixture(governed);
      await expect(factoryImpl.initialize(attacker.address)).to.be.revertedWithCustomError(factoryImpl, "InvalidInitialization");
      await expect(routerImpl.initialize(await factory.getAddress(), await wquai.getAddress(), attacker.address)).to.be.revertedWithCustomError(routerImpl, "InvalidInitialization");
      await expect(factory.initialize(attacker.address)).to.be.revertedWithCustomError(factory, "InvalidInitialization");
      await expect(router.initialize(await factory.getAddress(), await wquai.getAddress(), attacker.address)).to.be.revertedWithCustomError(router, "InvalidInitialization");
      expect(await ethers.provider.getStorage(await factory.getAddress(), "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103")).to.equal(ethers.ZeroHash);
    });

    it("an upgrade to something that is not a UUPS implementation is refused, so the proxy cannot be bricked", async function () {
      const { viaTimelock, factory, router, Factory, wquai } = await loadFixture(governed);
      const notUups = await wquai.getAddress();
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [notUups, "0x"]))).to.be.reverted;
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("upgradeToAndCall", [ethers.ZeroAddress, "0x"]))).to.be.reverted;
      void router;
    });

    it("setPairBeacon refuses a non-beacon or a beacon with no implementation", async function () {
      const { viaTimelock, factory, Factory, A } = await loadFixture(governed);
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("setPairBeacon", [await A.getAddress()]))).to.be.reverted; // a token, not a beacon
      await expect(viaTimelock(await factory.getAddress(), Factory.interface.encodeFunctionData("setPairBeacon", [ethers.ZeroAddress]))).to.be.reverted;
    });
  });
});
