// Circleswap AMM (packages/contracts/contracts/amm): finding its pools, building swap routes over them, and
// reading and removing an LP position. The factory and router addresses come from the generated
// deployed.ts, and everything here is a no-op or an error naming Circleswap until they are deployed.
//
// Circleswap pools are created by users, so unlike the other DEXes there is no fixed list: the factory is asked
// (allPairsLength / allPairs). A pool's address is only ever read from the factory, never computed.
//
// Selectors (keccak256 of the canonical signature, checked with ethers.id and pinned by the contract tests):
//   allPairsLength()  0x574f2ba3     allPairs(uint256)  0x1e3dd18b
//   removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)  0xbaa2abde

import { quaiCall, getLPReserves, getTokenBalance, decodeBigInt, SELECTORS, DEFAULT_RPC } from './index';
import { isDexLive, requireDex, type PoolInfo, type SwapRoute } from './registries/pools';
import { getTokenByAddress } from './registries/tokens';
import { applySlippage } from './liquidity';

/** More than this many pools are not walked on load; the rest are reported as unlisted. */
export const CIRCLESWAP_MAX_POOLS = 200;
const FAN_OUT = 8;

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');

/** A 32-byte return word; anything else means the call did not reach the contract it was meant for. */
function readWord(hex: unknown, what: string): string {
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`Unexpected reply reading ${what}: ${String(hex).slice(0, 40)}`);
    }
    return hex;
}
const wordToAddress = (hex: unknown, what: string) => '0x' + readWord(hex, what).slice(-40);

/** Symbol for a token address, if it is one the app can price and display (deployed, not the native asset). */
function symbolOf(address: string): string | null {
    const t = getTokenByAddress(address);
    return t && t.deployed !== false && !t.isNative ? t.symbol : null;
}

export interface CircleswapDiscovery {
    /** Pools whose two tokens are both in the token registry, tokens in on-chain token0/token1 order. */
    pools: PoolInfo[];
    /** Every pool the factory has created. */
    total: number;
    /** Pools not in `pools`: a token the app does not know, or beyond CIRCLESWAP_MAX_POOLS. */
    unlisted: number;
}

/** Every Circleswap pool, straight from the factory. Empty (not an error) while Circleswap is not deployed. */
export async function discoverCircleswapPools(rpcUrl: string = DEFAULT_RPC): Promise<CircleswapDiscovery> {
    if (!isDexLive('CIRCLESWAP')) return { pools: [], total: 0, unlisted: 0 };
    const { factory } = requireDex('CIRCLESWAP');

    const total = Number(decodeBigInt(readWord(await quaiCall(factory, '0x574f2ba3', rpcUrl), 'Circleswap allPairsLength')));
    const count = Math.min(total, CIRCLESWAP_MAX_POOLS);

    const pools: PoolInfo[] = [];
    for (let start = 0; start < count; start += FAN_OUT) {
        const batch = await Promise.all(
            Array.from({ length: Math.min(FAN_OUT, count - start) }, async (_, k) => {
                const pair = wordToAddress(await quaiCall(factory, '0x1e3dd18b' + word(BigInt(start + k)), rpcUrl), 'Circleswap allPairs');
                const [t0, t1] = await Promise.all([
                    quaiCall(pair, SELECTORS.token0, rpcUrl),
                    quaiCall(pair, SELECTORS.token1, rpcUrl)
                ]);
                const a = symbolOf(wordToAddress(t0, 'pool token0'));
                const b = symbolOf(wordToAddress(t1, 'pool token1'));
                return a && b ? ({ pair, dex: 'CIRCLESWAP', tokens: [a, b] } as PoolInfo) : null;
            })
        );
        for (const p of batch) if (p) pools.push(p);
    }
    return { pools, total, unlisted: total - pools.length };
}

const pairKey = (a: string, b: string) => [a, b].sort().join('/');

/** Tokens a two-hop Circleswap route may pass through, in order of preference. */
export const CIRCLESWAP_HUBS = ['WQUAI', 'Q0'];

/**
 * Swap routes over the given Circleswap pools: one per pool, plus a two-hop route through a hub token for every
 * pair of tokens that both have a pool with that hub but none of their own (one route per pair, the first hub
 * that works). The router accepts any path, so both settle atomically on Circleswap.
 */
