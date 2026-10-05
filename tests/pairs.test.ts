import { describe, test, expect } from 'bun:test';
import {
    analyzePairs,
    derivePrices,
    tvlQuai,
    priceImpactTable,
    sortPairs,
    compactNumber,
    createBatch,
    loadPairSnapshots,
    scanPairCreations,
    applyCreations,
    TOKEN_REGISTRY,
    DEXES,
    TINY_TVL_QUAI,
    PAIR_CREATED_TOPIC,
    type PairSnapshot,
    type PairToken,
    type BatchFn
} from '../packages/quai-service/src/index';

const E18 = 10n ** 18n;
const WQUAI = TOKEN_REGISTRY.WQUAI.address;
const tok = (address: string, symbol: string, decimals = 18, registered = true): PairToken => ({ address, symbol, name: symbol, decimals, registered });
const T_WQUAI = tok(WQUAI, 'WQUAI');
const T_Q0 = tok(TOKEN_REGISTRY.Q0.address, 'Q0');
const T_BOSS = tok(TOKEN_REGISTRY.BOSS.address, 'BOSS');
const FAKE_ADDR = '0x00' + 'aa'.repeat(19);

let n = 0;
function pair(dex: PairSnapshot['dex'], a: PairToken, b: PairToken, ra: bigint, rb: bigint, extra: Partial<PairSnapshot> = {}): PairSnapshot {
    n++;
    return {
        dex,
        pair: '0x00' + n.toString(16).padStart(38, '0'),
        index: extra.index ?? n,
        token0: a,
        token1: b,
        reserve0: ra,
        reserve1: rb,
        totalSupply: 1000n * E18,
        burned: 100n * E18, // 10%: well burned unless a test says otherwise
        ...extra
    };
}

describe('pricing and value locked', () => {
    test('WQUAI is worth 1 QUAI and prices tokens through the pool', () => {
        const prices = derivePrices([pair('QUAISWAP', T_Q0, T_WQUAI, 1000n * E18, 10n * E18)]);
        expect(prices.get(WQUAI.toLowerCase())?.price).toBe(1);
        expect(prices.get(T_Q0.address.toLowerCase())?.price).toBeCloseTo(0.01, 12);
    });

    test('a token two hops from WQUAI is priced through both pools', () => {
        const pairs = [pair('QUAISWAP', T_Q0, T_WQUAI, 1000n * E18, 10n * E18), pair('QUAISWAP', T_BOSS, T_Q0, 500n * E18, 100n * E18)];
        const prices = derivePrices(pairs);
        // 100 Q0 (worth 0.01 each = 1 QUAI) against 500 BOSS: BOSS = 0.002 QUAI
        expect(prices.get(T_BOSS.address.toLowerCase())?.price).toBeCloseTo(0.002, 12);
    });

    test('TVL is both sides when both are priced, and twice the priced side otherwise', () => {
        const a = pair('QUAISWAP', T_Q0, T_WQUAI, 1000n * E18, 10n * E18);
        const prices = derivePrices([a]);
        expect(tvlQuai(a, prices)).toBeCloseTo(20, 9);
        const unknown = tok(FAKE_ADDR, 'XYZ', 18, false);
        const b = pair('QUAISWAP', unknown, T_WQUAI, 500n * E18, 5n * E18);
        expect(tvlQuai(b, derivePrices([b]))).toBeCloseTo(10, 9);
        const c = pair('QUAISWAP', tok('0x00' + 'b'.repeat(38), 'A', 18, false), tok('0x00' + 'c'.repeat(38), 'B', 18, false), E18, E18);
        expect(tvlQuai(c, derivePrices([c]))).toBeNull();
    });

    test('honours each token\'s decimals', () => {
        const usdt6 = tok('0x00' + 'd'.repeat(38), 'USDT6', 6, false);
        const p = pair('QUAISWAP', usdt6, T_WQUAI, 1_000_000n * 10n ** 6n, 500n * E18);
        expect(derivePrices([p]).get(usdt6.address.toLowerCase())?.price).toBeCloseTo(0.0005, 12);
    });

    test('a dust pool cannot overrule a deep one for the same token', () => {
        const deep = pair('QUAISWAP', T_Q0, T_WQUAI, 100_000n * E18, 1_000n * E18); // Q0 = 0.01
        const dust = pair('QUAINANCE', T_Q0, T_WQUAI, 10n * E18, 10n * E18); // claims Q0 = 1
        for (const order of [[deep, dust], [dust, deep]]) {
            expect(derivePrices(order).get(T_Q0.address.toLowerCase())?.price).toBeCloseTo(0.01, 12);
        }
    });

    test('empty pools are ignored', () => {
        expect(derivePrices([pair('QUAISWAP', T_Q0, T_WQUAI, 0n, 10n * E18)]).has(T_Q0.address.toLowerCase())).toBe(false);
    });
});

