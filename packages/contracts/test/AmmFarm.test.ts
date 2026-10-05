import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, deployAmm, deadline, pairOf, reservesOf, seed } from "./ammHelpers";
import { stamp, deployQrb, BOOST_MATURITY, BOOST_THRESHOLD } from "./helpers";

const RATE = E18;

/** Circleswap LP tokens are ordinary ERC-20s, so the dual-reward farm can stake them like any other LP. */
describe("Circleswap AMM: LP tokens in the dual-reward farm", function () {
  async function fixture() {
    const amm = await deployAmm();
    const { A, B, alice, bob, owner } = amm;
    await seed(amm, alice, A, B, 10_000n * E18, 10_000n * E18);
    const pair = await pairOf(amm.factory, A, B);

    const Mock = await ethers.getContractFactory("MockERC20");
    const [bdelta, q0] = [await Mock.deploy("BoltDelta", "BDELTA"), await Mock.deploy("QBOLT", "Q0")];
    const qrb = await deployQrb(owner.address);
    await qrb.mintGenesis(owner.address);
    const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(
      owner.address, await bdelta.getAddress(), await q0.getAddress(), await qrb.getAddress(), RATE, RATE
    );
    await bdelta.mint(await chef.getAddress(), 1_000_000n * E18);
    await q0.mint(await chef.getAddress(), 1_000_000n * E18);
    await chef.addPool(100, await pair.getAddress());
    await pair.connect(alice).approve(await chef.getAddress(), ethers.MaxUint256);
    await pair.connect(alice).transfer(bob.address, (await pair.balanceOf(alice.address)) / 2n);
    await pair.connect(bob).approve(await chef.getAddress(), ethers.MaxUint256);
    return { ...amm, pair, chef, bdelta, q0, qrb };
  }

  it("stake, earn both rewards, unstake, and remove liquidity: nothing is lost on the way", async function () {
    const { chef, pair, router, A, B, alice, bdelta, q0 } = await loadFixture(fixture);
    const lp = await pair.balanceOf(alice.address);
    const t0 = await stamp(await chef.connect(alice).deposit(0, lp));
    expect(await pair.balanceOf(alice.address)).to.equal(0);
    expect(await chef.stakedByToken(await pair.getAddress())).to.equal(lp);
    await time.increase(1000);
    const t1 = await stamp(await chef.connect(alice).withdraw(0, lp));
    expect(await pair.balanceOf(alice.address)).to.equal(lp); // the LP tokens come back untouched
    expect(await bdelta.balanceOf(alice.address)).to.be.gt(0);
    expect(await q0.balanceOf(alice.address)).to.be.gt(0);
    void t0; void t1;

    // And the position is still redeemable for the underlying.
    await pair.connect(alice).approve(await router.getAddress(), lp);
    const beforeA = await A.balanceOf(alice.address);
    await router.connect(alice).removeLiquidity(await A.getAddress(), await B.getAddress(), lp, 0, 0, alice.address, await deadline());
    expect((await A.balanceOf(alice.address)) - beforeA).to.be.gt(0);
  });

  it("swap fees keep accruing to the staked LP: redeeming after the farm returns more than was put in", async function () {
    const { chef, pair, router, A, B, alice, bob } = await loadFixture(fixture);
    const [a, b] = [await A.getAddress(), await B.getAddress()];
    const lp = await pair.balanceOf(alice.address);
    const [rA0, rB0] = await reservesOf(pair, A);
    const supply0 = await pair.totalSupply();
    const worthA0 = (lp * rA0) / supply0;
    const worthB0 = (lp * rB0) / supply0;

    await chef.connect(alice).deposit(0, lp);
    // Traders churn the pool while the LP sits in the farm.
    for (let i = 0; i < 10; i++) {
      await router.connect(bob).swapExactTokensForTokens(500n * E18, 0, [a, b], bob.address, await deadline());
      await router.connect(bob).swapExactTokensForTokens(500n * E18, 0, [b, a], bob.address, await deadline());
    }
    await chef.connect(alice).withdraw(0, lp);

    const [rA1, rB1] = await reservesOf(pair, A);
    const supply1 = await pair.totalSupply();
    const worthA1 = (lp * rA1) / supply1;
    const worthB1 = (lp * rB1) / supply1;
    // Both sides of the position are worth at least what they were, and the product (value) strictly more.
    expect(worthA1 * worthB1).to.be.gt(worthA0 * worthB0);
  });

  it("a farmer holding QRB for the full period earns the boost on Circleswap LP just like on any other LP", async function () {
    const { chef, pair, qrb, owner, alice, bob, bdelta } = await loadFixture(fixture);
    await qrb.transfer(alice.address, BOOST_THRESHOLD);
    const lpA = await pair.balanceOf(alice.address);
    const lpB = await pair.balanceOf(bob.address);
    await chef.connect(alice).deposit(0, lpA);
    await chef.connect(bob).deposit(0, lpB);
    await time.increase(Number(BOOST_MATURITY) + 1000);
    await chef.connect(alice).harvest(0);
    await chef.connect(bob).harvest(0);
    const a = await bdelta.balanceOf(alice.address);
    const b = await bdelta.balanceOf(bob.address);
    expect(Number(a) / Number(b)).to.be.closeTo(1.5, 0.05); // equal stakes, +50% for the QRB holder
    void owner;
  });

  it("emergencyWithdraw returns Circleswap LP whole, so a farm problem never traps a liquidity position", async function () {
    const { chef, pair, alice } = await loadFixture(fixture);
    const lp = await pair.balanceOf(alice.address);
    await chef.connect(alice).deposit(0, lp);
    await chef.pause();
    await chef.connect(alice).emergencyWithdraw(0);
    expect(await pair.balanceOf(alice.address)).to.equal(lp);
  });
});
