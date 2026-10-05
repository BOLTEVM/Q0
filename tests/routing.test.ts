import { describe, test, expect, afterEach } from 'bun:test';
import {
    parseUnits,
    formatUnits,
    quoteRoute,
    getSwapRoute,
    findPool,
    tokenAddress,
    CANDIDATE_POOLS,
    encodeAddLiquidity,
    encodeApprove,
    quoteLiquidityB,
    applySlippage,
    clampSlippagePct,
    simulateSwap,
    getPairAddress,
    getQrbBoostStatus,
    describeQrbBoost,
    formatBoostDuration,
    formatBoostPct,
    meetsQrbBoostThreshold,
    QRB_BOOST_BPS,
    QRB_BOOST_MATURITY_SECONDS,
    QRB_BOOST_THRESHOLD_WEI,
    DEXES,
    POOL_REGISTRY,
    SWAP_ROUTES,
    type LPReserves
} from '../packages/quai-service/src/index';

const E18 = 10n ** 18n;

function reserves(pairSymbols: [string, string], r0: bigint, r1: bigint): LPReserves {
    return {
        token0: tokenAddress(pairSymbols[0]),
        token1: tokenAddress(pairSymbols[1]),
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        blockTime: 0
    };
}

describe('units', () => {
    test('parseUnits is exact where Number(x) * 1e18 is not', () => {
        expect(parseUnits('0.1')).toBe(100000000000000000n);
        expect(parseUnits('1.234567890123456789')).toBe(1234567890123456789n);
        expect(parseUnits('.5')).toBe(500000000000000000n);
        expect(parseUnits('7')).toBe(7n * E18);
        // Number(9007199.254740993) * 1e18 cannot represent this; BigInt string parsing can.
        expect(parseUnits('9007199.254740993')).toBe(9007199254740993000000000n);
    });

    test('parseUnits rejects malformed or over-precise input', () => {
        expect(() => parseUnits('')).toThrow();
        expect(() => parseUnits('.')).toThrow();
        expect(() => parseUnits('1e5')).toThrow();
        expect(() => parseUnits('-1')).toThrow();
        expect(() => parseUnits('1.0000000000000000001')).toThrow();
    });

    test('formatUnits truncates, trims zeros and never rounds a balance up', () => {
        expect(formatUnits(1234567890123456789n)).toBe('1.234567');
        expect(formatUnits(1500000000000000000n)).toBe('1.5');
        expect(formatUnits(0n)).toBe('0');
        expect(formatUnits(999999999999999999n)).toBe('0.999999');
        expect(formatUnits('30000000000000')).toBe('0.00003');
        expect(formatUnits(1234567890123456789n, 18, 18)).toBe('1.234567890123456789');
    });

    test('a balance round-trips through MAX (format at full precision, parse back)', () => {
        const bal = 48365118099149530000000000n + 1n;
        expect(parseUnits(formatUnits(bal, 18, 18))).toBe(bal);
    });
});

describe('registry integrity', () => {
    test('every route hop is a registered pool on the route\'s own DEX', () => {
        for (const route of SWAP_ROUTES.filter(r => !r.optional)) {
            for (let i = 0; i < route.path.length - 1; i++) {
                const pool = findPool(route.dex, route.path[i], route.path[i + 1]);
                expect(pool, `${route.id} hop ${route.path[i]}->${route.path[i + 1]}`).toBeDefined();
            }
        }
    });

    test('Q0 routes use the Quaiswap router, LAPTOP/BDELTA routes the Quainance router', () => {
        expect(getSwapRoute('Q0_WQUAI')!.dex).toBe('QUAISWAP');
        expect(getSwapRoute('BOSS_WQUAI')!.dex).toBe('QUAISWAP');
        expect(getSwapRoute('LAPTOP_QGIRL')!.dex).toBe('QUAINANCE');
        expect(getSwapRoute('BDELTA_WQUAI')!.dex).toBe('QUAINANCE');
        expect(DEXES.QUAISWAP.router.toLowerCase()).not.toBe(DEXES.QUAINANCE.router.toLowerCase());
    });

    test('BDELTA/Q0 is only ever a single-DEX pair route, and only once its pool exists', () => {
        const bq = SWAP_ROUTES.filter(r => r.path.includes('BDELTA') && r.path.includes('Q0'));
        expect(bq.length).toBeGreaterThan(0);
        for (const r of bq) {
            expect(r.path.length).toBe(2);
            expect(r.optional).toBe(true);
            expect(CANDIDATE_POOLS.some(c => c.dex === r.dex && c.tokens.includes('BDELTA') && c.tokens.includes('Q0'))).toBe(true);
        }
    });

    test('every optional route has a matching candidate pool so discovery can enable it', () => {
        for (const r of SWAP_ROUTES.filter(x => x.optional)) {
            const [a, b] = r.path;
            expect(CANDIDATE_POOLS.some(c => c.dex === r.dex && c.tokens.includes(a) && c.tokens.includes(b))).toBe(true);
        }
    });

    test('pool addresses are unique', () => {
        const set = new Set(POOL_REGISTRY.map(p => p.pair.toLowerCase()));
        expect(set.size).toBe(POOL_REGISTRY.length);
    });
});