describe('risk flags', () => {
    const codes = (p: PairSnapshot[], i = 0, opts = {}) => analyzePairs(p, opts)[i].flags.map(f => f.code);

    test('a deep, registered, partly-burned pool is clean', () => {
        const a = analyzePairs([pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 0 })], { newestPerDex: 0 })[0];
        expect(a.flags).toEqual([]);
        expect(a.tvlQuai).toBeCloseTo(20_000, 6);
    });

    test('tiny, thin and empty pools are graded', () => {
        expect(codes([pair('QUAISWAP', T_Q0, T_WQUAI, 100n * E18, 5n * E18, { index: 0 })], 0, { newestPerDex: 0 })).toContain('TINY_LIQUIDITY');
        expect(TINY_TVL_QUAI).toBeGreaterThan(0);
        expect(codes([pair('QUAISWAP', T_Q0, T_WQUAI, 100_000n * E18, 100n * E18, { index: 0 })], 0, { newestPerDex: 0 })).toContain('LOW_LIQUIDITY');
        expect(codes([pair('QUAISWAP', T_Q0, T_WQUAI, 0n, 0n, { index: 0 })], 0, { newestPerDex: 0 })).toContain('NO_LIQUIDITY');
    });

    test('an unlisted token that copies a registered symbol is called out as an imitation', () => {
        const fake = tok(FAKE_ADDR, 'WQUAI', 18, false);
        const a = analyzePairs([pair('QUAISWAP', fake, T_Q0, 1000n * E18, 1000n * E18, { index: 0 })], { newestPerDex: 0 })[0];
        const f = a.flags.find(x => x.code === 'SYMBOL_COLLISION');
        expect(f?.severity).toBe('danger');
        expect(f?.detail).toContain(FAKE_ADDR);
        // The genuine registered token is never accused.
        expect(analyzePairs([pair('QUAISWAP', T_WQUAI, T_Q0, 1000n * E18, 1000n * E18, { index: 0 })], { newestPerDex: 0 })[0].flags.map(x => x.code)).not.toContain('SYMBOL_COLLISION');
    });

    test('a stablecoin symbol is a verify-the-address warning, not an accusation (several real tokens share it)', () => {
        const other = tok(FAKE_ADDR, 'USDT', 6, false);
        const flags = analyzePairs([pair('QUAISWAP', other, T_WQUAI, 1_000_000n * 10n ** 6n, 1000n * E18, { index: 0 })], { newestPerDex: 0 })[0].flags;
        const f = flags.find(x => x.code === 'SYMBOL_COLLISION');
        expect(f?.severity).toBe('warn');
        expect(f?.detail).toContain(FAKE_ADDR);
        expect(flags.map(x => x.code)).toContain('ODD_DECIMALS');
    });

    test('LP burn is reported honestly', () => {
        const none = analyzePairs([pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 0, burned: 0n })], { newestPerDex: 0 })[0];
        expect(none.burnedPct).toBe(0);
        expect(none.flags.find(f => f.code === 'NO_LP_BURNED')?.severity).toBe('warn');
        const half = analyzePairs([pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 0, burned: 500n * E18 })], { newestPerDex: 0 })[0];
        expect(half.burnedPct).toBe(50);
        expect(half.flags.map(f => f.code)).not.toContain('NO_LP_BURNED');
    });

    test('newest-per-factory and creation-time both mark a pool new, and creation time wins', () => {
        const old = pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 1 });
        const mid = pair('QUAISWAP', T_BOSS, T_Q0, 1_000_000n * E18, 10_000n * E18, { index: 2 });
        const top = pair('QUAISWAP', T_BOSS, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 3 });
        const ranked = analyzePairs([old, mid, top], { newestPerDex: 1 });
        expect(ranked.map(p => p.isNew)).toEqual([false, false, true]);
        const now = 1_800_000_000;
        const dated = analyzePairs([{ ...old, createdAt: now - 86400 }, { ...top, createdAt: now - 30 * 86400 }], { nowSec: now, newestPerDex: 5 });
        expect(dated.map(p => p.isNew)).toEqual([true, false]);
    });

    test('the same pair priced differently on two DEXes is flagged on both', () => {
        const a = pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 0 }); // 0.0100
        const b = pair('QUAINANCE', T_WQUAI, T_Q0, 10_000n * E18, 900_000n * E18, { index: 0 }); // 0.0111 (reversed orientation)
        const out = analyzePairs([a, b], { newestPerDex: 0 });
        for (const p of out) expect(p.flags.map(f => f.code)).toContain('PRICE_DIVERGENCE');
        const agree = analyzePairs([a, pair('QUAINANCE', T_WQUAI, T_Q0, 10_000n * E18, 1_000_000n * E18, { index: 0 })], { newestPerDex: 0 });
        for (const p of agree) expect(p.flags.map(f => f.code)).not.toContain('PRICE_DIVERGENCE');
    });

    test('USD value appears only when a QUAI price is supplied', () => {
        const p = pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 0 });
        expect(analyzePairs([p])[0].tvlUsd).toBeNull();
        expect(analyzePairs([p], { quaiUsd: 0.5 })[0].tvlUsd).toBeCloseTo(10_000, 6);
    });
});

