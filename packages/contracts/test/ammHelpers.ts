import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

export const E18 = 10n ** 18n;
export const MIN_LIQ = 1000n;
export const DEAD = "0x000000000000000000000000000000000000dEaD";

/** Reference implementations, in plain BigInt, of the pricing the contracts must match exactly. */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}
export function amountIn(out: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (reserveIn * out * 1000n) / ((reserveOut - out) * 997n) + 1n;
}
export function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export const deadline = async (secs = 3600) => (await time.latest()) + secs;

export async function deployAmm(users: number = 4) {
  const signers = await ethers.getSigners();
  const [owner, ...rest] = signers;
  const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
  const FactoryFactory = await ethers.getContractFactory("CircleswapFactory");
  const factoryImpl = await FactoryFactory.deploy();
  const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const factoryProxy = await ERC1967ProxyFactory.deploy(
    await factoryImpl.getAddress(),
    FactoryFactory.interface.encodeFunctionData("initialize", [owner.address])
  );
  const factory = FactoryFactory.attach(await factoryProxy.getAddress()) as any;

  const RouterFactory = await ethers.getContractFactory("CircleswapRouter");
  const routerImpl = await RouterFactory.deploy();
  const routerProxy = await ERC1967ProxyFactory.deploy(
    await routerImpl.getAddress(),
    RouterFactory.interface.encodeFunctionData("initialize", [await factory.getAddress(), await wquai.getAddress(), owner.address])
  );
  const router = RouterFactory.attach(await routerProxy.getAddress()) as any;
  const Token = await ethers.getContractFactory("MockToken");
  const A = await Token.deploy("Token A", "AAA", 18);
  const B = await Token.deploy("Token B", "BBB", 18);
  const C = await Token.deploy("Token C", "CCC", 18);
  const D = await Token.deploy("Token D", "DDD", 18);
  const routerAddr = await router.getAddress();
  const people = rest.slice(0, users);
  for (const u of people) {
    for (const t of [A, B, C, D]) {
      await t.mint(u.address, 1_000_000_000n * E18);
      await t.connect(u).approve(routerAddr, ethers.MaxUint256);
    }
  }
  return { owner, alice: people[0], bob: people[1], carol: people[2], dave: people[3], people, wquai, factory, router, A, B, C, D, routerAddr };
}

export type Amm = Awaited<ReturnType<typeof deployAmm>>;

/** The pool contract for two tokens (throws if there is none). */
export async function pairOf(factory: any, a: any, b: any) {
  const addr = await factory.getPair(await a.getAddress(), await b.getAddress());
  if (addr === ethers.ZeroAddress) throw new Error("no such pair");
  return ethers.getContractAt("CircleswapPair", addr);
}

/** Reserves oriented as (reserve of tokenA, reserve of tokenB), whatever the pool's own token0/token1 order. */
export async function reservesOf(pair: any, tokenA: any): Promise<[bigint, bigint]> {
  const [r0, r1] = await pair.getReserves();
  return (await pair.token0()) === (await tokenA.getAddress()) ? [r0, r1] : [r1, r0];
}

/** Add liquidity through the router as `user`. */
export async function seed(amm: Amm, user: any, a: any, b: any, amtA: bigint, amtB: bigint, to?: string) {
  return amm.router
    .connect(user)
    .addLiquidity(await a.getAddress(), await b.getAddress(), amtA, amtB, 0, 0, to ?? user.address, await deadline());
}

/** A pool seeded by alice with the given reserves. */
export async function poolWith(amm: Amm, a: any, b: any, amtA: bigint, amtB: bigint) {
  await seed(amm, amm.alice, a, b, amtA, amtB);
  return pairOf(amm.factory, a, b);
}

/** Send tokens straight to a pool and mint LP for `to`: the raw path the router uses, for pool-level tests. */
export async function rawMint(pair: any, a: any, b: any, user: any, amtA: bigint, amtB: bigint, to?: string) {
  await a.connect(user).transfer(await pair.getAddress(), amtA);
  await b.connect(user).transfer(await pair.getAddress(), amtB);
  return pair.connect(user).mint(to ?? user.address);
}

/** Deterministic PRNG so property tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