describe('quoteRoute', () => {
    // 1000 Q0 : 10 WQUAI  (token0 = Q0)
    const q0Wquai = POOL_REGISTRY.find(p => p.tokens[0] === 'Q0' && p.tokens[1] === 'WQUAI')!;
    const q0Boss = POOL_REGISTRY.find(p => p.tokens[0] === 'Q0' && p.tokens[1] === 'BOSS')!;
    const bdeltaWquai = POOL_REGISTRY.find(p => p.tokens[0] === 'BDELTA' && p.tokens[1] === 'WQUAI')!;

    const map = {
        [q0Wquai.pair.toLowerCase()]: reserves(['Q0', 'WQUAI'], 1000n * E18, 10n * E18),
        [q0Boss.pair.toLowerCase()]: reserves(['Q0', 'BOSS'], 500n * E18, 2000n * E18),
        [bdeltaWquai.pair.toLowerCase()]: reserves(['BDELTA', 'WQUAI'], 95886n * E18, 20264n * E18)
    };

    test('forward and reverse read opposite reserves (orientation comes from token0, not position)', () => {
        const route = getSwapRoute('Q0_WQUAI')!;
        const fwd = quoteRoute(route, false, 10n * E18, map, 0)!;   // Q0 -> WQUAI
        const rev = quoteRoute(route, true, 1n * E18, map, 0)!;     // WQUAI -> Q0
        // 10 Q0 in vs 1000 Q0 / 10 WQUAI: ~0.0987 WQUAI out
        expect(fwd.amountOut).toBeLessThan(E18 / 10n);
        expect(fwd.amountOut).toBeGreaterThan(9n * E18 / 100n);
        // 1 WQUAI in: ~90.66 Q0 out
        expect(rev.amountOut).toBeGreaterThan(90n * E18);
        expect(rev.amountOut).toBeLessThan(91n * E18);
    });

    test('matches the Uniswap V2 formula exactly for a single hop', () => {
        const route = getSwapRoute('Q0_WQUAI')!;
        const inAmt = 10n * E18;
        const expected = (inAmt * 997n * (10n * E18)) / ((1000n * E18) * 1000n + inAmt * 997n);
        expect(quoteRoute(route, false, inAmt, map, 0)!.amountOut).toBe(expected);
    });

    test('slippage lowers minimumReceived by exactly the tolerance', () => {
        const route = getSwapRoute('Q0_WQUAI')!;
        const q = quoteRoute(route, false, 10n * E18, map, 1)!;
        expect(q.minimumReceived).toBe((q.amountOut * 9900n) / 10000n);
    });

    test('BDELTA/WQUAI quotes from its own pool, not the Q0/WQUAI reserves', () => {
        const route = getSwapRoute('BDELTA_WQUAI')!;
        const q = quoteRoute(route, false, 100n * E18, map, 0)!;
        // ~0.2113 WQUAI per BDELTA at these reserves; the Q0 pool would give ~0.01
        expect(Number(q.amountOut) / 1e18).toBeGreaterThan(20);
        expect(Number(q.amountOut) / 1e18).toBeLessThan(21.2);
    });

    test('two-hop BOSS -> Q0 -> WQUAI compounds both fees', () => {
        const route = getSwapRoute('BOSS_WQUAI')!;
        const q = quoteRoute(route, false, 100n * E18, map, 0)!;
        const hop1 = (100n * E18 * 997n * (500n * E18)) / ((2000n * E18) * 1000n + 100n * E18 * 997n);
        const hop2 = (hop1 * 997n * (10n * E18)) / ((1000n * E18) * 1000n + hop1 * 997n);
        expect(q.amountOut).toBe(hop2);
    });

    test('returns null for missing reserves, zero input, or a pair whose tokens do not match', () => {
        const route = getSwapRoute('Q0_WQUAI')!;
        expect(quoteRoute(route, false, 1n * E18, {}, 0)).toBeNull();
        expect(quoteRoute(route, false, 0n, map, 0)).toBeNull();
        const swapped = { [q0Wquai.pair.toLowerCase()]: reserves(['LAPTOP', 'QGIRL'], E18, E18) };
        expect(quoteRoute(route, false, 1n * E18, swapped, 0)).toBeNull();
    });
});