describe('sorting, impact and formatting', () => {
    test('sorts by value locked with unpriced pools last, and by newest', () => {
        const big = pair('QUAISWAP', T_Q0, T_WQUAI, 1_000_000n * E18, 10_000n * E18, { index: 1 });
        const small = pair('QUAISWAP', T_BOSS, T_Q0, 10n * E18, 10n * E18, { index: 2 });
        const unpriced = pair('QUAISWAP', tok('0x00' + 'e'.repeat(38), 'A', 18, false), tok('0x00' + 'f'.repeat(38), 'B', 18, false), E18, E18, { index: 3 });
        const list = analyzePairs([small, unpriced, big], { newestPerDex: 0 });
        expect(sortPairs(list, 'tvl').map(p => p.index)).toEqual([1, 2, 3]);
        expect(sortPairs(list, 'newest').map(p => p.index)).toEqual([3, 2, 1]);
    });

    test('price impact grows with trade size and includes the fee', () => {
        const rows = priceImpactTable(1000, 1000);
        expect(rows[0].impactPct).toBeGreaterThan(0.3);
        expect(rows[0].impactPct).toBeLessThan(0.5);
        for (let i = 1; i < rows.length; i++) expect(rows[i].impactPct).toBeGreaterThan(rows[i - 1].impactPct);
        expect(priceImpactTable(0, 10)).toEqual([]);
    });

    test('compact numbers', () => {
        expect(compactNumber(1234)).toBe('1.23K');
        expect(compactNumber(2_500_000)).toBe('2.50M');
        expect(compactNumber(0.00123)).toBe('0.00123');
        expect(compactNumber(null)).toBe('—');
        expect(compactNumber(NaN)).toBe('—');
    });
});

