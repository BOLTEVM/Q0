import { expect } from "chai";
import { ethers } from "hardhat";
import { simulateSwap } from "../../quai-service/src/index";
import {
  encodeAddLiquidity,
  encodeApprove,
  quoteLiquidityB,
  applySlippage
} from "../../quai-service/src/liquidity";
import {
  encodeRemoveLiquidity,
  estimateLpMint,
  lpUnderlying,
  removeLiquidityMins,
  LP_MINIMUM_LIQUIDITY
} from "../../quai-service/src/circleswap";
import { deployAmm, pairOf, reservesOf, deadline, rng, E18, MIN_LIQ } from "./ammHelpers";

// The app never calls a contract to preview a deposit, a withdrawal or a quote: it computes them in
// TypeScript from reserves it read. These tests hold every one of those figures to what the contracts
// actually do, and prove the calldata the app builds is calldata the router accepts.
describe("the app's client-side maths and encoders match the Circleswap contracts exactly", function () {
  it("the LP-minimum constant is the pool's", async function () {
    expect(LP_MINIMUM_LIQUIDITY).to.equal(MIN_LIQ);
    const amm = await deployAmm(1);
    await amm.router.connect(amm.alice).addLiquidity(amm.A.target, amm.B.target, E18, E18, 0, 0, amm.alice.address, await deadline());
    const pair = await pairOf(amm.factory, amm.A, amm.B);
    expect(await pair.MINIMUM_LIQUIDITY()).to.equal(LP_MINIMUM_LIQUIDITY);
  });

  it("estimateLpMint equals the LP a deposit really mints: first deposits, balanced and unbalanced follow-ups", async function () {
    const rand = rng(11);
    const between = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(rand() * 1e9)) * (hi - lo)) / 1_000_000_000n;
    for (let round = 0; round < 6; round++) {
      const amm = await deployAmm(1);
      const { alice, A, B, router, factory } = amm;
      const a0 = between(10_000n, 5_000_000n * E18);
      const b0 = between(10_000n, 5_000_000n * E18);

      // First deposit: nothing in the pool yet.
      const first = estimateLpMint(a0, b0, 0n, 0n, 0n);
      await router.connect(alice).addLiquidity(A.target, B.target, a0, b0, 0, 0, alice.address, await deadline());
      const pair = await pairOf(factory, A, B);
      expect(await pair.balanceOf(alice.address), `first deposit ${a0}/${b0}`).to.equal(first);

      // Follow-ups, with amounts that are NOT in the pool's ratio: the pool (via the router) takes the
      // balanced part, so the estimate has to be fed the amounts actually used.
      for (let k = 0; k < 4; k++) {
        const [rA, rB] = await reservesOf(pair, A);
        const supply = await pair.totalSupply();
        const wantA = between(rA / 1000n + 1n, rA);
        const wantB = between(rB / 1000n + 1n, rB);
        // What the router will use: the optimal counterpart of whichever side is limiting.
        const optB = quoteLiquidityB(wantA, rA, rB);
        const [useA, useB] = optB <= wantB ? [wantA, optB] : [quoteLiquidityB(wantB, rB, rA), wantB];
        const expected = estimateLpMint(useA, useB, rA, rB, supply);

        const before = await pair.balanceOf(alice.address);
        await router.connect(alice).addLiquidity(A.target, B.target, wantA, wantB, 0, 0, alice.address, await deadline());
        expect((await pair.balanceOf(alice.address)) - before, `round ${round} follow-up ${k}`).to.equal(expected);
      }
    }
  });

  it("estimateLpMint tells a deposit the pool would refuse (too small to mint anything) from one it accepts", async function () {
    expect(estimateLpMint(0n, 5n, 0n, 0n, 0n)).to.equal(0n);
    expect(estimateLpMint(1000n, 1000n, 0n, 0n, 0n)).to.equal(0n); // sqrt = 1000, all of it locked
    expect(estimateLpMint(1001n, 1001n, 0n, 0n, 0n)).to.equal(1n);
    const amm = await deployAmm(1);
    await expect(
      amm.router.connect(amm.alice).addLiquidity(amm.A.target, amm.B.target, 1000n, 1000n, 0, 0, amm.alice.address, await deadline())
    ).to.be.reverted;
  });

  it("lpUnderlying equals what removing liquidity really pays out", async function () {
    const amm = await deployAmm(2);
    const { alice, bob, A, B, router, factory } = amm;
    await router.connect(alice).addLiquidity(A.target, B.target, 1234n * E18, 5678n * E18 + 7n, 0, 0, alice.address, await deadline());
    await router.connect(bob).addLiquidity(A.target, B.target, 321n * E18, 1400n * E18, 0, 0, bob.address, await deadline());
    const pair = await pairOf(factory, A, B);
    await pair.connect(bob).approve(router.target, ethers.MaxUint256);

    for (const pct of [1n, 17n, 50n, 99n, 100n]) {
      const bal = await pair.balanceOf(bob.address);
      const liq = pct === 100n ? bal : (bal * pct) / 100n;
      const [rA, rB] = await reservesOf(pair, A);
      const [gotA, gotB] = lpUnderlying(liq, await pair.totalSupply(), rA, rB);

      const beforeA = await A.balanceOf(bob.address);
      const beforeB = await B.balanceOf(bob.address);
      await router.connect(bob).removeLiquidity(A.target, B.target, liq, 0, 0, bob.address, await deadline());
      expect((await A.balanceOf(bob.address)) - beforeA, `${pct}% of A`).to.equal(gotA);
      expect((await B.balanceOf(bob.address)) - beforeB, `${pct}% of B`).to.equal(gotB);
    }
    expect(await pair.balanceOf(bob.address)).to.equal(0n);
  });

  it("minimum amounts computed from the estimate are always met by the real removal", async function () {
    const amm = await deployAmm(1);
    const { alice, A, B, router, factory } = amm;
    await router.connect(alice).addLiquidity(A.target, B.target, 900n * E18, 2700n * E18, 0, 0, alice.address, await deadline());
    const pair = await pairOf(factory, A, B);
    await pair.connect(alice).approve(router.target, ethers.MaxUint256);
    const liq = (await pair.balanceOf(alice.address)) / 3n;
    const [rA, rB] = await reservesOf(pair, A);
    const [uA, uB] = lpUnderlying(liq, await pair.totalSupply(), rA, rB);
    // Even at 0% slippage the estimate is achievable exactly (no fee accrued, no one else moved the pool).
    const [mA, mB] = removeLiquidityMins(uA, uB, 0);
    await router.connect(alice).removeLiquidity(A.target, B.target, liq, mA, mB, alice.address, await deadline());
    // One wei more than the estimate must be refused: the estimate is not padded low.
    const liq2 = (await pair.balanceOf(alice.address)) / 2n;
    const [rA2, rB2] = await reservesOf(pair, A);
    const [uA2, uB2] = lpUnderlying(liq2, await pair.totalSupply(), rA2, rB2);
    await expect(router.connect(alice).removeLiquidity(A.target, B.target, liq2, uA2 + 1n, uB2, alice.address, await deadline())).to.be.reverted;
  });

  it("simulateSwap equals the router's getAmountsOut, hop by hop", async function () {
    const rand = rng(29);
    const between = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(rand() * 1e9)) * (hi - lo)) / 1_000_000_000n;
    const amm = await deployAmm(1);
    const { alice, A, B, C, router, factory } = amm;
    await router.connect(alice).addLiquidity(A.target, B.target, 8_000n * E18, 3_000n * E18, 0, 0, alice.address, await deadline());
    await router.connect(alice).addLiquidity(B.target, C.target, 2_500n * E18, 9_000n * E18, 0, 0, alice.address, await deadline());
    const ab = await pairOf(factory, A, B);
    const bc = await pairOf(factory, B, C);

    for (let i = 0; i < 25; i++) {
      const amountIn = between(1n, 500n * E18);
      const [rA, rB] = await reservesOf(ab, A);
      const [rB2, rC] = await reservesOf(bc, B);
      const mid = BigInt(simulateSwap(amountIn.toString(), rA.toString(), rB.toString(), 0).amountOut);
      const end = BigInt(simulateSwap(mid.toString(), rB2.toString(), rC.toString(), 0).amountOut);
      const onChain = await router.getAmountsOut(amountIn, [A.target, B.target, C.target]);
      expect(onChain[1], `hop 1 for ${amountIn}`).to.equal(mid);
      expect(onChain[2], `hop 2 for ${amountIn}`).to.equal(end);
    }
  });

  it("quoteLiquidityB equals the router's quote", async function () {
    const rand = rng(5);
    const amm = await deployAmm(1);
    for (let i = 0; i < 20; i++) {
      const a = BigInt(Math.floor(rand() * 1e12)) * E18 + 1n;
      const rA = BigInt(Math.floor(rand() * 1e9) + 1) * E18;
      const rB = BigInt(Math.floor(rand() * 1e9) + 1) * (E18 / 7n) + 3n;
      expect(quoteLiquidityB(a, rA, rB)).to.equal(await amm.router.quote(a, rA, rB));
    }
  });

  describe("the calldata the app builds is calldata the router accepts", function () {
    it("encodeAddLiquidity / encodeRemoveLiquidity / encodeApprove are byte-identical to the ABI encoding", async function () {
      const amm = await deployAmm(1);
      const to = amm.alice.address;
      const args = [amm.A.target, amm.B.target, 10n * E18, 20n * E18, 9n * E18, 19n * E18, to, 1_900_000_000n] as const;
      expect(
        encodeAddLiquidity({ tokenA: args[0] as string, tokenB: args[1] as string, amountADesired: args[2], amountBDesired: args[3], amountAMin: args[4], amountBMin: args[5], to, deadline: args[7] })
      ).to.equal(amm.router.interface.encodeFunctionData("addLiquidity", args));

      expect(
        encodeRemoveLiquidity({ tokenA: amm.A.target as string, tokenB: amm.B.target as string, liquidity: 5n, amountAMin: 6n, amountBMin: 7n, to, deadline: 8n })
      ).to.equal(amm.router.interface.encodeFunctionData("removeLiquidity", [amm.A.target, amm.B.target, 5n, 6n, 7n, to, 8n]));

      expect(encodeApprove(to, 123n)).to.equal(amm.A.interface.encodeFunctionData("approve", [to, 123n]));
    });

    it("a raw transaction carrying the app's encodings adds and then removes liquidity for real", async function () {
      const amm = await deployAmm(1);
      const { alice, A, B, router, factory } = amm;
      const dl = BigInt(await deadline());

      await alice.sendTransaction({
        to: router.target,
        data: encodeAddLiquidity({
          tokenA: A.target as string,
          tokenB: B.target as string,
          amountADesired: 100n * E18,
          amountBDesired: 300n * E18,
          amountAMin: 100n * E18,
          amountBMin: 300n * E18,
          to: alice.address,
          deadline: dl
        })
      });
      const pair = await pairOf(factory, A, B);
      const lp = await pair.balanceOf(alice.address);
      expect(lp).to.equal(estimateLpMint(100n * E18, 300n * E18, 0n, 0n, 0n));

      await alice.sendTransaction({ to: pair.target, data: encodeApprove(router.target as string, lp) });
      const beforeA = await A.balanceOf(alice.address);
      await alice.sendTransaction({
        to: router.target,
        data: encodeRemoveLiquidity({
          tokenA: A.target as string,
          tokenB: B.target as string,
          liquidity: lp,
          amountAMin: 0n,
          amountBMin: 0n,
          to: alice.address,
          deadline: dl
        })
      });
      expect(await pair.balanceOf(alice.address)).to.equal(0n);
      expect((await A.balanceOf(alice.address)) - beforeA).to.be.gt(0n);
      // Only the permanently locked minimum is left in the pool.
      const [rA] = await reservesOf(pair, A);
      expect(rA).to.be.lt(2n * E18);
    });

    it("applySlippage feeds a minimum the router honours: the mint is refused if the price moved past it", async function () {
      const amm = await deployAmm(2);
      const { alice, bob, A, B, router } = amm;
      await router.connect(alice).addLiquidity(A.target, B.target, 1000n * E18, 1000n * E18, 0, 0, alice.address, await deadline());
      // Bob deposits at the old ratio with a 1% tolerance, but the price moves first (a swap by alice).
      await router.connect(alice).swapExactTokensForTokens(300n * E18, 0, [A.target, B.target], alice.address, await deadline());
      const a = 100n * E18;
      const b = 100n * E18; // no longer the ratio
      await expect(
        router.connect(bob).addLiquidity(A.target, B.target, a, b, applySlippage(a, 1), applySlippage(b, 1), bob.address, await deadline())
      ).to.be.reverted;
    });
  });
});
