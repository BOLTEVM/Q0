import { describe, test, expect, afterEach } from 'bun:test';
import {
    DEXES,
    isDexLive,
    requireDex,
    tokenAddress,
    discoverCircleswapPools,
    buildCircleswapRoutes,
    encodeRemoveLiquidity,
    lpUnderlying,
    estimateLpMint,
    LP_MINIMUM_LIQUIDITY,
    removeLiquidityMins,
    getLpPosition,
    getPairAddress,
    quoteRoute,
    CIRCLESWAP_MAX_POOLS,
    type PoolInfo,
    type LPReserves
} from '../packages/quai-service/src/index';

const E18 = 10n ** 18n;
const FACTORY = '0x0007E61D3C1fa9d3A8dA1e0F9d4E6e56C1a9c8B2';
const ROUTER = '0x003Ce6685Ff0C6b5F0bd6a0c93e9c2D2f3b7A1C4';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const addrWord = (a: string) => '0x' + a.replace('0x', '').toLowerCase().padStart(64, '0');
const pairAt = (i: number) => '0x00' + (i + 1).toString(16).padStart(38, '0');

/** Runs `fn` with Circleswap pointed at a (fake) factory and router, then puts it back. */
async function withCircleswapLive<T>(fn: () => Promise<T> | T): Promise<T> {
    // `factory` and `router` are getters over the deployed addresses (so a deployment applied at start-up is seen), so they are
    // replaced as properties and the original descriptors put back, rather than assigned.
    const before = {
        factory: Object.getOwnPropertyDescriptor(DEXES.CIRCLESWAP, 'factory')!,
        router: Object.getOwnPropertyDescriptor(DEXES.CIRCLESWAP, 'router')!
    };
    Object.defineProperty(DEXES.CIRCLESWAP, 'factory', { value: FACTORY, configurable: true, writable: true, enumerable: true });
    Object.defineProperty(DEXES.CIRCLESWAP, 'router', { value: ROUTER, configurable: true, writable: true, enumerable: true });
    try {
        return await fn();
    } finally {
        Object.defineProperty(DEXES.CIRCLESWAP, 'factory', before.factory);
        Object.defineProperty(DEXES.CIRCLESWAP, 'router', before.router);
    }
}

const cs = (a: string, b: string, pair = '0x0000000000000000000000000000000000000abc'): PoolInfo => ({ pair, dex: 'CIRCLESWAP', tokens: [a, b] });

