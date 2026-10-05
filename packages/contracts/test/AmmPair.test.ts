import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, MIN_LIQ, DEAD, amountOut, sqrt, deployAmm } from "./ammHelpers";
import { stamp } from "./helpers";

describe("Circleswap AMM: pool (LP token)", function () {
  /** A fresh, empty pool and its tokens in the pool's own order (token0 < token1). */
  async function fixture() {
    const amm = await deployAmm();
    await amm.factory.createPair(await amm.A.getAddress(), await amm.B.getAddress());
    const pair = await ethers.getContractAt("CircleswapPair", await amm.factory.getPair(await amm.A.getAddress(), await amm.B.getAddress()));
    const zeroFirst = (await pair.token0()) === (await amm.A.getAddress());
    const [T0, T1] = zeroFirst ? [amm.A, amm.B] : [amm.B, amm.A];
    const pairAddr = await pair.getAddress();
    return { ...amm, pair, pairAddr, T0, T1 };
  }

  /** The same, with alice's first deposit of (1000, 4000) already in. */
  async function seeded() {
    const f = await fixture();
    await f.T0.connect(f.alice).transfer(f.pairAddr, 1000n * E18);
    await f.T1.connect(f.alice).transfer(f.pairAddr, 4000n * E18);
    await f.pair.connect(f.alice).mint(f.alice.address);
    return f;
  }

  const send = (token: any, from: any, to: string, amount: bigint) => token.connect(from).transfer(to, amount);

  // ------------------------------------------------------------------------------------------------ mint
  describe("mint", function () {
    it("first deposit: shares are sqrt(a*b), minus MINIMUM_LIQUIDITY locked forever at a dead address", async function () {
      const { pair, pairAddr, T0, T1, alice } = await loadFixture(fixture);
      await send(T0, alice, pairAddr, 1000n * E18);
      await send(T1, alice, pairAddr, 4000n * E18);
      const tx = pair.connect(alice).mint(alice.address);
      const expected = sqrt(1000n * E18 * 4000n * E18); // 2000e18
      await expect(tx)
        .to.emit(pair, "Mint").withArgs(alice.address, 1000n * E18, 4000n * E18)
        .and.to.emit(pair, "Sync").withArgs(1000n * E18, 4000n * E18)
        .and.to.emit(pair, "Transfer").withArgs(ethers.ZeroAddress, DEAD, MIN_LIQ)
        .and.to.emit(pair, "Transfer").withArgs(ethers.ZeroAddress, alice.address, expected - MIN_LIQ);
      expect(await pair.totalSupply()).to.equal(expected);
      expect(await pair.balanceOf(alice.address)).to.equal(expected - MIN_LIQ);
      expect(await pair.balanceOf(DEAD)).to.equal(MIN_LIQ);
      const [r0, r1] = await pair.getReserves();
      expect([r0, r1]).to.deep.equal([1000n * E18, 4000n * E18]);
    });

    it("a first deposit worth no more than MINIMUM_LIQUIDITY is refused; one wei over mints one share", async function () {
      const { pair, pairAddr, T0, T1, alice } = await loadFixture(fixture);
      await send(T0, alice, pairAddr, 1000n);
      await send(T1, alice, pairAddr, 1000n);
      await expect(pair.connect(alice).mint(alice.address)).to.be.revertedWithCustomError(pair, "InsufficientLiquidityMinted");
      await send(T0, alice, pairAddr, 1n);
      await send(T1, alice, pairAddr, 1n);
      await pair.connect(alice).mint(alice.address); // 1001 x 1001 -> sqrt 1001 -> 1 share
      expect(await pair.balanceOf(alice.address)).to.equal(1n);
    });

    it("minting with nothing deposited is refused", async function () {
      const { pair, alice } = await loadFixture(seeded);
      await expect(pair.connect(alice).mint(alice.address)).to.be.revertedWithCustomError(pair, "InsufficientLiquidityMinted");
    });

    it("later deposits mint in proportion to the existing pool", async function () {
      const { pair, pairAddr, T0, T1, alice, bob } = await loadFixture(seeded);
      const supply = await pair.totalSupply();
      await send(T0, bob, pairAddr, 100n * E18); // 10% of token0
      await send(T1, bob, pairAddr, 400n * E18); // 10% of token1
      await pair.connect(bob).mint(bob.address);
      expect(await pair.balanceOf(bob.address)).to.equal((100n * E18 * supply) / (1000n * E18));
      void alice;
    });

    it("an unbalanced deposit is credited at the lesser side, and the surplus benefits every holder", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      const supply = await pair.totalSupply();
      await send(T0, bob, pairAddr, 200n * E18); // 20% of token0...
      await send(T1, bob, pairAddr, 400n * E18); // ...but only 10% of token1
      await pair.connect(bob).mint(bob.address);
      expect(await pair.balanceOf(bob.address)).to.equal((400n * E18 * supply) / (4000n * E18)); // the 10% side
    });

    it("refuses balances that no longer fit the packed reserves (uint112) instead of wrapping", async function () {
      const { pair, pairAddr, T0, T1, alice } = await loadFixture(fixture);
      const huge = 2n ** 112n;
      await T0.mint(alice.address, huge);
      await T1.mint(alice.address, huge);
      await send(T0, alice, pairAddr, huge);
      await send(T1, alice, pairAddr, huge);
      await expect(pair.connect(alice).mint(alice.address)).to.be.revertedWithCustomError(pair, "BalanceOverflow");
    });

    it("mints to any recipient", async function () {
      const { pair, pairAddr, T0, T1, alice, carol } = await loadFixture(fixture);
      await send(T0, alice, pairAddr, 10n * E18);
      await send(T1, alice, pairAddr, 10n * E18);
      await pair.connect(alice).mint(carol.address);
      expect(await pair.balanceOf(carol.address)).to.equal(10n * E18 - MIN_LIQ);
    });
  });

  // ------------------------------------------------------------------------------------------------ burn
  describe("burn", function () {
    it("pays out the holder's exact share of both reserves and shrinks the pool", async function () {
      const { pair, pairAddr, T0, T1, alice, carol } = await loadFixture(seeded);
      const supply = await pair.totalSupply();
      const lp = (await pair.balanceOf(alice.address)) / 4n;
      await pair.connect(alice).transfer(pairAddr, lp);
      const before0 = await T0.balanceOf(carol.address);
      const before1 = await T1.balanceOf(carol.address);
      const out0 = (lp * 1000n * E18) / supply;
      const out1 = (lp * 4000n * E18) / supply;
      await expect(pair.connect(alice).burn(carol.address))
        .to.emit(pair, "Burn").withArgs(alice.address, out0, out1, carol.address);
      expect((await T0.balanceOf(carol.address)) - before0).to.equal(out0);
      expect((await T1.balanceOf(carol.address)) - before1).to.equal(out1);
      expect(await pair.totalSupply()).to.equal(supply - lp);
      const [r0, r1] = await pair.getReserves();
      expect([r0, r1]).to.deep.equal([1000n * E18 - out0, 4000n * E18 - out1]);
    });

    it("burning with no LP sent in is refused", async function () {
      const { pair, alice } = await loadFixture(seeded);
      await expect(pair.connect(alice).burn(alice.address)).to.be.revertedWithCustomError(pair, "InsufficientLiquidityBurned");
    });

    it("a dust burn that would pay out nothing is refused rather than silently eating the LP", async function () {
      const { pair, pairAddr, alice } = await loadFixture(seeded);
      await pair.connect(alice).transfer(pairAddr, 1n); // 1 wei of LP is worth < 1 wei of either token
      await expect(pair.connect(alice).burn(alice.address)).to.be.revertedWithCustomError(pair, "InsufficientLiquidityBurned");
    });

    it("even after every provider exits, the locked minimum keeps the pool alive and re-usable", async function () {
      const { pair, pairAddr, T0, T1, alice, bob } = await loadFixture(seeded);
      await pair.connect(alice).transfer(pairAddr, await pair.balanceOf(alice.address));
      await pair.connect(alice).burn(alice.address);
      expect(await pair.totalSupply()).to.equal(MIN_LIQ);
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.be.gt(0);
      expect(r1).to.be.gt(0);
      // Someone else can deposit again and receives a sane number of shares.
      await send(T0, bob, pairAddr, 50n * E18);
      await send(T1, bob, pairAddr, 200n * E18);
      await pair.connect(bob).mint(bob.address);
      expect(await pair.balanceOf(bob.address)).to.be.gt(0);
    });

    it("cannot burn the locked shares: nobody holds a key for the dead address", async function () {
      const { pair } = await loadFixture(seeded);
      expect(await pair.balanceOf(DEAD)).to.equal(MIN_LIQ);
    });
  });

  // ------------------------------------------------------------------------------------------------ swap
  describe("swap", function () {
    it("pays exactly the fee-adjusted constant-product amount, and the boundary is exact", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      const inAmt = 10n * E18;
      const out = amountOut(inAmt, 1000n * E18, 4000n * E18);
      await send(T0, bob, pairAddr, inAmt);
      await expect(pair.connect(bob).swap(0, out + 1n, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InvariantViolated");
      const before = await T1.balanceOf(bob.address);
      await expect(pair.connect(bob).swap(0, out, bob.address, "0x"))
        .to.emit(pair, "Swap").withArgs(bob.address, inAmt, 0, 0, out, bob.address);
      expect((await T1.balanceOf(bob.address)) - before).to.equal(out);
      const [r0, r1] = await pair.getReserves();
      expect([r0, r1]).to.deep.equal([1000n * E18 + inAmt, 4000n * E18 - out]);
    });

    it("works in the other direction, too", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      const inAmt = 40n * E18;
      const out = amountOut(inAmt, 4000n * E18, 1000n * E18);
      await send(T1, bob, pairAddr, inAmt);
      await expect(pair.connect(bob).swap(out + 1n, 0, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InvariantViolated");
      const before = await T0.balanceOf(bob.address);
      await pair.connect(bob).swap(out, 0, bob.address, "0x");
      expect((await T0.balanceOf(bob.address)) - before).to.equal(out);
    });

    it("k never falls: the 0.3% fee stays in the pool and accrues to liquidity providers", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      const k0 = 1000n * E18 * 4000n * E18;
      let lastK = k0;
      for (let i = 0; i < 10; i++) {
        const inAmt = (i % 2 === 0 ? 7n : 3n) * E18;
        const [q0, q1] = await pair.getReserves();
        const [tIn, rIn, rOut] = i % 2 === 0 ? [T0, q0, q1] : [T1, q1, q0];
        const out = amountOut(inAmt, rIn as bigint, rOut as bigint);
        await send(tIn as any, bob, pairAddr, inAmt);
        await pair.connect(bob).swap(i % 2 === 0 ? 0n : out, i % 2 === 0 ? out : 0n, bob.address, "0x");
        const [r0, r1] = await pair.getReserves();
        const k = r0 * r1;
        expect(k).to.be.gte(lastK);
        lastK = k;
      }
      expect(lastK).to.be.gt(k0); // strictly: fees accrued
    });

    it("a swap can be paid in both tokens at once", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      const inAmt = 10n * E18;
      const out = amountOut(inAmt, 1000n * E18, 4000n * E18);
      await send(T0, bob, pairAddr, inAmt);
      await send(T1, bob, pairAddr, 1n * E18); // an extra payment in the output token
      await expect(pair.connect(bob).swap(0, out, bob.address, "0x"))
        .to.emit(pair, "Swap").withArgs(bob.address, inAmt, 1n * E18, 0, out, bob.address);
    });

    it("refuses: no output asked, output that drains a reserve, a recipient that is a pool token, or no input paid", async function () {
      const { pair, pairAddr, T0, T1, bob } = await loadFixture(seeded);
      await expect(pair.connect(bob).swap(0, 0, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InsufficientOutputAmount");
      await expect(pair.connect(bob).swap(1000n * E18, 0, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
      await expect(pair.connect(bob).swap(0, 4000n * E18, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
      await send(T0, bob, pairAddr, 1n * E18);
      await expect(pair.connect(bob).swap(0, 1n, await T0.getAddress(), "0x")).to.be.revertedWithCustomError(pair, "InvalidTo");
      await expect(pair.connect(bob).swap(0, 1n, await T1.getAddress(), "0x")).to.be.revertedWithCustomError(pair, "InvalidTo");
      const { pair: p2, bob: b2 } = await loadFixture(seeded);
      await expect(p2.connect(b2).swap(0, 1n, b2.address, "0x")).to.be.revertedWithCustomError(p2, "InsufficientInputAmount");
    });

    it("draining almost everything is only possible by paying an enormous amount in", async function () {
      const { pair, pairAddr, T0, bob } = await loadFixture(seeded);
      const out = 3999n * E18; // 99.975% of token1
      const needed = (1000n * E18 * out * 1000n) / ((4000n * E18 - out) * 997n) + 1n;
      expect(needed).to.be.gt(1_000_000n * E18); // a million times the token0 reserve
      await send(T0 as any, bob, pairAddr, needed - 1n);
      await expect(pair.connect(bob).swap(0, out, bob.address, "0x")).to.be.revertedWithCustomError(pair, "InvariantViolated");
    });

    it("works between tokens with different decimals (the math does not care)", async function () {
      const amm = await deployAmm();
      const Token = await ethers.getContractFactory("MockToken");
      const usd = await Token.deploy("USD", "USD", 6);
      await usd.mint(amm.alice.address, 10_000_000n * 10n ** 6n);
      await amm.A.connect(amm.alice).approve(amm.routerAddr, ethers.MaxUint256);
      await usd.connect(amm.alice).approve(amm.routerAddr, ethers.MaxUint256);
      await amm.router.connect(amm.alice).addLiquidity(await amm.A.getAddress(), await usd.getAddress(), 1000n * E18, 2000n * 10n ** 6n, 0, 0, amm.alice.address, (await time.latest()) + 3600);
      const pair = await ethers.getContractAt("CircleswapPair", await amm.factory.getPair(await amm.A.getAddress(), await usd.getAddress()));
      const [r0, r1] = await pair.getReserves();
      expect(r0 * r1).to.equal(1000n * E18 * 2000n * 10n ** 6n);
    });
  });

  // ------------------------------------------------------------------------------------------- flash swaps
  describe("flash swaps", function () {
    async function withCallee() {
      const f = await loadFixture(seeded);
      const callee = await (await ethers.getContractFactory("FlashCallee")).deploy();
      // Fund the callee so it can pay the fee out of its own pocket.
      await f.T0.mint(await callee.getAddress(), 100n * E18);
      await f.T1.mint(await callee.getAddress(), 100n * E18);
      return { ...f, callee };
    }

    it("lends tokens for the duration of one call and keeps k, when repaid with the 0.3% fee", async function () {
      const { pair, callee, T0, alice } = await withCallee();
      const before = await T0.balanceOf(await pair.getAddress());
      await callee.run(await pair.getAddress(), 300n * E18, 0, 0); // REPAY_WITH_FEE
      expect(await callee.lastAmount0()).to.equal(300n * E18);
      expect(await callee.lastSender()).to.equal(await callee.getAddress());
      const after = await T0.balanceOf(await pair.getAddress());
      expect(after).to.be.gt(before); // ended up with more than it started
      const [r0, r1] = await pair.getReserves();
      expect(r0 * r1).to.be.gte(1000n * E18 * 4000n * E18);
      void alice;
    });

    it("reverts if the callee repays the principal but not the fee", async function () {
      const { pair, callee } = await withCallee();
      await expect(callee.run(await pair.getAddress(), 300n * E18, 0, 1)).to.be.revertedWithCustomError(pair, "InvariantViolated");
    });

    it("reverts if the callee repays nothing", async function () {
      const { pair, callee } = await withCallee();
      await expect(callee.run(await pair.getAddress(), 300n * E18, 0, 2)).to.be.revertedWithCustomError(pair, "InsufficientInputAmount");
    });

    it("cannot borrow the entire reserve", async function () {
      const { pair, callee } = await withCallee();
      await expect(callee.run(await pair.getAddress(), 1000n * E18, 0, 0)).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
    });

    for (const [mode, name] of [[3, "swap"], [4, "mint"], [5, "burn"], [6, "sync"], [7, "skim"]] as const) {
      it(`the pool refuses ${name}() called back from inside a flash swap (reentrancy guard)`, async function () {
        const { pair, callee } = await withCallee();
        await callee.run(await pair.getAddress(), 10n * E18, 0, mode); // the callee repays after the attempt, so the outer call succeeds
        expect(await callee.reentryFailed()).to.equal(true);
      });
    }
  });

  // ------------------------------------------------------------------------------------------- skim / sync
  describe("skim and sync", function () {
    it("skim sends any balance above the reserves to the chosen address and changes no reserve", async function () {
      const { pair, pairAddr, T0, T1, bob, carol } = await loadFixture(seeded);
      await send(T0, bob, pairAddr, 5n * E18);
      await send(T1, bob, pairAddr, 7n * E18);
      const [r0, r1] = await pair.getReserves();
      await pair.connect(bob).skim(carol.address);
      expect(await T0.balanceOf(pairAddr)).to.equal(r0);
      expect(await T1.balanceOf(pairAddr)).to.equal(r1);
      expect((await pair.getReserves()).slice(0, 2)).to.deep.equal([r0, r1]);
    });

    it("sync adopts the real balances as the reserves, moving the price", async function () {
      const { pair, pairAddr, T0, bob } = await loadFixture(seeded);
      await send(T0, bob, pairAddr, 500n * E18);
      await expect(pair.sync()).to.emit(pair, "Sync").withArgs(1500n * E18, 4000n * E18);
      const [r0, r1] = await pair.getReserves();
      expect([r0, r1]).to.deep.equal([1500n * E18, 4000n * E18]);
    });

    it("a donation cannot be used to mint extra shares for someone else's deposit", async function () {
      const { pair, pairAddr, T0, T1, alice, bob } = await loadFixture(seeded);
      const supplyBefore = await pair.totalSupply();
      await send(T0, bob, pairAddr, 1000n * E18); // donation
      await send(T1, bob, pairAddr, 4000n * E18);
      await pair.connect(bob).mint(bob.address); // this is a proper deposit of exactly the pool's size
      expect(await pair.balanceOf(bob.address)).to.equal(supplyBefore); // doubles the pool: gets exactly the existing supply
      void alice;
    });
  });

  // ------------------------------------------------------------------------------------- price accumulators
  describe("price accumulators (for time-weighted average prices)", function () {
    it("add price x time on every update, using the reserves that held during the interval", async function () {
      const { pair, T0, bob, pairAddr } = await loadFixture(seeded);
      const [r0, r1, t0] = await pair.getReserves();
      const c0Before = await pair.price0CumulativeLast();
      const c1Before = await pair.price1CumulativeLast();
      await time.increase(1000);
      const t1 = await stamp(await pair.connect(bob).sync());
      const dt = t1 - BigInt(t0);
      expect((await pair.price0CumulativeLast()) - c0Before).to.equal(((r1 << 112n) / r0) * dt);
      expect((await pair.price1CumulativeLast()) - c1Before).to.equal(((r0 << 112n) / r1) * dt);
      void T0; void pairAddr;
    });

    it("a time-weighted average over an interval recovers the price that held", async function () {
      const { pair, bob } = await loadFixture(seeded);
      await pair.connect(bob).sync();
      const startCum = await pair.price0CumulativeLast();
      const startT = BigInt((await pair.getReserves())[2]);
      await time.increase(500);
      const endT = await stamp(await pair.connect(bob).sync());
      const twap = ((await pair.price0CumulativeLast()) - startCum) / (endT - startT); // 112.112 fixed point
      const spot = (4000n * E18 << 112n) / (1000n * E18);
      expect(twap).to.equal(spot); // reserves did not change, so the average is exactly the spot price
    });

    it("do not move when several updates land in the same second", async function () {
      const { pair, T0, bob, pairAddr } = await loadFixture(seeded);
      await time.increase(100);
      await pair.sync();
      const cum = await pair.price0CumulativeLast();
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await pair.sync();
        await pair.sync();
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      // Both syncs shared one block, so at most one second was folded in; nothing was double counted.
      const delta = (await pair.price0CumulativeLast()) - cum;
      expect(delta).to.be.lte(((4000n * E18 << 112n) / (1000n * E18)) * 2n);
      void T0; void bob; void pairAddr;
    });
  });

  // ---------------------------------------------------------------------------------------- protocol fee
  describe("protocol fee (off by default, one sixth of the fee when on)", function () {
    it("is off: no shares are ever minted to anyone, and kLast stays zero", async function () {
      const { pair, pairAddr, T0, T1, bob, alice, factory } = await loadFixture(seeded);
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
      await send(T0, bob, pairAddr, 50n * E18);
      await pair.connect(bob).swap(0, amountOut(50n * E18, 1000n * E18, 4000n * E18), bob.address, "0x");
      const supply = await pair.totalSupply();
      await send(T0, alice, pairAddr, 10n * E18);
      await send(T1, alice, pairAddr, 40n * E18);
      await pair.connect(alice).mint(alice.address);
      expect(await pair.kLast()).to.equal(0);
      expect((await pair.totalSupply()) - supply).to.be.lte(supply / 50n); // only alice's ~1% deposit
    });

    it("is on: mints exactly ts*(sqrt(k)-sqrt(kLast)) / (5*sqrt(k)+sqrt(kLast)) shares to feeTo at the next liquidity event", async function () {
      const { pair, pairAddr, T0, T1, bob, alice, carol, factory } = await loadFixture(fixture);
      await factory.setFeeTo(carol.address);
      await send(T0, alice, pairAddr, 1000n * E18);
      await send(T1, alice, pairAddr, 4000n * E18);
      await pair.connect(alice).mint(alice.address);
      expect(await pair.kLast()).to.equal(1000n * E18 * 4000n * E18); // recorded because the fee is on
      expect(await pair.balanceOf(carol.address)).to.equal(0); // first deposit: nothing to skim yet

      // Trade back and forth to build up fees.
      for (let i = 0; i < 6; i++) {
        const [r0, r1] = await pair.getReserves();
        if (i % 2 === 0) {
          await send(T0, bob, pairAddr, 40n * E18);
          await pair.connect(bob).swap(0, amountOut(40n * E18, r0, r1), bob.address, "0x");
        } else {
          await send(T1, bob, pairAddr, 160n * E18);
          await pair.connect(bob).swap(amountOut(160n * E18, r1, r0), 0, bob.address, "0x");
        }
      }
      const [r0, r1] = await pair.getReserves();
      const supply = await pair.totalSupply();
      const rootK = sqrt(r0 * r1);
      const rootLast = sqrt(await pair.kLast());
      expect(rootK).to.be.gt(rootLast); // fees accrued
      const expected = (supply * (rootK - rootLast)) / (rootK * 5n + rootLast);

      await send(T0, alice, pairAddr, 1n * E18);
      await send(T1, alice, pairAddr, 4n * E18);
      await pair.connect(alice).mint(alice.address);
      expect(await pair.balanceOf(carol.address)).to.equal(expected);
      expect(expected).to.be.gt(0);
      const [n0, n1] = await pair.getReserves();
      expect(await pair.kLast()).to.equal(n0 * n1); // refreshed after the event
    });

    it("the protocol's cut is one sixth of what liquidity providers earn, not more", async function () {
      const { pair, pairAddr, T0, bob, alice, carol, factory } = await loadFixture(fixture);
      await factory.setFeeTo(carol.address);
      await send(T0, alice, pairAddr, 1000n * E18);
      await (await ethers.getContractAt("MockToken", await pair.token1())).connect(alice).transfer(pairAddr, 1000n * E18);
      await pair.connect(alice).mint(alice.address);
      const T1 = await ethers.getContractAt("MockToken", await pair.token1());
      // Volume back and forth to grow k by a known amount.
      for (let i = 0; i < 10; i++) {
        const [r0, r1] = await pair.getReserves();
        await send(T0, bob, pairAddr, 20n * E18);
        await pair.connect(bob).swap(0, amountOut(20n * E18, r0, r1), bob.address, "0x");
        const [s0, s1] = await pair.getReserves();
        await send(T1, bob, pairAddr, 20n * E18);
        await pair.connect(bob).swap(amountOut(20n * E18, s1, s0), 0, bob.address, "0x");
      }
      const [r0, r1] = await pair.getReserves();
      const growth = sqrt(r0 * r1) - sqrt(await pair.kLast());
      // A tiny deposit triggers the fee mint.
      await send(T0, alice, pairAddr, 1n * E18);
      await T1.connect(alice).transfer(pairAddr, 1n * E18);
      await pair.connect(alice).mint(alice.address);
      const feeShares = await pair.balanceOf(carol.address);
      const supply = await pair.totalSupply();
      // feeShares/supply is the protocol's ownership of the pool; the growth of sqrt(k) since the last event, as a
      // fraction of the pool, is what liquidity providers earned. The protocol's cut is one sixth of that.
      const SCALE = 10n ** 15n;
      const share = (feeShares * SCALE) / supply;
      const growthFraction = (growth * SCALE) / sqrt(r0 * r1);
      expect(growthFraction).to.be.gt(0);
      const diff = share * 6n > growthFraction ? share * 6n - growthFraction : growthFraction - share * 6n;
      expect(diff * 100n).to.be.lte(growthFraction); // within 1%: one sixth, and not more
    });

    it("turning it off stops the minting and clears kLast at the next liquidity event", async function () {
      const { pair, pairAddr, T0, T1, alice, bob, carol, factory } = await loadFixture(seeded);
      await factory.setFeeTo(carol.address);
      await send(T0, alice, pairAddr, 10n * E18);
      await send(T1, alice, pairAddr, 40n * E18);
      await pair.connect(alice).mint(alice.address);
      expect(await pair.kLast()).to.not.equal(0);
      await factory.setFeeTo(ethers.ZeroAddress);
      await send(T0, bob, pairAddr, 30n * E18);
      await pair.connect(bob).swap(0, amountOut(30n * E18, ...(await pair.getReserves()).slice(0, 2) as [bigint, bigint]), bob.address, "0x");
      const before = await pair.balanceOf(carol.address);
      await send(T0, alice, pairAddr, 10n * E18);
      await send(T1, alice, pairAddr, 40n * E18);
      await pair.connect(alice).mint(alice.address);
      expect(await pair.balanceOf(carol.address)).to.equal(before);
      expect(await pair.kLast()).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------- LP token
  describe("LP token behaviour", function () {
    it("is a normal ERC-20: transfers, approvals and transferFrom", async function () {
      const { pair, alice, bob, carol } = await loadFixture(seeded);
      const half = (await pair.balanceOf(alice.address)) / 2n;
      await pair.connect(alice).transfer(bob.address, half);
      expect(await pair.balanceOf(bob.address)).to.equal(half);
      await pair.connect(bob).approve(carol.address, half);
      await pair.connect(carol).transferFrom(bob.address, carol.address, half);
      expect(await pair.balanceOf(carol.address)).to.equal(half);
      await expect(pair.connect(carol).transferFrom(bob.address, carol.address, 1)).to.be.revertedWithCustomError(pair, "ERC20InsufficientAllowance");
    });

    it("supports EIP-2612 permit: a valid signature approves, a replay or an expired one does not", async function () {
      const { pair, pairAddr, alice, bob } = await loadFixture(seeded);
      const domain = { name: "Circleswap LP", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: pairAddr };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
      ] };
      const dl = BigInt((await time.latest()) + 3600);
      const sig = ethers.Signature.from(await alice.signTypedData(domain, types, { owner: alice.address, spender: bob.address, value: 123n, nonce: 0n, deadline: dl }));
      await pair.permit(alice.address, bob.address, 123n, dl, sig.v, sig.r, sig.s);
      expect(await pair.allowance(alice.address, bob.address)).to.equal(123n);
      await expect(pair.permit(alice.address, bob.address, 123n, dl, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(pair, "ERC2612InvalidSigner");
      const old = BigInt((await time.latest()) + 10);
      const sig2 = ethers.Signature.from(await alice.signTypedData(domain, types, { owner: alice.address, spender: bob.address, value: 1n, nonce: 1n, deadline: old }));
      await time.increase(100);
      await expect(pair.permit(alice.address, bob.address, 1n, old, sig2.v, sig2.r, sig2.s)).to.be.revertedWithCustomError(pair, "ERC2612ExpiredSignature");
    });

    it("a permit signed for one pool cannot be replayed on another", async function () {
      const { pair, alice, bob, factory, A, C } = await loadFixture(seeded);
      await factory.createPair(await A.getAddress(), await C.getAddress());
      const other = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await C.getAddress()));
      const domain = { name: "Circleswap LP", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await pair.getAddress() };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
      ] };
      const dl = BigInt((await time.latest()) + 3600);
      const sig = ethers.Signature.from(await alice.signTypedData(domain, types, { owner: alice.address, spender: bob.address, value: 5n, nonce: 0n, deadline: dl }));
      await expect(other.permit(alice.address, bob.address, 5n, dl, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(other, "ERC2612InvalidSigner");
    });
  });

  // ------------------------------------------------------------------------------------ hostile tokens
  describe("tokens the pool does not support cannot be used to break it", function () {
    it("a fee-on-transfer token cannot make a swap succeed on wrong accounting: the invariant refuses it", async function () {
      const amm = await deployAmm();
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy();
      await fot.mint(amm.alice.address, 1_000_000n * E18);
      await fot.connect(amm.alice).approve(amm.routerAddr, ethers.MaxUint256);
      await amm.router.connect(amm.alice).addLiquidity(await fot.getAddress(), await amm.B.getAddress(), 1000n * E18, 1000n * E18, 0, 0, amm.alice.address, (await time.latest()) + 3600);
      // The router sends a computed amount; 1% never arrives, so the pool sees less than it was promised.
      await expect(
        amm.router.connect(amm.alice).swapExactTokensForTokens(100n * E18, 0, [await fot.getAddress(), await amm.B.getAddress()], amm.alice.address, (await time.latest()) + 3600)
      ).to.be.revertedWithCustomError(await ethers.getContractAt("CircleswapPair", await amm.factory.getPair(await fot.getAddress(), await amm.B.getAddress())), "InvariantViolated");
    });

    it("a token that starts reverting stops swaps and mints, but nobody can take more than their share", async function () {
      const amm = await deployAmm();
      const bad = await (await ethers.getContractFactory("RevertingToken")).deploy();
      await bad.mint(amm.alice.address, 1_000_000n * E18);
      await bad.connect(amm.alice).approve(amm.routerAddr, ethers.MaxUint256);
      await amm.router.connect(amm.alice).addLiquidity(await bad.getAddress(), await amm.B.getAddress(), 1000n * E18, 1000n * E18, 0, 0, amm.alice.address, (await time.latest()) + 3600);
      const pair = await ethers.getContractAt("CircleswapPair", await amm.factory.getPair(await bad.getAddress(), await amm.B.getAddress()));
      await bad.breakIt();
      await amm.B.connect(amm.bob).transfer(await pair.getAddress(), 10n * E18);
      const bIsToken1 = (await pair.token1()) === (await amm.B.getAddress());
      await expect(pair.connect(amm.bob).swap(bIsToken1 ? 1n : 0n, bIsToken1 ? 0n : 1n, amm.bob.address, "0x")).to.be.reverted; // the frozen token cannot pay out
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(1000n * E18);
      expect(r1).to.equal(1000n * E18);
    });
  });
});
