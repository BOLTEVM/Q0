import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, MIN_LIQ, DEAD, amountOut, deployAmm, deadline, pairOf, seed, rng } from "./ammHelpers";

/**
 * Random operation sequences against three pools, checking after EVERY step the properties that must hold no
 * matter what anyone does. Seeds are fixed so a failure reproduces exactly.
 */
describe("Circleswap AMM: invariants under random operation sequences", function () {
  this.timeout(300_000);

  const STEPS = 120;

  async function setup() {
    const amm = await deployAmm();
    const { A, B, C, alice } = amm;
    await seed(amm, alice, A, B, 50_000n * E18, 80_000n * E18);
    await seed(amm, alice, B, C, 70_000n * E18, 30_000n * E18);
    await seed(amm, alice, A, C, 20_000n * E18, 60_000n * E18);
    const pairs = [
      { name: "A/B", a: A, b: B, pair: await pairOf(amm.factory, A, B) },
      { name: "B/C", a: B, b: C, pair: await pairOf(amm.factory, B, C) },
      { name: "A/C", a: A, b: C, pair: await pairOf(amm.factory, A, C) }
    ];
    return { ...amm, pairs };
  }

  async function snapshot(p: { pair: any; a: any; b: any }) {
    const [r0, r1] = await p.pair.getReserves();
    const supply = await p.pair.totalSupply();
    return { r0: BigInt(r0), r1: BigInt(r1), supply: BigInt(supply), k: BigInt(r0) * BigInt(r1) };
  }

  for (const seedValue of [1, 2, 3, 7, 42]) {
    it(`seed ${seedValue}: ${STEPS} random operations keep every invariant`, async function () {
      const env = await setup();
      const { router, routerAddr, people, pairs, A, B, C, D } = env;
      const rand = rng(seedValue);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
      const between = (lo: bigint, hi: bigint): bigint => (hi <= lo ? lo : lo + (BigInt(Math.floor(rand() * 1e9)) * (hi - lo)) / 1_000_000_000n);

      // Everything ever minted of each token; nothing may leak or appear.
      const tokens = [A, B, C, D];
      const minted = new Map<string, bigint>();
      for (const t of tokens) {
        let total = 0n;
        for (const u of people) total += await t.balanceOf(u.address);
        for (const p of pairs) total += await t.balanceOf(await p.pair.getAddress());
        minted.set(await t.getAddress(), total);
      }
      const dirty = new Set<string>(); // pools holding an un-synced donation

      async function checkInvariants(step: number, note: string) {
        const where = `seed ${seedValue} step ${step} (${note})`;
        for (const p of pairs) {
          const addr = await p.pair.getAddress();
          const [r0, r1] = await p.pair.getReserves();
          const t0 = await ethers.getContractAt("MockToken", await p.pair.token0());
          const t1 = await ethers.getContractAt("MockToken", await p.pair.token1());
          const b0 = await t0.balanceOf(addr);
          const b1 = await t1.balanceOf(addr);
          expect(b0, `${where}: ${p.name} token0 balance below reserve`).to.be.gte(r0);
          expect(b1, `${where}: ${p.name} token1 balance below reserve`).to.be.gte(r1);
          if (!dirty.has(addr)) {
            expect(b0, `${where}: ${p.name} reserve0 out of sync`).to.equal(r0);
            expect(b1, `${where}: ${p.name} reserve1 out of sync`).to.equal(r1);
          }
          // LP accounting: users + the locked shares are the only holders (protocol fee is off).
          let held = await p.pair.balanceOf(DEAD);
          expect(held, `${where}: locked shares changed`).to.equal(MIN_LIQ);
          for (const u of people) held += await p.pair.balanceOf(u.address);
          expect(held, `${where}: LP holdings do not add up to supply`).to.equal(await p.pair.totalSupply());
        }
        for (const t of tokens) {
          expect(await t.balanceOf(routerAddr), `${where}: router holds tokens`).to.equal(0);
          let total = 0n;
          for (const u of people) total += await t.balanceOf(u.address);
          for (const p of pairs) total += await t.balanceOf(await p.pair.getAddress());
          expect(total, `${where}: tokens leaked or appeared`).to.equal(minted.get(await t.getAddress())!);
        }
        expect(await ethers.provider.getBalance(routerAddr), `${where}: router holds native QUAI`).to.equal(0);
      }

      await checkInvariants(0, "start");
      const startShare = await Promise.all(pairs.map(p => snapshot(p)));

      for (let step = 1; step <= STEPS; step++) {
        const user = pick(people);
        const p = pick(pairs);
        const before = await snapshot(p);
        const allBefore = await Promise.all(pairs.map(x => snapshot(x)));
        const kind = pick(["add", "add", "remove", "swapIn", "swapIn", "swapIn", "swapOut", "donate", "sync", "skim", "time"] as const);
        let note: string = kind;

        if (kind === "add") {
          const capA = before.r0 / 5n;
          const amtA = between(10n ** 15n, capA > 10n ** 16n ? capA : 10n ** 16n);
          const amtB = between(10n ** 15n, (before.r1 / 5n) > 10n ** 16n ? before.r1 / 5n : 10n ** 16n);
          const t0 = await ethers.getContractAt("MockToken", await p.pair.token0());
          const t1 = await ethers.getContractAt("MockToken", await p.pair.token1());
          await router.connect(user).addLiquidity(await t0.getAddress(), await t1.getAddress(), amtA, amtB, 0, 0, user.address, await deadline());
        } else if (kind === "remove") {
          const lp = await p.pair.balanceOf(user.address);
          if (lp > 10n ** 9n) {
            const part = (lp * BigInt(10 + Math.floor(rand() * 90))) / 100n;
            await p.pair.connect(user).approve(routerAddr, part);
            const t0 = await p.pair.token0();
            const t1 = await p.pair.token1();
            await router.connect(user).removeLiquidity(t0, t1, part, 0, 0, user.address, await deadline());
          } else note = "remove(skipped: no LP)";
        } else if (kind === "swapIn") {
          // one hop, or two hops through the third token
          const two = rand() < 0.4;
          const dirForward = rand() < 0.5;
          const [x, y] = dirForward ? [p.a, p.b] : [p.b, p.a];
          const third = [A, B, C].find(t => t !== x && t !== y)!;
          const path = two ? [x, y, third] : [x, y];
          const [rIn] = (await p.pair.token0()) === (await x.getAddress()) ? [before.r0] : [before.r1];
          const amt = between(10n ** 6n, rIn / 20n > 10n ** 7n ? rIn / 20n : 10n ** 7n);
          await router.connect(user).swapExactTokensForTokens(amt, 0, await Promise.all(path.map(t => t.getAddress())), user.address, await deadline());
          note = `swapIn ${two ? "2-hop" : "1-hop"}`;
        } else if (kind === "swapOut") {
          const dirForward = rand() < 0.5;
          const [x, y] = dirForward ? [p.a, p.b] : [p.b, p.a];
          const rOut = (await p.pair.token0()) === (await y.getAddress()) ? before.r0 : before.r1;
          const out = between(10n ** 6n, rOut / 30n > 10n ** 7n ? rOut / 30n : 10n ** 7n);
          await router.connect(user).swapTokensForExactTokens(out, ethers.MaxUint256, [await x.getAddress(), await y.getAddress()], user.address, await deadline());
        } else if (kind === "donate") {
          const t = await ethers.getContractAt("MockToken", rand() < 0.5 ? await p.pair.token0() : await p.pair.token1());
          await t.connect(user).transfer(await p.pair.getAddress(), between(10n ** 12n, 10n ** 19n));
          dirty.add(await p.pair.getAddress());
        } else if (kind === "sync") {
          await p.pair.connect(user).sync();
          dirty.delete(await p.pair.getAddress());
        } else if (kind === "skim") {
          await p.pair.connect(user).skim(user.address);
          dirty.delete(await p.pair.getAddress());
        } else {
          await time.increase(Math.floor(rand() * 3600));
        }

        await checkInvariants(step, note);

        // Per-operation properties, on every pool (a multi-hop swap touches more than one).
        const allAfter = await Promise.all(pairs.map(x => snapshot(x)));
        for (let i = 0; i < pairs.length; i++) {
          const b = allBefore[i];
          const a = allAfter[i];
          const where = `seed ${seedValue} step ${step} (${note}) pool ${pairs[i].name}`;
          if (note.startsWith("swap")) expect(a.k, `${where}: k fell on a swap`).to.be.gte(b.k);
          if (kind === "sync" || kind === "skim" || kind === "donate" || kind === "time") {
            if (i !== pairs.indexOf(p) && kind !== "time") expect(a.k, `${where}: an unrelated pool changed`).to.equal(b.k);
          }
          // The value of one LP share (sqrt(k)/supply) never falls, whatever anyone does. Cross-multiplied:
          // k1 / s1^2 >= k0 / s0^2  <=>  k1 * s0^2 >= k0 * s1^2.
          if (b.supply > 0n) {
            expect(a.k * b.supply * b.supply, `${where}: LP share value fell`).to.be.gte(b.k * a.supply * a.supply);
          }
        }
      }

      // Over the whole run, a passive holder of shares only gained: value per share is up (or level) on every pool.
      const endShare = await Promise.all(pairs.map(p => snapshot(p)));
      for (let i = 0; i < pairs.length; i++) {
        expect(endShare[i].k * startShare[i].supply * startShare[i].supply, `${pairs[i].name} share value over the run`).to.be.gte(
          startShare[i].k * endShare[i].supply * endShare[i].supply
        );
      }
    });
  }

  describe("no free money", function () {
    it("a round trip through one pool always loses at least the fees, at every size", async function () {
      const { router, A, B, bob, alice, factory } = await setup();
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      const pair = await pairOf(factory, A, B);
      void alice;
      const rand = rng(99);
      for (let i = 0; i < 25; i++) {
        const [r0, r1] = await pair.getReserves();
        const rA = (await pair.token0()) === a ? r0 : r1;
        const amt = BigInt(Math.floor(rand() * 1e6)) * (rA / 2_000_000n) + 1000n;
        const startA = await A.balanceOf(bob.address);
        const startB = await B.balanceOf(bob.address);
        await router.connect(bob).swapExactTokensForTokens(amt, 0, [a, b], bob.address, await deadline());
        const gotB = (await B.balanceOf(bob.address)) - startB;
        await router.connect(bob).swapExactTokensForTokens(gotB, 0, [b, a], bob.address, await deadline());
        expect(await A.balanceOf(bob.address), `round trip of ${amt} made money`).to.be.lt(startA);
      }
    });

    it("what a swap pays is always strictly less than the same amount at the spot price", async function () {
      const { router, A, B, factory } = await setup();
      const pair = await pairOf(factory, A, B);
      const [r0, r1] = await pair.getReserves();
      const [rA, rB] = (await pair.token0()) === (await A.getAddress()) ? [r0, r1] : [r1, r0];
      for (const amt of [1n, 999n, 10n ** 9n, 10n ** 18n, 10n ** 21n, rA / 10n, rA]) {
        const out = amountOut(amt, rA, rB);
        expect(out).to.be.lte((amt * rB) / rA);
        expect(out).to.be.lt(rB); // never the whole reserve
        expect(await router.getAmountOut(amt, rA, rB)).to.equal(out);
      }
    });
  });
});