describe('the Circleswap DEX before it is deployed', () => {
    test('is not live, and nothing can be sent to it', () => {
        expect(DEXES.CIRCLESWAP.factory).toBeNull();
        expect(DEXES.CIRCLESWAP.router).toBeNull();
        expect(isDexLive('CIRCLESWAP')).toBe(false);
        expect(() => requireDex('CIRCLESWAP')).toThrow('Circleswap is not deployed yet');
    });

    test('the other two DEXes are unaffected', () => {
        expect(isDexLive('QUAISWAP')).toBe(true);
        expect(isDexLive('QUAINANCE')).toBe(true);
        expect(requireDex('QUAISWAP').router).toBe(DEXES.QUAISWAP.router);
    });

    test('pool lookup refuses instead of querying a null factory', async () => {
        await expect(getPairAddress('CIRCLESWAP', 'BDELTA', 'Q0')).rejects.toThrow('not deployed yet');
    });

    test('discovery is empty, not an error, and makes no network call', async () => {
        const realFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async () => { calls++; throw new Error('no network expected'); }) as any;
        try {
            expect(await discoverCircleswapPools()).toEqual({ pools: [], total: 0, unlisted: 0 });
            expect(calls).toBe(0);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('Circleswap pool discovery and position reads (stubbed chain)', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** A factory holding these pools (each a [token0, token1] symbol pair, or raw addresses), answered by call data. */
    function stubChain(pools: [string, string][], extra: (to: string, data: string) => string | undefined = () => undefined) {
        const seen: { to: string; data: string }[] = [];
        globalThis.fetch = (async (_url: any, init: any) => {
            const body = JSON.parse(init.body);
            const { to, data } = body.params[0];
            seen.push({ to, data });
            const custom = extra(to, data);
            let result: string;
            if (custom !== undefined) result = custom;
            else if (to.toLowerCase() === FACTORY.toLowerCase() && data.startsWith('0x574f2ba3')) result = word(BigInt(pools.length));
            else if (to.toLowerCase() === FACTORY.toLowerCase() && data.startsWith('0x1e3dd18b')) result = addrWord(pairAt(Number(BigInt('0x' + data.slice(10)))));
            else {
                const idx = pools.findIndex((_, i) => pairAt(i).toLowerCase() === to.toLowerCase());
                if (idx < 0) throw new Error('unexpected call to ' + to);
                const sym = pools[idx][data.startsWith('0x0dfe1681') ? 0 : 1];
                result = addrWord(sym.startsWith('0x') ? sym : tokenAddress(sym));
            }
            return { ok: true, statusText: 'OK', json: async () => ({ result }) };
        }) as any;
        return seen;
    }

    test('lists every pool the factory has created, with tokens in on-chain order', async () => {
        await withCircleswapLive(async () => {
            stubChain([['BDELTA', 'Q0'], ['Q0', 'WQUAI'], ['WQUAI', 'BDELTA']]);
            const found = await discoverCircleswapPools();
            expect(found.total).toBe(3);
            expect(found.unlisted).toBe(0);
            expect(found.pools.map(p => p.tokens)).toEqual([['BDELTA', 'Q0'], ['Q0', 'WQUAI'], ['WQUAI', 'BDELTA']]);
            expect(found.pools.every(p => p.dex === 'CIRCLESWAP')).toBe(true);
            expect(found.pools[0].pair.toLowerCase()).toBe(pairAt(0).toLowerCase());
        });
    });

    test('a pool of a token the app does not know is counted as unlisted, not shown and not an error', async () => {
        await withCircleswapLive(async () => {
            const stranger = '0x00abcdef00000000000000000000000000000001';
            stubChain([['BDELTA', 'Q0'], ['Q0', stranger]]);
            const found = await discoverCircleswapPools();
            expect(found.total).toBe(2);
            expect(found.pools.length).toBe(1);
            expect(found.unlisted).toBe(1);
        });
    });

    test('the native placeholder and the undeployed Qrb address never pass for a token', async () => {
        await withCircleswapLive(async () => {
            const native = '0x0000000000000000000000000000000000000000';
            stubChain([['Q0', native]]);
            expect((await discoverCircleswapPools()).pools).toEqual([]);
        });
    });

    test('reads at most CIRCLESWAP_MAX_POOLS and says how many it left out', async () => {
        await withCircleswapLive(async () => {
            const many: [string, string][] = Array.from({ length: CIRCLESWAP_MAX_POOLS + 25 }, () => ['BDELTA', 'Q0']);
            const seen = stubChain(many);
            const found = await discoverCircleswapPools();
            expect(found.total).toBe(CIRCLESWAP_MAX_POOLS + 25);
            expect(found.pools.length).toBe(CIRCLESWAP_MAX_POOLS);
            expect(found.unlisted).toBe(25);
            expect(seen.filter(s => s.data.startsWith('0x1e3dd18b')).length).toBe(CIRCLESWAP_MAX_POOLS);
        });
    });

    test('a node that answers with something that is not a word is an error, never an empty list', async () => {
        await withCircleswapLive(async () => {
            stubChain([['BDELTA', 'Q0']], () => '0x');
            await expect(discoverCircleswapPools()).rejects.toThrow('Unexpected reply');
        });
    });

    test('getPairAddress uses the Circleswap factory when it is live', async () => {
        await withCircleswapLive(async () => {
            const seen = stubChain([], (to, data) => (data.startsWith('0xe6a43905') ? addrWord(pairAt(4)) : undefined));
            const pair = await getPairAddress('CIRCLESWAP', 'BDELTA', 'Q0');
            expect(pair!.toLowerCase()).toBe(pairAt(4).toLowerCase());
            expect(seen[0].to.toLowerCase()).toBe(FACTORY.toLowerCase());
        });
    });

    test('getLpPosition: balance, share of the pool, and what it redeems for', async () => {
        const holder = '0x00c0ffee00000000000000000000000000000001';
        const pair = pairAt(0);
        const reserves = word(1000n * E18).slice(2) + word(4000n * E18).slice(2) + word(1_700_000_000n).slice(2);
        stubChain([['BDELTA', 'Q0']], (to, data) => {
            if (to.toLowerCase() !== pair.toLowerCase()) return undefined;
            if (data.startsWith('0x0902f1ac')) return '0x' + reserves;
            if (data.startsWith('0x70a08231')) return word(100n * E18); // holder's LP
            if (data.startsWith('0x18160ddd')) return word(2000n * E18); // total LP
            return undefined;
        });
        const pos = await getLpPosition(pair, holder);
        expect(pos.balance).toBe(100n * E18);
        expect(pos.totalSupply).toBe(2000n * E18);
        expect(pos.reserve0).toBe(1000n * E18);
        expect(pos.reserve1).toBe(4000n * E18);
        expect(pos.sharePct).toBeCloseTo(5, 5);
        expect(pos.amount0).toBe(50n * E18); // 5% of 1000
        expect(pos.amount1).toBe(200n * E18); // 5% of 4000
        expect(pos.token0.toLowerCase()).toBe(tokenAddress('BDELTA').toLowerCase());
    });
});

describe('Circleswap routes', () => {
    test('one route per pool, labelled with the DEX', () => {
        const routes = buildCircleswapRoutes([cs('BDELTA', 'Q0')]);
        expect(routes).toEqual([{ id: 'CIRCLESWAP_BDELTA_Q0', label: 'BDELTA / Q0 (Circleswap)', dex: 'CIRCLESWAP', path: ['BDELTA', 'Q0'] }]);
    });

    test('two tokens that each pair with WQUAI but not with each other get a two-hop route, once', () => {
        const routes = buildCircleswapRoutes([cs('BDELTA', 'WQUAI', '0xa1'), cs('Q0', 'WQUAI', '0xa2')]);
        const hop = routes.filter(r => r.path.length === 3);
        expect(hop.length).toBe(1);
        expect(hop[0].path).toEqual(['BDELTA', 'WQUAI', 'Q0']);
        expect(hop[0].label).toContain('via WQUAI');
        expect(routes.length).toBe(3);
    });

    test('Q0 is a hub too, so BDELTA and WQUAI can trade through it, and each pair gets exactly one route', () => {
        const routes = buildCircleswapRoutes([cs('BDELTA', 'Q0', '0xa1'), cs('Q0', 'WQUAI', '0xa2')]);
        const hop = routes.filter(r => r.path.length === 3);
        expect(hop.map(r => r.path)).toEqual([['BDELTA', 'Q0', 'WQUAI']]);
        expect(hop[0].label).toBe('BDELTA / WQUAI (Circleswap via Q0)');
        // Both hubs qualify for BOSS/LAPTOP (each pairs with WQUAI and with Q0): WQUAI wins, and there is no duplicate.
        const both = buildCircleswapRoutes([
            cs('BOSS', 'WQUAI', '0xb1'), cs('LAPTOP', 'WQUAI', '0xb2'), cs('BOSS', 'Q0', '0xb3'), cs('LAPTOP', 'Q0', '0xb4')
        ]).filter(r => r.path.length === 3);
        expect(both.map(r => r.path)).toEqual([['BOSS', 'WQUAI', 'LAPTOP']]);
    });

    test('no two-hop route is added when the two tokens already share a pool', () => {
        const routes = buildCircleswapRoutes([cs('BDELTA', 'WQUAI', '0xa1'), cs('Q0', 'WQUAI', '0xa2'), cs('Q0', 'BDELTA', '0xa3')]);
        expect(routes.filter(r => r.path.length === 3)).toEqual([]);
    });

    test('other DEXes\' pools are ignored', () => {
        const other: PoolInfo = { pair: '0xb1', dex: 'QUAISWAP', tokens: ['Q0', 'WQUAI'] };
        expect(buildCircleswapRoutes([other])).toEqual([]);
    });

    test('a discovered route quotes exactly like the contract: 0.3% fee, hop by hop', () => {
        const pools = [cs('BDELTA', 'WQUAI', '0xa1'), cs('Q0', 'WQUAI', '0xa2')];
        const route = buildCircleswapRoutes(pools).find(r => r.path.length === 3)!;
        const res = (t0: string, t1: string, r0: bigint, r1: bigint): LPReserves => ({ token0: tokenAddress(t0), token1: tokenAddress(t1), reserve0: r0.toString(), reserve1: r1.toString(), blockTime: 0 });
        const reserves = {
            '0xa1': res('BDELTA', 'WQUAI', 1000n * E18, 2000n * E18),
            '0xa2': res('Q0', 'WQUAI', 5000n * E18, 3000n * E18)
        };
        const amountIn = 10n * E18;
        const q = quoteRoute(route, false, amountIn, reserves, 1, pools)!;

        const out = (i: bigint, rin: bigint, rout: bigint) => (i * 997n * rout) / (rin * 1000n + i * 997n);
        const mid = out(amountIn, 1000n * E18, 2000n * E18); // BDELTA -> WQUAI
        const last = out(mid, 3000n * E18, 5000n * E18); // WQUAI -> Q0 (the pool is Q0/WQUAI, so reserves swap roles)
        expect(q.amountOut).toBe(last);
        expect(q.minimumReceived).toBe((last * 9900n) / 10000n);
    });
});

describe('removing liquidity', () => {
    test('encodes removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) with selector 0xbaa2abde', () => {
        const data = encodeRemoveLiquidity({
            tokenA: tokenAddress('BDELTA'),
            tokenB: tokenAddress('Q0'),
            liquidity: 5n,
            amountAMin: 6n,
            amountBMin: 7n,
            to: '0x00c0ffee00000000000000000000000000000001',
            deadline: 9n
        });
        expect(data.slice(0, 10)).toBe('0xbaa2abde');
        expect(data.length).toBe(2 + 8 + 7 * 64);
        const args = data.slice(10).match(/.{64}/g)!;
        expect(args[0].slice(24)).toBe(tokenAddress('BDELTA').slice(2).toLowerCase());
        expect(args[1].slice(24)).toBe(tokenAddress('Q0').slice(2).toLowerCase());
        expect(BigInt('0x' + args[2])).toBe(5n);
        expect(BigInt('0x' + args[3])).toBe(6n);
        expect(BigInt('0x' + args[4])).toBe(7n);
        expect(args[5].slice(24)).toBe('00c0ffee00000000000000000000000000000001');
        expect(BigInt('0x' + args[6])).toBe(9n);
    });

    test('lpUnderlying is the pro-rata share, rounded down, and never more than the whole pool', () => {
        expect(lpUnderlying(100n, 1000n, 500n, 2000n)).toEqual([50n, 200n]);
        expect(lpUnderlying(1n, 3n, 10n, 10n)).toEqual([3n, 3n]); // floor(10/3)
        expect(lpUnderlying(5000n, 1000n, 500n, 2000n)).toEqual([500n, 2000n]); // capped at the whole pool
        expect(lpUnderlying(0n, 1000n, 500n, 2000n)).toEqual([0n, 0n]);
        expect(lpUnderlying(10n, 0n, 500n, 2000n)).toEqual([0n, 0n]); // an empty pool has no shares to redeem
    });

    test('estimateLpMint: the first deposit gets sqrt(a*b) less the locked minimum; later ones the smaller proportional share', () => {
        expect(LP_MINIMUM_LIQUIDITY).toBe(1000n);
        expect(estimateLpMint(1000n * E18, 4000n * E18, 0n, 0n, 0n)).toBe(2000n * E18 - 1000n);
        // pool of 1000 / 4000 with 2000 LP outstanding: 10 + 40 mints 20 LP
        expect(estimateLpMint(10n * E18, 40n * E18, 1000n * E18, 4000n * E18, 2000n * E18)).toBe(20n * E18);
        // off-ratio: the smaller side limits (10 of A would allow 20 LP, 30 of B only 15)
        expect(estimateLpMint(10n * E18, 30n * E18, 1000n * E18, 4000n * E18, 2000n * E18)).toBe(15n * E18);
    });

    test('estimateLpMint: a deposit too small to mint anything reads as zero, so the form can refuse it', () => {
        expect(estimateLpMint(0n, 5n, 0n, 0n, 0n)).toBe(0n);
        expect(estimateLpMint(1000n, 1000n, 0n, 0n, 0n)).toBe(0n); // sqrt is exactly the locked minimum
        expect(estimateLpMint(1001n, 1001n, 0n, 0n, 0n)).toBe(1n);
        expect(estimateLpMint(1n, 1n, 1000n * E18, 4000n * E18, 2000n * E18)).toBe(0n);
        expect(estimateLpMint(5n, 5n, 0n, 1n, 10n)).toBe(0n); // supply but an empty reserve: nothing sensible to mint
    });

    test('minimum amounts apply the slippage tolerance to each side and clamp a bad tolerance', () => {
        expect(removeLiquidityMins(1000n, 2000n, 1)).toEqual([990n, 1980n]);
        expect(removeLiquidityMins(1000n, 2000n, 0)).toEqual([1000n, 2000n]);
        expect(removeLiquidityMins(1000n, 2000n, NaN)).toEqual([990n, 1980n]); // NaN falls back to 1%
        expect(removeLiquidityMins(1000n, 2000n, 500)).toEqual([500n, 1000n]); // clamped to 50%
    });
});