describe('liquidity encoding', () => {
    const owner = '0x005c0faa00000000000000000000000000000001';

    test('addLiquidity calldata has the Uniswap V2 selector and 8 padded words in order', () => {
        const data = encodeAddLiquidity({
            tokenA: tokenAddress('BDELTA'),
            tokenB: tokenAddress('Q0'),
            amountADesired: 5n * E18,
            amountBDesired: 7n * E18,
            amountAMin: 4n * E18,
            amountBMin: 6n * E18,
            to: owner,
            deadline: 1234n
        });
        expect(data.slice(0, 10)).toBe('0xe8e33700');
        const words = data.slice(10).match(/.{64}/g)!;
        expect(words.length).toBe(8);
        expect(words[0].slice(24)).toBe(tokenAddress('BDELTA').slice(2).toLowerCase());
        expect(words[1].slice(24)).toBe(tokenAddress('Q0').slice(2).toLowerCase());
        expect(BigInt('0x' + words[2])).toBe(5n * E18);
        expect(BigInt('0x' + words[3])).toBe(7n * E18);
        expect(BigInt('0x' + words[4])).toBe(4n * E18);
        expect(BigInt('0x' + words[5])).toBe(6n * E18);
        expect(words[6].slice(24)).toBe(owner.slice(2));
        expect(BigInt('0x' + words[7])).toBe(1234n);
    });

    test('approve calldata', () => {
        const data = encodeApprove(DEXES.QUAISWAP.router, 3n);
        expect(data.slice(0, 10)).toBe('0x095ea7b3');
        expect(data.length).toBe(10 + 128);
    });

    test('quoteLiquidityB keeps the pool ratio; applySlippage floors', () => {
        expect(quoteLiquidityB(10n * E18, 1000n * E18, 250n * E18)).toBe(25n * E18 / 10n);
        expect(quoteLiquidityB(1n, 0n, 5n)).toBe(0n);
        expect(applySlippage(10000n, 1)).toBe(9900n);
        expect(applySlippage(10000n, 0)).toBe(10000n);
    });
});

describe('slippage input can never crash a render or produce an unsendable swap', () => {
    const hostile = [NaN, Infinity, -Infinity, -5, -0.01, 100, 1e9, 51];

    test('clampSlippagePct pulls everything into [0, 50] and passes sane values through', () => {
        expect(clampSlippagePct(NaN)).toBe(1); // default
        expect(clampSlippagePct(NaN, 0.5)).toBe(0.5);
        expect(clampSlippagePct(-5)).toBe(0);
        expect(clampSlippagePct(-Infinity)).toBe(0);
        expect(clampSlippagePct(Infinity)).toBe(50);
        expect(clampSlippagePct(1e9)).toBe(50);
        expect(clampSlippagePct(0)).toBe(0);
        expect(clampSlippagePct(0.5)).toBe(0.5);
        expect(clampSlippagePct(50)).toBe(50);
    });

    test('simulateSwap never throws and never demands more than it quoted', () => {
        for (const pct of hostile) {
            const sim = simulateSwap((10n * E18).toString(), (1000n * E18).toString(), (10n * E18).toString(), pct);
            const out = BigInt(sim.amountOut);
            const min = BigInt(sim.minimumReceived);
            expect(min <= out).toBe(true); // a minimum above the quote would revert on-chain and burn the gas limit
            expect(min >= out / 2n).toBe(true); // and a "protection" of 0 is not offered either
        }
    });

    test('quoteRoute and applySlippage behave the same way', () => {
        const pool = POOL_REGISTRY.find(p => p.tokens[0] === 'Q0' && p.tokens[1] === 'WQUAI')!;
        const map = { [pool.pair.toLowerCase()]: reserves(['Q0', 'WQUAI'], 1000n * E18, 10n * E18) };
        for (const pct of hostile) {
            const q = quoteRoute(getSwapRoute('Q0_WQUAI')!, false, 10n * E18, map, pct)!;
            expect(q.minimumReceived <= q.amountOut).toBe(true);
            expect(q.minimumReceived >= q.amountOut / 2n).toBe(true);
            const m = applySlippage(10_000n, pct);
            expect(m <= 10_000n && m >= 5_000n).toBe(true);
        }
    });
});