// A node that answers only the calls a pair explorer makes, from a table of pools.
function fakeNode(pools: { pair: string; t0: string; t1: string; r0: bigint; r1: bigint; supply: bigint; burned: bigint }[], symbols: Record<string, [string, number]>): { batch: BatchFn; calls: number } {
    const w = (n: bigint) => n.toString(16).padStart(64, '0');
    const addr = (a: string) => '0x' + a.replace('0x', '').toLowerCase().padStart(64, '0');
    const str = (s: string) => '0x' + w(32n) + w(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
    const node = { calls: 0, batch: null as unknown as BatchFn };
    node.batch = async calls => {
        node.calls += calls.length;
        return calls.map(c => {
            if (c.method === 'quai_blockNumber') return { ok: true as const, value: '0x64' };
            const { to, data } = (c.params as any[])[0];
            const t = to.toLowerCase();
            if (t === DEXES.QUAISWAP.factory!.toLowerCase()) {
                if (data === '0x574f2ba3') return { ok: true as const, value: '0x' + w(BigInt(pools.length)) };
                if (data.startsWith('0x1e3dd18b')) return { ok: true as const, value: addr(pools[Number(BigInt('0x' + data.slice(10)))].pair) };
            }
            if (t === DEXES.QUAINANCE.factory!.toLowerCase() && data === '0x574f2ba3') return { ok: false as const, error: 'node unavailable' };
            const p = pools.find(x => x.pair.toLowerCase() === t);
            if (p) {
                if (data === '0x0dfe1681') return { ok: true as const, value: addr(p.t0) };
                if (data === '0xd21220a7') return { ok: true as const, value: addr(p.t1) };
                if (data === '0x0902f1ac') return { ok: true as const, value: '0x' + w(p.r0) + w(p.r1) + w(5n) };
                if (data === '0x18160ddd') return { ok: true as const, value: '0x' + w(p.supply) };
                if (data.startsWith('0x70a08231')) return { ok: true as const, value: '0x' + w(data.toLowerCase().includes('dead') ? p.burned : 0n) };
            }
            const s = symbols[t];
            if (s) {
                if (data === '0x95d89b41') return { ok: true as const, value: str(s[0]) };
                if (data === '0x06fdde03') return { ok: true as const, value: str(s[0] + ' token') };
                if (data === '0x313ce567') return { ok: true as const, value: '0x' + w(BigInt(s[1])) };
            }
            return { ok: false as const, error: 'execution reverted' };
        });
    };
    return node;
}

describe('loading pairs from the chain', () => {
    const P1 = '0x00' + '1'.repeat(38);
    const P2 = '0x00' + '2'.repeat(38);
    const UNK = '0x00' + 'ab'.repeat(19);

    test('reads pools, tokens and reserves, skips an unreadable DEX, and reports it', async () => {
        const node = fakeNode(
            [
                { pair: P1, t0: T_Q0.address, t1: WQUAI, r0: 1000n * E18, r1: 10n * E18, supply: 100n * E18, burned: 1n * E18 },
                { pair: P2, t0: UNK, t1: WQUAI, r0: 5n * 10n ** 6n, r1: 2n * E18, supply: 50n * E18, burned: 0n }
            ],
            { [UNK.toLowerCase()]: ['SCAM', 6] }
        );
        const r = await loadPairSnapshots(['QUAISWAP', 'QUAINANCE', 'CIRCLESWAP'], { batch: node.batch });
        expect(r.pairs).toHaveLength(2);
        expect(r.totals.QUAISWAP).toBe(2);
        expect(r.errors.join(' ')).toContain('Quainance');
        expect(r.block).toBe(100);
        const [a, b] = r.pairs;
        expect(a.token0.symbol).toBe('Q0');
        expect(a.token0.registered).toBe(true);
        expect(a.burned).toBe(1n * E18);
        expect(b.token0).toMatchObject({ symbol: 'SCAM', decimals: 6, registered: false });
        const analysed = analyzePairs(r.pairs, { newestPerDex: 0 });
        expect(analysed[1].flags.map(f => f.code)).toContain('UNKNOWN_TOKEN');
        expect(analysed[1].flags.map(f => f.code)).toContain('NO_LP_BURNED');
    });

    test('keeps only the newest `maxPerDex` pools when a factory has more', async () => {
        const pools = Array.from({ length: 6 }, (_, i) => ({
            pair: '0x00' + (i + 1).toString().padStart(38, '0'),
            t0: T_Q0.address,
            t1: WQUAI,
            r0: E18,
            r1: E18,
            supply: E18,
            burned: 0n
        }));
        const r = await loadPairSnapshots(['QUAISWAP'], { batch: fakeNode(pools, {}).batch, maxPerDex: 2 });
        expect(r.totals.QUAISWAP).toBe(6);
        expect(r.pairs.map(p => p.index)).toEqual([4, 5]);
    });

    test('a pair that is not a pair is reported, not crashed on', async () => {
        const node = fakeNode([{ pair: P1, t0: T_Q0.address, t1: WQUAI, r0: E18, r1: E18, supply: E18, burned: 0n }], {});
        const inner = node.batch;
        const broken: BatchFn = async calls => (await inner(calls)).map((r, i) => ((calls[i].params as any[])[0]?.data === '0x0dfe1681' ? { ok: false as const, error: 'revert' } : r));
        const r = await loadPairSnapshots(['QUAISWAP'], { batch: broken });
        expect(r.pairs).toHaveLength(0);
        expect(r.errors.join(' ')).toContain('not a readable pair');
    });
});

describe('creation-time scan', () => {
    test('windows are at most 10,000 blocks and cover the lookback', async () => {
        const seen: { from: number; to: number }[] = [];
        const batch: BatchFn = async calls =>
            calls.map(c => {
                if (c.method === 'quai_getLogs') {
                    const f = (c.params as any[])[0];
                    seen.push({ from: Number(BigInt(f.fromBlock)), to: Number(BigInt(f.toBlock)) });
                    expect(f.topics[0]).toBe(PAIR_CREATED_TOPIC);
                    return { ok: true as const, value: [] };
                }
                return { ok: true as const, value: null };
            });
        await scanPairCreations('0x00aa', 100_000, 35_000, batch);
        expect(seen).toHaveLength(4);
        for (const w of seen) expect(w.to - w.from).toBeLessThan(10_000);
        expect(Math.min(...seen.map(w => w.from))).toBeLessThanOrEqual(65_000);
    });

    test('reads the pair from the log data and the time from the block header', async () => {
        const P = '0x00' + '3'.repeat(38);
        const batch: BatchFn = async calls =>
            calls.map(c => {
                if (c.method === 'quai_getLogs') {
                    return { ok: true as const, value: [{ blockNumber: '0x2710', data: '0x' + '0'.repeat(24) + P.slice(2) + '0'.repeat(63) + '5' }] };
                }
                return { ok: true as const, value: { woHeader: { timestamp: '0x6abd51b7' } } };
            });
        const found = await scanPairCreations('0x00aa', 20_000, 20_000, batch);
        expect(found).toEqual([{ pair: P, block: 10_000, timestamp: 0x6abd51b7 }]);
        const snap = pair('QUAISWAP', T_Q0, T_WQUAI, E18, E18, { pair: P });
        expect(applyCreations([snap], found)[0]).toMatchObject({ createdBlock: 10_000, createdAt: 0x6abd51b7 });
    });

    test('a failed window loses only that window', async () => {
        let k = 0;
        const batch: BatchFn = async calls =>
            calls.map(c => (c.method === 'quai_getLogs' ? (k++ === 0 ? { ok: false as const, error: 'range' } : { ok: true as const, value: [] }) : { ok: true as const, value: null }));
        expect(await scanPairCreations('0x00aa', 30_000, 30_000, batch)).toEqual([]);
    });
});

describe('batch transport', () => {
    test('chunks requests, restores order, and turns a dead node into per-call errors', async () => {
        const sizes: number[] = [];
        const fetcher = (async (_u: string, init: any) => {
            const body = JSON.parse(init.body);
            sizes.push(body.length);
            return { ok: true, json: async () => [...body].reverse().map((b: any) => ({ id: b.id, result: b.params[0] })) };
        }) as any;
        const out = await createBatch('http://x', fetcher)(Array.from({ length: 95 }, (_, i) => ({ method: 'm', params: [i] })));
        expect(sizes).toEqual([40, 40, 15]);
        expect(out.map(o => (o.ok ? o.value : -1))).toEqual(Array.from({ length: 95 }, (_, i) => i));

        const dead = (async () => {
            throw new Error('offline');
        }) as any;
        const res = await createBatch('http://x', dead)([{ method: 'm', params: [] }]);
        expect(res[0]).toEqual({ ok: false, error: 'offline' });
    });
});
