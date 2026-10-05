// Pair explorer data: every pool on every DEX the app knows, with reserves, an estimated value locked, how much of
// the liquidity is burned, how new it is, and the risk signals worth a second look before anyone trades or deposits.
//
// Two halves, deliberately apart:
//   - loaders (`loadPairSnapshots`, `scanPairCreations`, `fetchQuaiUsd`) read the chain over batched JSON-RPC;
//   - analysis (`analyzePairs`, `derivePrices`, `priceImpactTable`, ...) is pure, so it is tested on fixtures.
//
// Figures here are for looking, not for trading: prices and values are floating-point estimates derived from pool
// reserves (Cyprus-1 has no price oracle), and they say nothing about a token's contract. A swap or deposit must
// still be sized with the exact BigInt maths in units.ts, liquidity.ts and circleswap.ts.

import { DEFAULT_RPC, SELECTORS, decodeBigInt, decodeString } from './index';
import { DEXES, isDexLive, type DexId } from './registries/pools';
import { TOKEN_REGISTRY, getTokenByAddress } from './registries/tokens';
import { ZERO_ADDRESS } from './liquidity';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetcher = (input, init) => fetch(input, init);

export const DEX_IDS: DexId[] = ['CIRCLESWAP', 'QUAISWAP', 'QUAINANCE'];

/** Below these (in QUAI of value locked) a pool is too thin to trade more than a token amount through. */
export const TINY_TVL_QUAI = 25;
export const LOW_TVL_QUAI = 1000;
/** A pool counts as "new" if it is among its factory's newest N, or was created within this many days. */
export const NEWEST_PER_DEX = 10;
export const NEW_WITHIN_DAYS = 7;
/** Two pools for the same pair that quote prices further apart than this are flagged (both need real liquidity). */
export const DIVERGENCE_PCT = 3;
export const DIVERGENCE_MIN_TVL_QUAI = 50;

export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
/** keccak256("PairCreated(address,address,address,uint256)"), the Uniswap-V2-style factory event. */
export const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
/** The node refuses log queries wider than this many blocks. */
export const MAX_LOG_RANGE = 10_000;

// ------------------------------------------------------------------------------------------------------ types

export interface PairToken {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    /** In the app's token registry, so it can be priced, routed and displayed with confidence. */
    registered: boolean;
}

export interface PairSnapshot {
    dex: DexId;
    pair: string;
    /** Position in the factory's allPairs list: higher is newer. */
    index: number;
    token0: PairToken;
    token1: PairToken;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply: bigint;
    /** LP tokens held by the dead and zero addresses: liquidity nobody can withdraw. */
    burned: bigint;
    createdBlock?: number;
    /** Unix seconds. Only known for pools found by `scanPairCreations`. */
    createdAt?: number;
}

export type FlagSeverity = 'info' | 'warn' | 'danger';
export type FlagCode =
    | 'NEW'
    | 'NO_LIQUIDITY'
    | 'TINY_LIQUIDITY'
    | 'LOW_LIQUIDITY'
    | 'UNPRICED'
    | 'NO_LP_BURNED'
    | 'SYMBOL_COLLISION'
    | 'UNKNOWN_TOKEN'
    | 'ODD_DECIMALS'
    | 'PRICE_DIVERGENCE';

export interface PairFlag {
    code: FlagCode;
    severity: FlagSeverity;
    label: string;
    detail: string;
}

export interface PairAnalysis extends PairSnapshot {
    /** Value of one whole token in QUAI, via the deepest route to WQUAI; null if there is none. */
    price0Quai: number | null;
    price1Quai: number | null;
    /** Estimated value locked, in QUAI and USD (null when it cannot be priced). */
    tvlQuai: number | null;
    tvlUsd: number | null;
    /** Share of LP supply that is burned, in percent. */
    burnedPct: number;
    /** token1 per token0, in whole tokens (the pool's own spot price). */
    spot: number;
    isNew: boolean;
    flags: PairFlag[];
}

// -------------------------------------------------------------------------------------------- batched JSON-RPC

export type BatchCall = { method: string; params: unknown[] };
export type BatchResult = { ok: true; value: any } | { ok: false; error: string };
export type BatchFn = (calls: BatchCall[]) => Promise<BatchResult[]>;

const CHUNK = 40;

