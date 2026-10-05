import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, MIN_LIQ, amountOut, amountIn, deployAmm, deadline, pairOf, reservesOf, seed, type Amm } from "./ammHelpers";

const REENTRANCY = "0x3ee5aeb5"; // ReentrancyGuardReentrantCall()

describe("Circleswap AMM: router", function () {
  const fixture = () => deployAmm();

  /** Pools A/B (1000:4000), B/C (2000:2000) and C/WQUAI (1000:100), funded by alice. */
  async function withPools() {
    const amm = await deployAmm();
    const { A, B, C, wquai, alice } = amm;
    await seed(amm, alice, A, B, 1000n * E18, 4000n * E18);
    await seed(amm, alice, B, C, 2000n * E18, 2000n * E18);
    await amm.router.connect(alice).addLiquidityETH(await C.getAddress(), 1000n * E18, 0, 0, alice.address, await deadline(), { value: 100n * E18 });
    return amm;
  }

  /** The router keeps nothing: after any operation its balances of every token and of native QUAI are zero. */
  async function expectRouterEmpty(amm: Amm) {
    for (const t of [amm.A, amm.B, amm.C, amm.D, amm.wquai]) expect(await t.balanceOf(amm.routerAddr)).to.equal(0);
    expect(await ethers.provider.getBalance(amm.routerAddr)).to.equal(0);
  }

  const gasCost = async (tx: any) => {
    const r = await (await tx).wait();
    return BigInt(r.gasUsed) * BigInt(r.gasPrice ?? r.effectiveGasPrice);
  };

  const pathOf = async (...tokens: any[]) => Promise.all(tokens.map(t => t.getAddress()));

  // ------------------------------------------------------------------------------------------- construction
  describe("construction and native handling", function () {
    it("needs a real factory and a real wrapped-native token", async function () {
      const { factory, wquai, alice, owner } = await loadFixture(fixture);
      const R = await ethers.getContractFactory("CircleswapRouter");
      const impl = await R.deploy();
      const P = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        P.deploy(await impl.getAddress(), R.interface.encodeFunctionData("initialize", [alice.address, await wquai.getAddress(), owner.address]))
      ).to.be.revertedWithCustomError(R, "InvalidToken");
      await expect(
        P.deploy(await impl.getAddress(), R.interface.encodeFunctionData("initialize", [await factory.getAddress(), alice.address, owner.address]))
      ).to.be.revertedWithCustomError(R, "InvalidToken");
    });

    it("exposes its factory and WETH (the app reads both)", async function () {
      const { router, factory, wquai } = await loadFixture(fixture);
      expect(await router.factory()).to.equal(await factory.getAddress());
      expect(await router.WETH()).to.equal(await wquai.getAddress());
    });

    it("refuses native QUAI from anyone except WQUAI", async function () {
      const { router, alice } = await loadFixture(fixture);
      await expect(alice.sendTransaction({ to: await router.getAddress(), value: 1n })).to.be.revertedWithCustomError(router, "UnexpectedNativeSender");
    });
  });

  // ----------------------------------------------------------------------------------------- addLiquidity
  describe("addLiquidity", function () {
    it("creates the pool if it does not exist, and the first deposit sets the price", async function () {
      const amm = await loadFixture(fixture);
      const { router, factory, A, B, alice, bob } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await expect(router.connect(alice).addLiquidity(a, b, 1000n * E18, 4000n * E18, 0, 0, bob.address, await deadline()))
        .to.emit(factory, "PairCreated");
      const pair = await pairOf(factory, A, B);
      expect((await reservesOf(pair, A))).to.deep.equal([1000n * E18, 4000n * E18]);
      expect(await pair.balanceOf(bob.address)).to.be.gt(0); // shares go to `to`, not the sender
      expect(await pair.balanceOf(alice.address)).to.equal(0);
      await expectRouterEmpty(amm);
    });

    it("into an existing pool it trims the deposit to the pool ratio, on whichever side is too generous", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, bob } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      // pool is 1000 A : 4000 B. Offer plenty of B: A is the limit.
      let beforeA = await A.balanceOf(bob.address);
      let beforeB = await B.balanceOf(bob.address);
      await router.connect(bob).addLiquidity(a, b, 100n * E18, 1000n * E18, 0, 0, bob.address, await deadline());
      expect(beforeA - (await A.balanceOf(bob.address))).to.equal(100n * E18);
      expect(beforeB - (await B.balanceOf(bob.address))).to.equal(400n * E18);
      // Offer plenty of A: now B is the limit. (Pool is 1100 : 4400 after the first deposit.)
      beforeA = await A.balanceOf(bob.address);
      beforeB = await B.balanceOf(bob.address);
      await router.connect(bob).addLiquidity(a, b, 1000n * E18, 100n * E18, 0, 0, bob.address, await deadline());
      expect(beforeB - (await B.balanceOf(bob.address))).to.equal(100n * E18);
      expect(beforeA - (await A.balanceOf(bob.address))).to.equal(25n * E18);
      await expectRouterEmpty(amm);
    });

    it("token order in the call does not matter", async function () {
      const amm = await loadFixture(fixture);
      const { router, factory, A, B, alice } = amm;
      await router.connect(alice).addLiquidity(await B.getAddress(), await A.getAddress(), 4000n * E18, 1000n * E18, 0, 0, alice.address, await deadline());
      const pair = await pairOf(factory, A, B);
      expect(await reservesOf(pair, A)).to.deep.equal([1000n * E18, 4000n * E18]);
    });

    it("enforces the caller's minimums on both sides", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, bob } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      // B-limited-by-A branch: A=100 needs B=400; demanding 401 fails.
      await expect(router.connect(bob).addLiquidity(a, b, 100n * E18, 1000n * E18, 0, 401n * E18, bob.address, await deadline()))
        .to.be.revertedWithCustomError(router, "InsufficientBAmount");
      // A-limited-by-B branch: B=100 needs A=25; demanding 26 fails.
      await expect(router.connect(bob).addLiquidity(a, b, 1000n * E18, 100n * E18, 26n * E18, 0, bob.address, await deadline()))
        .to.be.revertedWithCustomError(router, "InsufficientAAmount");
    });

    it("protects against a pool someone created at a different price: the minimums refuse the bad ratio", async function () {
      const amm = await loadFixture(fixture);
      const { router, A, B, alice, bob } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await router.connect(alice).addLiquidity(a, b, 1n * E18, 100n * E18, 0, 0, alice.address, await deadline()); // attacker: 1 A = 100 B
      // bob expected 1 A ~ 1 B and asks for at least 90% of what he offers on each side.
      await expect(router.connect(bob).addLiquidity(a, b, 100n * E18, 100n * E18, 90n * E18, 90n * E18, bob.address, await deadline()))
        .to.be.revertedWithCustomError(router, "InsufficientAAmount");
    });

    it("refuses an expired deadline and a missing allowance", async function () {
      const amm = await loadFixture(fixture);
      const { router, A, B, alice, carol } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await expect(router.connect(alice).addLiquidity(a, b, 1n, 1n, 0, 0, alice.address, (await time.latest()) - 1)).to.be.revertedWithCustomError(router, "Expired");
      await A.mint(carol.address, 10n * E18);
      await B.mint(carol.address, 10n * E18);
      await A.connect(carol).approve(amm.routerAddr, 0); // carol never approved the router for this
      await expect(router.connect(carol).addLiquidity(a, b, 10n * E18, 10n * E18, 0, 0, carol.address, await deadline())).to.be.revertedWithCustomError(A, "ERC20InsufficientAllowance");
    });

    it("an empty pool that already exists takes the first deposit at the caller's ratio", async function () {
      const amm = await loadFixture(fixture);
      const { router, factory, A, B, alice } = amm;
      await factory.createPair(await A.getAddress(), await B.getAddress()); // created, never funded
      await router.connect(alice).addLiquidity(await A.getAddress(), await B.getAddress(), 300n * E18, 700n * E18, 0, 0, alice.address, await deadline());
      expect(await reservesOf(await pairOf(factory, A, B), A)).to.deep.equal([300n * E18, 700n * E18]);
    });
  });

  // -------------------------------------------------------------------------------------- addLiquidityETH
  describe("addLiquidityETH", function () {
    it("wraps native QUAI, deposits it, and refunds whatever the pool ratio did not need", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, C, wquai, bob } = amm;
      const pair = await pairOf(factory, C, wquai);
      // Pool is 1000 C : 100 WQUAI. 100 C needs 10 QUAI; send 50.
      const before = await ethers.provider.getBalance(bob.address);
      const tx = router.connect(bob).addLiquidityETH(await C.getAddress(), 100n * E18, 0, 0, bob.address, await deadline(), { value: 50n * E18 });
      const cost = await gasCost(tx);
      const after = await ethers.provider.getBalance(bob.address);
      expect(before - after - cost).to.equal(10n * E18); // only 10 QUAI was kept; 40 came back
      const [rc, rw] = await reservesOf(pair, C);
      expect([rc, rw]).to.deep.equal([1100n * E18, 110n * E18]);
      await expectRouterEmpty(amm);
    });

    it("creates a WQUAI pool from scratch and honours minimums", async function () {
      const amm = await loadFixture(fixture);
      const { router, factory, D, wquai, alice } = amm;
      await router.connect(alice).addLiquidityETH(await D.getAddress(), 500n * E18, 0, 0, alice.address, await deadline(), { value: 5n * E18 });
      const pair = await pairOf(factory, D, wquai);
      expect(await reservesOf(pair, D)).to.deep.equal([500n * E18, 5n * E18]);
      // 100 D needs 1 QUAI; ask for at least 2 back.
      await expect(router.connect(alice).addLiquidityETH(await D.getAddress(), 100n * E18, 0, 2n * E18, alice.address, await deadline(), { value: 5n * E18 }))
        .to.be.revertedWithCustomError(router, "InsufficientBAmount");
      await expectRouterEmpty(amm);
    });
  });

  // ---------------------------------------------------------------------------------------- removeLiquidity
  describe("removeLiquidity", function () {
    it("burns LP and pays both tokens to `to`, with minimums enforced", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, alice, carol } = amm;
      const pair = await pairOf(factory, A, B);
      const lp = (await pair.balanceOf(alice.address)) / 2n;
      await pair.connect(alice).approve(amm.routerAddr, lp);
      const supply = await pair.totalSupply();
      const [rA, rB] = await reservesOf(pair, A);
      const outA = (lp * rA) / supply;
      const outB = (lp * rB) / supply;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await expect(router.connect(alice).removeLiquidity(a, b, lp, outA + 1n, 0, carol.address, await deadline())).to.be.revertedWithCustomError(router, "InsufficientAAmount");
      await expect(router.connect(alice).removeLiquidity(a, b, lp, 0, outB + 1n, carol.address, await deadline())).to.be.revertedWithCustomError(router, "InsufficientBAmount");
      const beforeA = await A.balanceOf(carol.address);
      const beforeB = await B.balanceOf(carol.address);
      await router.connect(alice).removeLiquidity(a, b, lp, outA, outB, carol.address, await deadline());
      expect((await A.balanceOf(carol.address)) - beforeA).to.equal(outA);
      expect((await B.balanceOf(carol.address)) - beforeB).to.equal(outB);
      await expectRouterEmpty(amm);
    });

    it("needs the LP approval, an existing pool, and a live deadline", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, D, alice } = amm;
      const pair = await pairOf(factory, A, B);
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await expect(router.connect(alice).removeLiquidity(a, b, 1000n, 0, 0, alice.address, await deadline())).to.be.revertedWithCustomError(pair, "ERC20InsufficientAllowance");
      await expect(router.connect(alice).removeLiquidity(a, await D.getAddress(), 1000n, 0, 0, alice.address, await deadline())).to.be.revertedWithCustomError(router, "PairNotFound");
      await expect(router.connect(alice).removeLiquidity(a, b, 1000n, 0, 0, alice.address, (await time.latest()) - 1)).to.be.revertedWithCustomError(router, "Expired");
    });

    it("withdraws to native QUAI (removeLiquidityETH) and pays the recipient exactly", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, C, wquai, alice, dave } = amm;
      const pair = await pairOf(factory, C, wquai);
      const lp = (await pair.balanceOf(alice.address)) / 3n;
      await pair.connect(alice).approve(amm.routerAddr, lp);
      const supply = await pair.totalSupply();
      const [rc, rw] = await reservesOf(pair, C);
      const outC = (lp * rc) / supply;
      const outW = (lp * rw) / supply;
      const beforeNative = await ethers.provider.getBalance(dave.address);
      const beforeC = await C.balanceOf(dave.address);
      await router.connect(alice).removeLiquidityETH(await C.getAddress(), lp, outC, outW, dave.address, await deadline());
      expect((await ethers.provider.getBalance(dave.address)) - beforeNative).to.equal(outW);
      expect((await C.balanceOf(dave.address)) - beforeC).to.equal(outC);
      await expectRouterEmpty(amm);
    });

    async function permitSig(pair: any, owner: any, spender: string, value: bigint, dl: number) {
      const domain = { name: "Circleswap LP", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await pair.getAddress() };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
      ] };
      return ethers.Signature.from(await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce: await pair.nonces(owner.address), deadline: dl }));
    }

    it("removes liquidity in ONE transaction with an EIP-2612 permit (no separate approve)", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, alice } = amm;
      const pair = await pairOf(factory, A, B);
      const lp = (await pair.balanceOf(alice.address)) / 2n;
      const dl = await deadline();
      const sig = await permitSig(pair, alice, amm.routerAddr, lp, dl);
      const before = await A.balanceOf(alice.address);
      expect(await pair.allowance(alice.address, amm.routerAddr)).to.equal(0); // nothing approved beforehand
      await router.connect(alice).removeLiquidityWithPermit(await A.getAddress(), await B.getAddress(), lp, 0, 0, alice.address, dl, false, sig.v, sig.r, sig.s);
      expect((await A.balanceOf(alice.address)) - before).to.be.gt(0);
      expect(await pair.allowance(alice.address, amm.routerAddr)).to.equal(0); // exactly consumed
      await expectRouterEmpty(amm);
    });

    it("approveMax leaves a standing allowance, so replaying the signature is harmless (the allowance already covers it)", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, alice } = amm;
      const pair = await pairOf(factory, A, B);
      const lp = (await pair.balanceOf(alice.address)) / 4n;
      const dl = await deadline();
      const sig = await permitSig(pair, alice, amm.routerAddr, ethers.MaxUint256, dl);
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, true, sig.v, sig.r, sig.s);
      expect(await pair.allowance(alice.address, amm.routerAddr)).to.equal(ethers.MaxUint256);
      // The nonce is spent, so the permit itself fails; the standing allowance is what lets this through.
      const before = await pair.balanceOf(alice.address);
      await router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, true, sig.v, sig.r, sig.s);
      expect(before - (await pair.balanceOf(alice.address))).to.equal(lp);
    });

    it("a signature by someone else, or submitted by a stranger, is refused when no allowance backs it", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, alice, bob } = amm;
      const pair = await pairOf(factory, A, B);
      const lp = (await pair.balanceOf(alice.address)) / 4n;
      const dl = await deadline();
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      const wrong = await permitSig(pair, bob, amm.routerAddr, lp, dl); // signed by bob, submitted by alice: the owner is the caller
      await expect(router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, false, wrong.v, wrong.r, wrong.s)).to.be.revertedWithCustomError(router, "PermitFailed");
      // A stranger cannot spend alice's LP by submitting alice's signature: the router treats the CALLER as the owner.
      const fresh = await permitSig(pair, alice, amm.routerAddr, lp, dl);
      await expect(router.connect(bob).removeLiquidityWithPermit(a, b, lp, 0, 0, bob.address, dl, false, fresh.v, fresh.r, fresh.s)).to.be.revertedWithCustomError(router, "PermitFailed");
      // Garbage signature, no allowance.
      await expect(router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, false, 27, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(router, "PermitFailed");
      // A permit for less than what is being withdrawn does not cover it either.
      const small = await permitSig(pair, alice, amm.routerAddr, lp / 2n, dl);
      await pair.connect(alice).permit(alice.address, amm.routerAddr, lp / 2n, dl, small.v, small.r, small.s); // spends the nonce
      await expect(router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, false, small.v, small.r, small.s)).to.be.revertedWithCustomError(router, "PermitFailed");
    });

    it("a front-run permit cannot block the withdrawal: someone submitting the signature first changes nothing", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, A, B, C, wquai, alice, bob } = amm;
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      const pair = await pairOf(factory, A, B);
      const lp = (await pair.balanceOf(alice.address)) / 2n;
      const dl = await deadline();
      const sig = await permitSig(pair, alice, amm.routerAddr, lp, dl);
      // Bob watches the mempool and submits alice's signature straight to the pool before her transaction lands.
      await pair.connect(bob).permit(alice.address, amm.routerAddr, lp, dl, sig.v, sig.r, sig.s);
      expect(await pair.allowance(alice.address, amm.routerAddr)).to.equal(lp);
      const before = await A.balanceOf(alice.address);
      await router.connect(alice).removeLiquidityWithPermit(a, b, lp, 0, 0, alice.address, dl, false, sig.v, sig.r, sig.s);
      expect((await A.balanceOf(alice.address)) - before).to.be.gt(0);
      expect(await pair.allowance(alice.address, amm.routerAddr)).to.equal(0);
      await expectRouterEmpty(amm);

      // The same holds for the native-QUAI variant.
      const pairC = await pairOf(factory, C, wquai);
      const lpC = (await pairC.balanceOf(alice.address)) / 2n;
      const sigC = await permitSig(pairC, alice, amm.routerAddr, lpC, dl);
      await pairC.connect(bob).permit(alice.address, amm.routerAddr, lpC, dl, sigC.v, sigC.r, sigC.s);
      await router.connect(alice).removeLiquidityETHWithPermit(await C.getAddress(), lpC, 0, 0, alice.address, dl, false, sigC.v, sigC.r, sigC.s);
      expect(await pairC.allowance(alice.address, amm.routerAddr)).to.equal(0);
    });

    it("the ETH permit variant works too", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, C, wquai, alice, dave } = amm;
      const pair = await pairOf(factory, C, wquai);
      const lp = (await pair.balanceOf(alice.address)) / 2n;
      const dl = await deadline();
      const sig = await permitSig(pair, alice, amm.routerAddr, lp, dl);
      const before = await ethers.provider.getBalance(dave.address);
      await router.connect(alice).removeLiquidityETHWithPermit(await C.getAddress(), lp, 0, 0, dave.address, dl, false, sig.v, sig.r, sig.s);
      expect((await ethers.provider.getBalance(dave.address)) - before).to.be.gt(0);
      await expectRouterEmpty(amm);
    });
  });

  // ----------------------------------------------------------------------------------------------- swaps
  describe("swapExactTokensForTokens", function () {
    it("single hop pays exactly the reference amount and matches getAmountsOut", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, bob, carol } = amm;
      const path = await pathOf(A, B);
      const expected = amountOut(10n * E18, 1000n * E18, 4000n * E18);
      const quote = await router.getAmountsOut(10n * E18, path);
      expect(quote).to.deep.equal([10n * E18, expected]);
      const before = await B.balanceOf(carol.address);
      await router.connect(bob).swapExactTokensForTokens(10n * E18, expected, path, carol.address, await deadline());
      expect((await B.balanceOf(carol.address)) - before).to.equal(expected);
      await expectRouterEmpty(amm);
    });

    it("multi-hop chains the pools and pays the composed amount", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, C, bob } = amm;
      const path = await pathOf(A, B, C);
      const hop1 = amountOut(10n * E18, 1000n * E18, 4000n * E18);
      const hop2 = amountOut(hop1, 2000n * E18, 2000n * E18);
      const before = await C.balanceOf(bob.address);
      const amounts = await router.connect(bob).swapExactTokensForTokens.staticCall(10n * E18, 0, path, bob.address, await deadline());
      expect(amounts).to.deep.equal([10n * E18, hop1, hop2]);
      await router.connect(bob).swapExactTokensForTokens(10n * E18, hop2, path, bob.address, await deadline());
      expect((await C.balanceOf(bob.address)) - before).to.equal(hop2);
      await expectRouterEmpty(amm);
    });

    it("refuses when the output would fall below the minimum, the deadline has passed, or the path is bad", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, D, bob } = amm;
      const path = await pathOf(A, B);
      const out = amountOut(10n * E18, 1000n * E18, 4000n * E18);
      await expect(router.connect(bob).swapExactTokensForTokens(10n * E18, out + 1n, path, bob.address, await deadline())).to.be.revertedWithCustomError(router, "InsufficientOutputAmount");
      await expect(router.connect(bob).swapExactTokensForTokens(10n * E18, 0, path, bob.address, (await time.latest()) - 1)).to.be.revertedWithCustomError(router, "Expired");
      await expect(router.connect(bob).swapExactTokensForTokens(10n * E18, 0, [await A.getAddress()], bob.address, await deadline())).to.be.revertedWithCustomError(router, "InvalidPath");
      await expect(router.connect(bob).swapExactTokensForTokens(10n * E18, 0, await pathOf(A, D), bob.address, await deadline())).to.be.revertedWithCustomError(router, "PairNotFound");
      await expect(router.connect(bob).swapExactTokensForTokens(10n * E18, 0, await pathOf(A, A), bob.address, await deadline())).to.be.revertedWithCustomError(router, "PairNotFound");
    });

    it("a zero-input swap is refused", async function () {
      const { router, A, B, bob } = await loadFixture(withPools);
      await expect(router.connect(bob).swapExactTokensForTokens(0, 0, await pathOf(A, B), bob.address, await deadline())).to.be.reverted;
    });
  });

  describe("swapTokensForExactTokens", function () {
    it("delivers exactly the requested output for the least input, single and multi hop", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, C, bob, carol } = amm;
      const [rA, rB] = [1000n * E18, 4000n * E18];
      const need = amountIn(100n * E18, rA, rB);
      const before = await B.balanceOf(carol.address);
      await router.connect(bob).swapTokensForExactTokens(100n * E18, need, await pathOf(A, B), carol.address, await deadline());
      expect((await B.balanceOf(carol.address)) - before).to.equal(100n * E18);

      const path = await pathOf(A, B, C);
      const amounts = await router.getAmountsIn(50n * E18, path);
      const beforeC = await C.balanceOf(carol.address);
      await router.connect(bob).swapTokensForExactTokens(50n * E18, amounts[0], path, carol.address, await deadline());
      expect((await C.balanceOf(carol.address)) - beforeC).to.equal(50n * E18);
      await expectRouterEmpty(amm);
    });

    it("refuses when the input needed exceeds the cap, and when the output cannot be supplied", async function () {
      const { router, A, B, bob } = await loadFixture(withPools);
      const need = amountIn(100n * E18, 1000n * E18, 4000n * E18);
      await expect(router.connect(bob).swapTokensForExactTokens(100n * E18, need - 1n, await pathOf(A, B), bob.address, await deadline())).to.be.revertedWithCustomError(router, "ExcessiveInputAmount");
      await expect(router.connect(bob).swapTokensForExactTokens(4000n * E18, ethers.MaxUint256, await pathOf(A, B), bob.address, await deadline())).to.be.reverted; // the whole reserve
    });

    it("buying the exact quote never reverts on the pool's own invariant (rounding always favours the pool)", async function () {
      const amm = await loadFixture(withPools);
      const { router, A, B, bob } = amm;
      for (const out of [1n, 999n, 10n ** 12n, 7n * E18 + 13n, 399n * E18]) {
        const amounts = await router.getAmountsIn(out, await pathOf(A, B));
        await router.connect(bob).swapTokensForExactTokens(out, amounts[0], await pathOf(A, B), bob.address, await deadline());
      }
    });
  });

  describe("native QUAI swaps", function () {
    it("swapExactETHForTokens wraps and swaps", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, bob, carol } = amm;
      const path = await pathOf(wquai, C);
      const expected = amountOut(5n * E18, 100n * E18, 1000n * E18);
      const before = await C.balanceOf(carol.address);
      await router.connect(bob).swapExactETHForTokens(expected, path, carol.address, await deadline(), { value: 5n * E18 });
      expect((await C.balanceOf(carol.address)) - before).to.equal(expected);
      await expectRouterEmpty(amm);
      await expect(router.connect(bob).swapExactETHForTokens(expected, await pathOf(C, wquai), carol.address, await deadline(), { value: 5n * E18 })).to.be.revertedWithCustomError(router, "InvalidPath");
    });

    it("swapExactTokensForETH pays native QUAI to the recipient", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, bob, dave } = amm;
      const path = await pathOf(C, wquai);
      const expected = amountOut(50n * E18, 1000n * E18, 100n * E18);
      const before = await ethers.provider.getBalance(dave.address);
      await router.connect(bob).swapExactTokensForETH(50n * E18, expected, path, dave.address, await deadline());
      expect((await ethers.provider.getBalance(dave.address)) - before).to.equal(expected);
      await expectRouterEmpty(amm);
      await expect(router.connect(bob).swapExactTokensForETH(50n * E18, 0, await pathOf(wquai, C), dave.address, await deadline())).to.be.revertedWithCustomError(router, "InvalidPath");
    });

    it("swapTokensForExactETH delivers exactly the requested QUAI", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, bob, dave } = amm;
      const path = await pathOf(C, wquai);
      const need = amountIn(3n * E18, 1000n * E18, 100n * E18);
      const before = await ethers.provider.getBalance(dave.address);
      await router.connect(bob).swapTokensForExactETH(3n * E18, need, path, dave.address, await deadline());
      expect((await ethers.provider.getBalance(dave.address)) - before).to.equal(3n * E18);
      await expect(router.connect(bob).swapTokensForExactETH(3n * E18, need - 1n, path, dave.address, await deadline())).to.be.revertedWithCustomError(router, "ExcessiveInputAmount");
      await expectRouterEmpty(amm);
    });

    it("swapETHForExactTokens buys the exact amount and refunds the unused QUAI", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, bob, carol } = amm;
      const path = await pathOf(wquai, C);
      const need = amountIn(20n * E18, 100n * E18, 1000n * E18);
      const beforeNative = await ethers.provider.getBalance(bob.address);
      const beforeC = await C.balanceOf(carol.address);
      const tx = router.connect(bob).swapETHForExactTokens(20n * E18, path, carol.address, await deadline(), { value: 50n * E18 });
      const cost = await gasCost(tx);
      expect((await C.balanceOf(carol.address)) - beforeC).to.equal(20n * E18);
      expect(beforeNative - (await ethers.provider.getBalance(bob.address)) - cost).to.equal(need); // paid exactly `need`; the rest came back
      await expect(router.connect(bob).swapETHForExactTokens(20n * E18, path, carol.address, await deadline(), { value: need - 1n })).to.be.revertedWithCustomError(router, "ExcessiveInputAmount");
      await expectRouterEmpty(amm);
    });

    it("reports a recipient that cannot accept native QUAI instead of losing the funds", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, bob } = amm;
      const rejects = await (await ethers.getContractFactory("RejectsNative")).deploy();
      await expect(router.connect(bob).swapExactTokensForETH(50n * E18, 0, await pathOf(C, wquai), await rejects.getAddress(), await deadline()))
        .to.be.revertedWithCustomError(router, "NativeTransferFailed");
      await expectRouterEmpty(amm);
    });

    it("a recipient that re-enters the router while being paid QUAI is refused by the reentrancy guard", async function () {
      const amm = await loadFixture(withPools);
      const { router, factory, C, wquai, alice } = amm;
      const receiver = await (await ethers.getContractFactory("ReentrantNativeReceiver")).deploy(await router.getAddress(), await C.getAddress());
      const pair = await pairOf(factory, C, wquai);
      const lp = (await pair.balanceOf(alice.address)) / 4n;
      await pair.connect(alice).transfer(await receiver.getAddress(), lp);
      await receiver.withdrawTo(lp); // outer removeLiquidityETH pays the receiver, which tries to swap back in
      expect(await receiver.attempted()).to.equal(true);
      expect(await receiver.reentrySucceeded()).to.equal(false);
      expect(await receiver.lastRevert()).to.equal(REENTRANCY);
      await expectRouterEmpty(amm);
    });
  });

  describe("recipients that would lose funds are refused", function () {
    it("every function that pays someone rejects the zero address and the router itself", async function () {
      const amm = await loadFixture(withPools);
      const { router, C, wquai, A, B, bob } = amm;
      const [a, b, c, w] = [await A.getAddress(), await B.getAddress(), await C.getAddress(), await wquai.getAddress()];
      const dl = await deadline();
      for (const bad of [ethers.ZeroAddress, amm.routerAddr]) {
        const r = router.connect(bob);
        await expect(r.addLiquidity(a, b, 1n * E18, 1n * E18, 0, 0, bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.addLiquidityETH(c, 1n * E18, 0, 0, bad, dl, { value: 1n * E18 })).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.removeLiquidity(a, b, 1n, 0, 0, bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.removeLiquidityETH(c, 1n, 0, 0, bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.removeLiquidityWithPermit(a, b, 1n, 0, 0, bad, dl, false, 27, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.removeLiquidityETHWithPermit(c, 1n, 0, 0, bad, dl, false, 27, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapExactTokensForTokens(1n * E18, 0, [a, b], bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapTokensForExactTokens(1n * E18, ethers.MaxUint256, [a, b], bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapExactETHForTokens(0, [w, c], bad, dl, { value: 1n * E18 })).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapTokensForExactETH(1n, ethers.MaxUint256, [c, w], bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapExactTokensForETH(1n * E18, 0, [c, w], bad, dl)).to.be.revertedWithCustomError(router, "InvalidRecipient");
        await expect(r.swapETHForExactTokens(1n, [w, c], bad, dl, { value: 1n * E18 })).to.be.revertedWithCustomError(router, "InvalidRecipient");
      }
      await expectRouterEmpty(amm);
    });
  });

  // ----------------------------------------------------------------------------------------- read-only
  describe("read-only pricing helpers", function () {
    it("quote / getAmountOut / getAmountIn match the reference and reject bad input", async function () {
      const { router } = await loadFixture(fixture);
      expect(await router.quote(10n * E18, 1000n * E18, 4000n * E18)).to.equal(40n * E18);
      expect(await router.getAmountOut(10n * E18, 1000n * E18, 4000n * E18)).to.equal(amountOut(10n * E18, 1000n * E18, 4000n * E18));
      expect(await router.getAmountIn(10n * E18, 1000n * E18, 4000n * E18)).to.equal(amountIn(10n * E18, 1000n * E18, 4000n * E18));
      await expect(router.quote(0, 1, 1)).to.be.reverted;
      await expect(router.quote(1, 0, 1)).to.be.reverted;
      await expect(router.getAmountOut(0, 1, 1)).to.be.reverted;
      await expect(router.getAmountOut(1, 0, 1)).to.be.reverted;
      await expect(router.getAmountIn(0, 1, 1)).to.be.reverted;
      await expect(router.getAmountIn(1, 1, 1)).to.be.reverted; // asking for the whole reserve
    });

    it("what you pay for an exact output, run forward, gives at least that output", async function () {
      const { router } = await loadFixture(fixture);
      for (const [out, rIn, rOut] of [[1n, 10n ** 6n, 10n ** 6n], [999n * E18, 10n ** 24n, 10n ** 24n], [5n, 10n ** 30n, 7n * 10n ** 12n], [12345n, 3n * E18, 5n * E18]] as const) {
        const input = await router.getAmountIn(out, rIn, rOut);
        expect(await router.getAmountOut(input, rIn, rOut)).to.be.gte(out);
      }
    });

    it("getAmountsOut / getAmountsIn need a real path of existing pools", async function () {
      const { router, A, D } = await loadFixture(withPools);
      await expect(router.getAmountsOut(1n, [await A.getAddress()])).to.be.revertedWithCustomError(router, "InvalidPath");
      await expect(router.getAmountsOut(1n, await pathOf(A, D))).to.be.revertedWithCustomError(router, "PairNotFound");
      await expect(router.getAmountsIn(1n, await pathOf(A, D))).to.be.revertedWithCustomError(router, "PairNotFound");
    });
  });

  it("the locked minimum liquidity is never redeemable through the router", async function () {
    const amm = await loadFixture(withPools);
    const { router, factory, A, B, alice } = amm;
    const pair = await pairOf(factory, A, B);
    await pair.connect(alice).approve(amm.routerAddr, ethers.MaxUint256);
    await router.connect(alice).removeLiquidity(await A.getAddress(), await B.getAddress(), await pair.balanceOf(alice.address), 0, 0, alice.address, await deadline());
    expect(await pair.totalSupply()).to.equal(MIN_LIQ);
  });
});