describe('RPC-backed helpers', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** Stub the JSON-RPC endpoint; `answer` receives the request and returns the `result`. */
    function stubRpc(answer: (method: string, params: any[]) => string): { signals: unknown[] } {
        const seen = { signals: [] as unknown[] };
        globalThis.fetch = (async (_url: any, init: any) => {
            seen.signals.push(init?.signal);
            const body = JSON.parse(init.body);
            return { ok: true, statusText: 'OK', json: async () => ({ result: answer(body.method, body.params) }) };
        }) as any;
        return seen;
    }
    const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
    const ZERO_WORD = '0x' + '0'.repeat(64);

    test('every RPC request carries a timeout signal, so a hung node cannot freeze the app', async () => {
        const seen = stubRpc(() => ZERO_WORD);
        await getPairAddress('QUAISWAP', 'Q0', 'WQUAI');
        expect(seen.signals.length).toBe(1);
        expect(seen.signals[0]).toBeDefined();
    });

    test('getPairAddress: a real pair, no pair, and garbage replies', async () => {
        const pair = '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8';
        stubRpc(() => '0x' + '0'.repeat(24) + pair.slice(2).toLowerCase());
        expect((await getPairAddress('QUAISWAP', 'Q0', 'WQUAI'))!.toLowerCase()).toBe(pair.toLowerCase());

        stubRpc(() => ZERO_WORD);
        expect(await getPairAddress('QUAISWAP', 'Q0', 'WQUAI')).toBeNull();

        // A factory address with no code answers "0x": that is NOT a pair, and must not look like one.
        stubRpc(() => '0x');
        await expect(getPairAddress('QUAISWAP', 'Q0', 'WQUAI')).rejects.toThrow('Unexpected reply');
        stubRpc(() => '0x1234');
        await expect(getPairAddress('QUAISWAP', 'Q0', 'WQUAI')).rejects.toThrow('Unexpected reply');
    });

    test('getQrbBoostStatus reads balance, boost and eligibility from the contract', async () => {
        stubRpc((_m, params) => {
            const data: string = params[0].data;
            if (data.startsWith('0x70a08231')) return word(QRB_BOOST_THRESHOLD_WEI * 3n); // balanceOf
            if (data.startsWith('0x3487b7fd')) return word(BigInt(QRB_BOOST_BPS)); // boostBpsOf
            if (data.startsWith('0xed0d5560')) return word(1_700_000_000n); // boostEligibleAt
            throw new Error('unexpected call ' + data.slice(0, 10));
        });
        const st = await getQrbBoostStatus('0x0000000000000000000000000000000000000abc', '0x00325150094E51107a931980Fdfc3bB1a4C48379');
        expect(st.balance).toBe(QRB_BOOST_THRESHOLD_WEI * 3n);
        expect(st.boostBps).toBe(BigInt(QRB_BOOST_BPS));
        expect(st.eligibleAt).toBe(1_700_000_000);
    });

    test('an empty reply (no contract) reads as no boost, not an exception', async () => {
        stubRpc(() => '0x');
        const st = await getQrbBoostStatus('0x0000000000000000000000000000000000000abc', '0x00325150094E51107a931980Fdfc3bB1a4C48379');
        expect(st).toEqual({ balance: 0n, boostBps: 0n, eligibleAt: 0 });
    });

    test('describeQrbBoost tells active, maturing and below-threshold apart', () => {
        const now = 1_000_000;
        const T = QRB_BOOST_THRESHOLD_WEI;
        expect(describeQrbBoost({ balance: T, boostBps: 5000n, eligibleAt: now - 10 }, T, now)).toBe('ACTIVE');
        // Holds the threshold but has not held it long enough: the balance alone is NOT the boost.
        expect(describeQrbBoost({ balance: T, boostBps: 0n, eligibleAt: now + 3600 }, T, now)).toBe('MATURING');
        expect(describeQrbBoost({ balance: T - 1n, boostBps: 0n, eligibleAt: 0 }, T, now)).toBe('BELOW_THRESHOLD');
        expect(describeQrbBoost({ balance: 0n, boostBps: 0n, eligibleAt: 0 }, T, now)).toBe('BELOW_THRESHOLD');
    });
});

describe('boost constants and formatters', () => {
    test('the pinned figures', () => {
        expect(QRB_BOOST_BPS).toBe(5000);
        expect(QRB_BOOST_THRESHOLD_WEI).toBe(10n ** 14n);
        expect(QRB_BOOST_MATURITY_SECONDS).toBe(86_400);
    });

    test('formatBoostPct and formatBoostDuration', () => {
        expect(formatBoostPct()).toBe('50%');
        expect(formatBoostPct(1250)).toBe('12.5%');
        expect(formatBoostPct(5)).toBe('0.05%');
        expect(formatBoostDuration()).toBe('1 day');
        expect(formatBoostDuration(172_800)).toBe('2 days');
        expect(formatBoostDuration(3600)).toBe('1 hour');
        expect(formatBoostDuration(90)).toBe('90 seconds');
        expect(formatBoostDuration(0)).toBe('0 seconds');
    });

    test('meetsQrbBoostThreshold is only the balance half of the rule', () => {
        expect(meetsQrbBoostThreshold(QRB_BOOST_THRESHOLD_WEI - 1n)).toBe(false);
        expect(meetsQrbBoostThreshold(QRB_BOOST_THRESHOLD_WEI)).toBe(true);
    });
});