/** JSON-RPC batch over fetch: one HTTP request per chunk, results returned in call order. */
export function createBatch(rpcUrl: string = DEFAULT_RPC, fetcher: Fetcher = defaultFetch): BatchFn {
    return async calls => {
        const out: BatchResult[] = new Array(calls.length);
        for (let start = 0; start < calls.length; start += CHUNK) {
            const slice = calls.slice(start, start + CHUNK);
            const body = slice.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
            let json: any;
            try {
                const res = await fetcher(rpcUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(30_000)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                json = await res.json();
            } catch (e: any) {
                for (let i = 0; i < slice.length; i++) out[start + i] = { ok: false, error: e?.message ?? 'request failed' };
                continue;
            }
            const byId = new Map<number, any>((Array.isArray(json) ? json : [json]).map((r: any) => [r.id, r]));
            slice.forEach((_, i) => {
                const r = byId.get(i);
                out[start + i] = !r ? { ok: false, error: 'no reply' } : r.error ? { ok: false, error: r.error.message ?? 'rpc error' } : { ok: true, value: r.result };
            });
        }
        return out;
    };
}

const pad = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const toAddress = (hex: string) => '0x' + hex.slice(-40);
const isWord = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const callOf = (to: string, data: string): BatchCall => ({ method: 'quai_call', params: [{ to, data }, 'latest'] });

// ------------------------------------------------------------------------------------------------- loading

export interface LoadResult {
    pairs: PairSnapshot[];
    /** Every pair each factory reports, including any beyond `maxPerDex` that were not loaded. */
    totals: Partial<Record<DexId, number>>;
    /** A DEX or pair that could not be read, by label. The rest is still returned. */
    errors: string[];
    block: number;
}

/** Reads token metadata once per address; an unreadable token keeps placeholder values and is flagged later. */
async function loadTokens(addresses: string[], batch: BatchFn, cache: Map<string, PairToken>): Promise<void> {
    const todo = [...new Set(addresses.map(a => a.toLowerCase()))].filter(a => !cache.has(a));
    if (!todo.length) return;
    const calls: BatchCall[] = todo.flatMap(a => [callOf(a, SELECTORS.symbol), callOf(a, SELECTORS.name), callOf(a, SELECTORS.decimals)]);
    const res = await batch(calls);
    todo.forEach((address, i) => {
        const [s, n, d] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
        const reg = getTokenByAddress(address);
        const dec = d.ok && typeof d.value === 'string' && d.value !== '0x' ? Number(BigInt(d.value)) : NaN;
        cache.set(address, {
            address,
            symbol: reg?.symbol ?? (s.ok ? decodeString(s.value).trim() : '') ?? '',
            name: reg?.name ?? (n.ok ? decodeString(n.value).trim() : ''),
            decimals: Number.isFinite(dec) && dec >= 0 && dec <= 77 ? dec : reg?.decimals ?? 18,
            registered: Boolean(reg) && reg!.deployed !== false
        });
    });
}

/** Every pool of the given DEXes, straight from their factories. Not-yet-deployed DEXes are skipped, not errors. */
export async function loadPairSnapshots(
    dexes: DexId[] = DEX_IDS,
    opts: { maxPerDex?: number; batch?: BatchFn; tokenCache?: Map<string, PairToken> } = {}
): Promise<LoadResult> {
    const batch = opts.batch ?? createBatch();
    const tokenCache = opts.tokenCache ?? new Map<string, PairToken>();
    const maxPerDex = opts.maxPerDex ?? 400;
    const errors: string[] = [];
    const totals: LoadResult['totals'] = {};

    const head = (await batch([{ method: 'quai_blockNumber', params: [] }]))[0];
    const block = head.ok ? Number(BigInt(head.value)) : 0;

    const pairs: PairSnapshot[] = [];
    for (const id of dexes) {
        if (!isDexLive(id)) continue;
        const dex = DEXES[id];
        const factory = dex.factory!;
        const count = (await batch([callOf(factory, '0x574f2ba3')]))[0];
        if (!count.ok || !isWord(count.value)) {
            errors.push(`${dex.label}: could not read the pair count${count.ok ? '' : ` (${count.error})`}`);
            continue;
        }
        const total = Number(BigInt(count.value));
        totals[id] = total;
        // The newest pools matter most, so if there are more than `maxPerDex` the oldest are the ones left out.
        const first = Math.max(0, total - maxPerDex);
        const indices = Array.from({ length: total - first }, (_, k) => first + k);
        const addrRes = await batch(indices.map(i => callOf(factory, '0x1e3dd18b' + word(i))));
        const listed = indices
            .map((index, k) => ({ index, r: addrRes[k] }))
            .filter(x => {
                if (!x.r.ok || !isWord(x.r.value)) {
                    errors.push(`${dex.label} pair #${x.index}: address unreadable`);
                    return false;
                }
                return true;
            })
            .map(x => ({ index: x.index, pair: toAddress((x.r as { ok: true; value: string }).value) }));

        const detailCalls = listed.flatMap(p => [
            callOf(p.pair, SELECTORS.token0),
            callOf(p.pair, SELECTORS.token1),
            callOf(p.pair, SELECTORS.getReserves),
            callOf(p.pair, SELECTORS.totalSupply),
            callOf(p.pair, SELECTORS.balanceOf + pad(DEAD_ADDRESS)),
            callOf(p.pair, SELECTORS.balanceOf + pad(ZERO_ADDRESS))
        ]);
        const d = await batch(detailCalls);
        const rows: { index: number; pair: string; t0: string; t1: string; r0: bigint; r1: bigint; supply: bigint; burned: bigint }[] = [];
        listed.forEach((p, k) => {
            const [t0, t1, res, sup, dead, zero] = d.slice(k * 6, k * 6 + 6);
            if (!t0.ok || !t1.ok || !res.ok || !isWord(t0.value) || !isWord(t1.value) || typeof res.value !== 'string' || res.value.length < 130) {
                errors.push(`${dex.label} ${p.pair}: not a readable pair`);
                return;
            }
            const r = res.value.slice(2);
            rows.push({
                index: p.index,
                pair: p.pair,
                t0: toAddress(t0.value),
                t1: toAddress(t1.value),
                r0: decodeBigInt(r.slice(0, 64)),
                r1: decodeBigInt(r.slice(64, 128)),
                supply: sup.ok ? decodeBigInt(sup.value) : 0n,
                burned: (dead.ok ? decodeBigInt(dead.value) : 0n) + (zero.ok ? decodeBigInt(zero.value) : 0n)
            });
        });
        await loadTokens(rows.flatMap(r => [r.t0, r.t1]), batch, tokenCache);
        for (const r of rows) {
            pairs.push({
                dex: id,
                pair: r.pair,
                index: r.index,
                token0: tokenCache.get(r.t0.toLowerCase())!,
                token1: tokenCache.get(r.t1.toLowerCase())!,
                reserve0: r.r0,
                reserve1: r.r1,
                totalSupply: r.supply,
                burned: r.burned
            });
        }
    }
    return { pairs, totals, errors, block };
}

// ------------------------------------------------------------------------------------ creation-time scanning

export interface PairCreation {
    pair: string;
    block: number;
    /** Unix seconds, from the block header. */
    timestamp?: number;
}

/**
 * Finds when pools were created by reading the factory's PairCreated events over the last `lookbackBlocks` blocks
 * (the node allows 10,000 blocks per query, so this is several queries per DEX). Pools older than the window are
 * simply absent: their age is "older than the window", never guessed.
 */
export async function scanPairCreations(
    factory: string,
    latestBlock: number,
    lookbackBlocks: number,
    batch: BatchFn = createBatch()
): Promise<PairCreation[]> {
    const windows: { from: number; to: number }[] = [];
    for (let to = latestBlock; to > Math.max(0, latestBlock - lookbackBlocks); to -= MAX_LOG_RANGE) {
        windows.push({ from: Math.max(0, to - MAX_LOG_RANGE + 1), to });
    }
    const res = await batch(
        windows.map(w => ({
            method: 'quai_getLogs',
            params: [{ address: factory, fromBlock: '0x' + w.from.toString(16), toBlock: '0x' + w.to.toString(16), topics: [PAIR_CREATED_TOPIC] }]
        }))
    );
    const found = new Map<string, PairCreation>();
    for (const r of res) {
        if (!r.ok || !Array.isArray(r.value)) continue;
        for (const log of r.value) {
            const data: string = log?.data ?? '';
            if (typeof data !== 'string' || data.length < 2 + 128 || !log.blockNumber) continue;
            const pair = toAddress(data.slice(2, 66));
            found.set(pair.toLowerCase(), { pair, block: Number(BigInt(log.blockNumber)) });
        }
    }
    const list = [...found.values()];
    const blocks = [...new Set(list.map(c => c.block))];
    const heads = await batch(blocks.map(b => ({ method: 'quai_getBlockByNumber', params: ['0x' + b.toString(16), false] })));
    const ts = new Map<number, number>();
    blocks.forEach((b, i) => {
        const h = heads[i];
        const t = h.ok ? h.value?.woHeader?.timestamp : undefined;
        if (typeof t === 'string') ts.set(b, Number(BigInt(t)));
    });
    return list.map(c => ({ ...c, timestamp: ts.get(c.block) }));
}

export interface CreationScan {
    creations: PairCreation[];
    /** First block the scan covered, and its timestamp (Unix seconds) if the node gave one. Pools older than this are not dated. */
    fromBlock: number;
    fromTime?: number;
}

/** Scans every live DEX's factory over the last `lookbackBlocks` blocks. */
export async function scanAllCreations(
    dexes: DexId[],
    latestBlock: number,
    lookbackBlocks: number,
    batch: BatchFn = createBatch()
): Promise<CreationScan> {
    const live = dexes.filter(isDexLive);
    const lists = await Promise.all(live.map(id => scanPairCreations(DEXES[id].factory!, latestBlock, lookbackBlocks, batch)));
    const fromBlock = Math.max(0, latestBlock - lookbackBlocks);
    const head = (await batch([{ method: 'quai_getBlockByNumber', params: ['0x' + fromBlock.toString(16), false] }]))[0];
    const t = head.ok ? head.value?.woHeader?.timestamp : undefined;
    return { creations: lists.flat(), fromBlock, fromTime: typeof t === 'string' ? Number(BigInt(t)) : undefined };
}

/** Adds creation times from a scan to snapshots (matched by pair address). */
export function applyCreations(pairs: PairSnapshot[], creations: PairCreation[]): PairSnapshot[] {
    const by = new Map(creations.map(c => [c.pair.toLowerCase(), c]));
    return pairs.map(p => {
        const c = by.get(p.pair.toLowerCase());
        return c ? { ...p, createdBlock: c.block, createdAt: c.timestamp ?? p.createdAt } : p;
    });
}

/** QUAI price in USD from CoinGecko, or null if it cannot be fetched (values are then shown in QUAI only). */
export async function fetchQuaiUsd(fetcher: Fetcher = defaultFetch): Promise<number | null> {
    try {
        const res = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=quai-network&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const v = (await res.json())?.['quai-network']?.usd;
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    } catch {
        return null;
    }
}

// ----------------------------------------------------------------------------------------------- analysis

export const human = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/**
 * Value of one whole token in QUAI, for every token reachable from WQUAI through pools with liquidity. A token's
 * price comes from the deepest pool that connects it to a token already priced, so a dust pool cannot overrule a
 * real one. Tokens with no route to WQUAI are absent.
 */
export function derivePrices(pairs: PairSnapshot[], anchor: string = TOKEN_REGISTRY.WQUAI.address): Map<string, { price: number; depth: number }> {
    const prices = new Map<string, { price: number; depth: number }>([[anchor.toLowerCase(), { price: 1, depth: Infinity }]]);
    for (let pass = 0; pass < 10; pass++) {
        let changed = false;
        for (const p of pairs) {
            if (p.reserve0 <= 0n || p.reserve1 <= 0n) continue;
            const h0 = human(p.reserve0, p.token0.decimals);
            const h1 = human(p.reserve1, p.token1.decimals);
            if (!(h0 > 0) || !(h1 > 0)) continue;
            const a0 = p.token0.address.toLowerCase();
            const a1 = p.token1.address.toLowerCase();
            const known0 = prices.get(a0);
            const known1 = prices.get(a1);
            if (known0) {
                const depth = known0.price * h0;
                if (!known1 || (known1.depth !== Infinity && depth > known1.depth)) {
                    prices.set(a1, { price: (known0.price * h0) / h1, depth });
                    changed = true;
                }
            }
            if (known1) {
                const depth = known1.price * h1;
                const cur = prices.get(a0);
                if (!cur || (cur.depth !== Infinity && depth > cur.depth)) {
                    prices.set(a0, { price: (known1.price * h1) / h0, depth });
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    return prices;
}

/** Value locked in QUAI: each side at its own price if known, else twice the priced side. Null if neither is priced. */
export function tvlQuai(p: PairSnapshot, prices: Map<string, { price: number; depth: number }>): number | null {
    const p0 = prices.get(p.token0.address.toLowerCase())?.price;
    const p1 = prices.get(p.token1.address.toLowerCase())?.price;
    const v0 = p0 !== undefined ? human(p.reserve0, p.token0.decimals) * p0 : null;
    const v1 = p1 !== undefined ? human(p.reserve1, p.token1.decimals) * p1 : null;
    if (v0 !== null && v1 !== null) return v0 + v1;
    if (v0 !== null) return v0 * 2;
    if (v1 !== null) return v1 * 2;
    return null;
}

/** Symbols of tokens this app lists: an unlisted token using one of these is imitating it. */
const registeredSymbols = () => new Set(Object.values(TOKEN_REGISTRY).map(t => t.symbol.toUpperCase()).concat(['QUAI']));
/** Symbols many unrelated tokens legitimately share; not an accusation, but the address must be checked. */
const SHARED_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'USD']);

export interface AnalyzeOptions {
    quaiUsd?: number | null;
    /** Unix seconds; defaults to now. */
    nowSec?: number;
    newestPerDex?: number;
}

/** Prices, value locked, and risk flags for a set of pools. Pure: same input, same output. */
export function analyzePairs(pairs: PairSnapshot[], opts: AnalyzeOptions = {}): PairAnalysis[] {
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const newest = opts.newestPerDex ?? NEWEST_PER_DEX;
    const usd = opts.quaiUsd ?? null;
    const prices = derivePrices(pairs);
    const reserved = registeredSymbols();

    // The newest N of each factory, by index.
    const newestIndex = new Map<DexId, number>();
    for (const p of pairs) newestIndex.set(p.dex, Math.max(newestIndex.get(p.dex) ?? -1, p.index));

    const base = pairs.map(p => {
        const tvl = tvlQuai(p, prices);
        const h0 = human(p.reserve0, p.token0.decimals);
        const h1 = human(p.reserve1, p.token1.decimals);
        const ageNew = p.createdAt !== undefined && now - p.createdAt < NEW_WITHIN_DAYS * 86400;
        const rankNew = p.index > (newestIndex.get(p.dex) ?? 0) - newest;
        return {
            ...p,
            price0Quai: prices.get(p.token0.address.toLowerCase())?.price ?? null,
            price1Quai: prices.get(p.token1.address.toLowerCase())?.price ?? null,
            tvlQuai: tvl,
            tvlUsd: tvl !== null && usd !== null ? tvl * usd : null,
            burnedPct: p.totalSupply > 0n ? Number((p.burned * 1_000_000n) / p.totalSupply) / 10_000 : 0,
            spot: h0 > 0 ? h1 / h0 : 0,
            // A known creation time decides; without one, rank within the factory is the only signal.
            isNew: p.createdAt !== undefined ? ageNew : rankNew,
            flags: [] as PairFlag[]
        };
    });

    // Same two tokens on more than one DEX: compare their spot prices.
    const groups = new Map<string, typeof base>();
    for (const p of base) {
        const key = [p.token0.address.toLowerCase(), p.token1.address.toLowerCase()].sort().join('/');
        groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const divergent = new Map<string, number>();
    for (const g of groups.values()) {
        const live = g.filter(p => p.spot > 0 && (p.tvlQuai ?? 0) >= DIVERGENCE_MIN_TVL_QUAI);
        if (live.length < 2) continue;
        // Normalise every pool's price to the first pool's token orientation.
        const ref = live[0].token0.address.toLowerCase();
        const px = live.map(p => (p.token0.address.toLowerCase() === ref ? p.spot : 1 / p.spot));
        const lo = Math.min(...px);
        const hi = Math.max(...px);
        const pct = (hi / lo - 1) * 100;
        if (pct >= DIVERGENCE_PCT) live.forEach(p => divergent.set(p.pair.toLowerCase(), pct));
    }

    for (const p of base) {
        const f = p.flags;
        const push = (code: FlagCode, severity: FlagSeverity, label: string, detail: string) => f.push({ code, severity, label, detail });
        if (p.isNew) push('NEW', 'info', 'New', p.createdAt !== undefined ? `Created ${new Date(p.createdAt * 1000).toUTCString()}.` : 'Among the newest pools of its factory.');
        if (p.reserve0 === 0n || p.reserve1 === 0n) {
            push('NO_LIQUIDITY', 'danger', 'Empty', 'One side of the pool has no reserves; nothing can be traded through it.');
        } else if (p.tvlQuai === null) {
            push('UNPRICED', 'warn', 'Unpriced', 'No route from this pool to WQUAI through pools with liquidity, so its value cannot be estimated.');
        } else if (p.tvlQuai < TINY_TVL_QUAI) {
            push('TINY_LIQUIDITY', 'danger', 'Tiny', `About ${p.tvlQuai.toFixed(1)} QUAI locked: any real trade moves the price enormously.`);
        } else if (p.tvlQuai < LOW_TVL_QUAI) {
            push('LOW_LIQUIDITY', 'warn', 'Thin', `About ${p.tvlQuai.toFixed(0)} QUAI locked: large trades will move the price.`);
        }
        if (p.totalSupply > 0n && p.burned === 0n) {
            push('NO_LP_BURNED', 'warn', 'LP not burned', 'None of the pool tokens are burned, so whoever holds them can remove the liquidity.');
        } else if (p.totalSupply > 0n && p.burnedPct < 1) {
            push('NO_LP_BURNED', 'info', 'Little LP burned', `Only ${p.burnedPct.toFixed(2)}% of the pool tokens are burned (the pool's built-in minimum lock).`);
        }
        for (const t of [p.token0, p.token1]) {
            if (!t.registered) {
                push('UNKNOWN_TOKEN', 'warn', `Unlisted ${t.symbol || 'token'}`, `${t.address} is not in this app's token registry: verify the contract before trusting its name.`);
                const up = t.symbol.toUpperCase();
                if (up && reserved.has(up)) {
                    push('SYMBOL_COLLISION', 'danger', `Imitates ${up}`, `${t.address} uses the symbol ${t.symbol} but is not the registered ${up} token.`);
                } else if (up && SHARED_SYMBOLS.has(up)) {
                    push('SYMBOL_COLLISION', 'warn', `Shares the symbol ${up}`, `Several different tokens on Quai are called ${up}. Check that ${t.address} is the one you mean.`);
                }
            }
            if (t.decimals !== 18 && t.registered === false) push('ODD_DECIMALS', 'info', `${t.symbol || 'Token'} has ${t.decimals} decimals`, 'Not 18: amounts entered by hand are easy to get wrong by orders of magnitude.');
        }
        const pct = divergent.get(p.pair.toLowerCase());
        if (pct !== undefined) push('PRICE_DIVERGENCE', 'info', `Price differs ${pct.toFixed(1)}% across DEXes`, 'The same pair is priced differently on another DEX: an arbitrage gap, or one of the pools is stale or thin.');
    }
    return base;
}

export type PairSortKey = 'newest' | 'tvl' | 'reserves' | 'burned';

export function sortPairs(list: PairAnalysis[], key: PairSortKey): PairAnalysis[] {
    const by: Record<PairSortKey, (a: PairAnalysis, b: PairAnalysis) => number> = {
        newest: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.index - a.index,
        tvl: (a, b) => (b.tvlQuai ?? -1) - (a.tvlQuai ?? -1),
        reserves: (a, b) => Number(b.reserve0 > b.reserve1 ? b.reserve0 : b.reserve1) - Number(a.reserve0 > a.reserve1 ? a.reserve0 : a.reserve1),
        burned: (a, b) => b.burnedPct - a.burnedPct
    };
    return [...list].sort(by[key]);
}

export interface ImpactRow {
    /** Trade size as a share of the input-side reserve. */
    pctOfReserve: number;
    amountIn: number;
    amountOut: number;
    /** How much worse than the spot price the trade fills, in percent (fee included). */
    impactPct: number;
}

/** Price impact of trades of various sizes against a constant-product pool with the 0.3% fee. */
export function priceImpactTable(reserveIn: number, reserveOut: number, pcts: number[] = [0.1, 0.5, 1, 5, 10]): ImpactRow[] {
    if (!(reserveIn > 0) || !(reserveOut > 0)) return [];
    return pcts.map(pct => {
        const amountIn = (reserveIn * pct) / 100;
        const withFee = amountIn * 0.997;
        const amountOut = (withFee * reserveOut) / (reserveIn + withFee);
        const spot = reserveOut / reserveIn;
        return { pctOfReserve: pct, amountIn, amountOut, impactPct: (1 - amountOut / amountIn / spot) * 100 };
    });
}

/** Compact number for tables: 1.2K, 3.4M, 0.0012. */
export function compactNumber(n: number | null | undefined, digits: number = 2): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(digits) + 'K';
    if (abs >= 1) return n.toFixed(digits);
    if (abs === 0) return '0';
    return n.toPrecision(3);
}