export function buildCircleswapRoutes(pools: PoolInfo[], hubs: string[] = CIRCLESWAP_HUBS): SwapRoute[] {
    const own = pools.filter(p => p.dex === 'CIRCLESWAP');
    const routes: SwapRoute[] = [];
    const covered = new Set<string>();

    for (const p of own) {
        const [a, b] = p.tokens;
        covered.add(pairKey(a, b));
        routes.push({ id: `CIRCLESWAP_${a}_${b}`, label: `${a} / ${b} (Circleswap)`, dex: 'CIRCLESWAP', path: [a, b] });
    }

    for (const hub of hubs) {
        const partners = new Set<string>();
        for (const p of own) {
            if (p.tokens[0] === hub) partners.add(p.tokens[1]);
            else if (p.tokens[1] === hub) partners.add(p.tokens[0]);
        }
        const list = [...partners].sort();
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const key = pairKey(list[i], list[j]);
                if (covered.has(key)) continue;
                covered.add(key);
                routes.push({
                    id: `CIRCLESWAP_${list[i]}_${hub}_${list[j]}`,
                    label: `${list[i]} / ${list[j]} (Circleswap via ${hub})`,
                    dex: 'CIRCLESWAP',
                    path: [list[i], hub, list[j]]
                });
            }
        }
    }
    return routes;
}

export function encodeRemoveLiquidity(p: {
    tokenA: string;
    tokenB: string;
    liquidity: bigint;
    amountAMin: bigint;
    amountBMin: bigint;
    to: string;
    deadline: bigint;
}): string {
    return (
        '0xbaa2abde' +
        addrWord(p.tokenA) +
        addrWord(p.tokenB) +
        word(p.liquidity) +
        word(p.amountAMin) +
        word(p.amountBMin) +
        addrWord(p.to) +
        word(p.deadline)
    );
}

/** LP tokens permanently locked by a pool's first deposit (CircleswapPair.MINIMUM_LIQUIDITY). */
export const LP_MINIMUM_LIQUIDITY = 1000n;

function isqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

/**
 * LP tokens a deposit mints, the way the pool computes it: the first deposit gets sqrt(a * b) minus the locked
 * minimum; later ones get the smaller of the two proportional shares. (Protocol-fee accrual, when the owner has
 * turned it on, can shift the result by a hair.) Zero means the pool would refuse the deposit.
 */
export function estimateLpMint(amountA: bigint, amountB: bigint, reserveA: bigint, reserveB: bigint, totalSupply: bigint): bigint {
    if (amountA <= 0n || amountB <= 0n) return 0n;
    if (totalSupply === 0n) {
        const root = isqrt(amountA * amountB);
        return root > LP_MINIMUM_LIQUIDITY ? root - LP_MINIMUM_LIQUIDITY : 0n;
    }
    if (reserveA <= 0n || reserveB <= 0n) return 0n;
    const a = (amountA * totalSupply) / reserveA;
    const b = (amountB * totalSupply) / reserveB;
    return a < b ? a : b;
}

/** Total supply of an LP token. */
export async function getLpTotalSupply(pair: string, rpcUrl: string = DEFAULT_RPC): Promise<bigint> {
    return decodeBigInt(readWord(await quaiCall(pair, SELECTORS.totalSupply, rpcUrl), 'LP totalSupply'));
}

/** What `lpAmount` of an LP token is worth in each pool token, at the pool's current reserves (rounded down). */
export function lpUnderlying(lpAmount: bigint, totalSupply: bigint, reserve0: bigint, reserve1: bigint): [bigint, bigint] {
    if (lpAmount <= 0n || totalSupply <= 0n) return [0n, 0n];
    const share = lpAmount > totalSupply ? totalSupply : lpAmount;
    return [(share * reserve0) / totalSupply, (share * reserve1) / totalSupply];
}

/** The smallest amounts a removal may pay out, given a slippage tolerance. */
export function removeLiquidityMins(amount0: bigint, amount1: bigint, slippagePct: number): [bigint, bigint] {
    return [applySlippage(amount0, slippagePct), applySlippage(amount1, slippagePct)];
}

export interface LpPosition {
    pair: string;
    token0: string;
    token1: string;
    /** LP tokens held. */
    balance: bigint;
    totalSupply: bigint;
    /** The pool's reserves, in its own token0 / token1 order. */
    reserve0: bigint;
    reserve1: bigint;
    /** Share of the pool, in percent. */
    sharePct: number;
    /** Estimated pool tokens returned by removing everything now (protocol-fee accrual not included). */
    amount0: bigint;
    amount1: bigint;
}

/** An account's position in one V2-style pool, from live chain state. */
export async function getLpPosition(pair: string, owner: string, rpcUrl: string = DEFAULT_RPC): Promise<LpPosition> {
    const [res, balance, totalSupply] = await Promise.all([
        getLPReserves(pair, rpcUrl),
        getTokenBalance(pair, owner, rpcUrl),
        getLpTotalSupply(pair, rpcUrl)
    ]);
    const bal = BigInt(balance);
    const reserve0 = BigInt(res.reserve0);
    const reserve1 = BigInt(res.reserve1);
    const [amount0, amount1] = lpUnderlying(bal, totalSupply, reserve0, reserve1);
    return {
        pair,
        token0: res.token0,
        token1: res.token1,
        balance: bal,
        totalSupply,
        reserve0,
        reserve1,
        sharePct: totalSupply > 0n ? Number((bal * 10_000_000n) / totalSupply) / 100_000 : 0,
        amount0,
        amount1
    };
}
