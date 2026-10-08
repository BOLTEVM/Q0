// Verified AMM pools and swap routes on Cyprus-1.
//
// Cyprus-1 has two unrelated Uniswap-V2 deployments. A router only sees pairs made by its own
// factory, so a route must be sent to the router of the DEX that owns every hop. Verified on-chain
// 2026-09-20 via factory.getPair() and router.factory():
//   Quaiswap  factory 0x0006112e…57a9 <- router 0x006432Ea…e2d0  (Q0/WQUAI, Q0/BOSS)
//   Quainance factory 0x0018a110…9ede2 <- router 0x000d6795…305A (LAPTOP/WQUAI, LAPTOP/QGIRL, BDELTA/WQUAI)
// There is no BDELTA/Q0 pool on either factory yet. A BDELTA<->Q0 swap that hops through WQUAI would cross
// DEXes and cannot settle atomically, so it is not offered; the pool has to be created on one DEX
// (CANDIDATE_POOLS + the Create Pool modal) and is then routed as a single-DEX pair.
//
// Circleswap is a third DEX, our own (packages/contracts/contracts/amm): the same Uniswap-V2 interface, so
// the same encoders work, but its factory and router come from the generated deployed.ts and are null until
// they are deployed. Its pools are created by users, so they are not listed here: the app finds them by
// asking the factory (see circleswap.ts).

import { TOKEN_REGISTRY } from './tokens';
import { DEPLOYED } from './deployed';

export type DexId = 'QUAISWAP' | 'QUAINANCE' | 'CIRCLESWAP';

export interface DexInfo {
    id: DexId;
    label: string;
    /** null until the DEX is deployed (only Circleswap can be not-yet-deployed). */
    factory: string | null;
    router: string | null;
}

/** A DEX whose factory and router exist on-chain. */
export interface LiveDex extends DexInfo {
    factory: string;
    router: string;
}

export const DEXES: { QUAISWAP: LiveDex; QUAINANCE: LiveDex; CIRCLESWAP: DexInfo } = {
    QUAISWAP: {
        id: 'QUAISWAP',
        label: 'Quaiswap',
        factory: '0x0006112e89ee10615273ed72fe035cc068bc57a9',
        router: '0x006432Ea8c46cBF981f6e710d2439C941CeBe2d0'
    },
    QUAINANCE: {
        id: 'QUAINANCE',
        label: 'Quainance',
        factory: '0x0018a110b6ca369dcf5ab062c72f049e93b9ede2',
        router: '0x000d6795e06eA4F460CA9572a51741342156305A'
    },
    CIRCLESWAP: {
        id: 'CIRCLESWAP',
        label: 'Circleswap',
        get factory() { return DEPLOYED.AMM_FACTORY; },
        get router() { return DEPLOYED.AMM_ROUTER; }
    }
};

export function isDexLive(id: DexId): boolean {
    const d: DexInfo = DEXES[id];
    return d.factory !== null && d.router !== null;
}

/** The DEX, or an error naming it if it has not been deployed yet: nothing may be sent to a null router. */
export function requireDex(id: DexId): LiveDex {
    const d: DexInfo = DEXES[id];
    if (d.factory === null || d.router === null) throw new Error(`${d.label} is not deployed yet.`);
    return { ...d, factory: d.factory, router: d.router };
}

export interface PoolInfo {
    pair: string;
    dex: DexId;
    /** Symbols in on-chain token0/token1 order (informational; quotes orient from live token0). */
    tokens: [string, string];
}

export const POOL_REGISTRY: PoolInfo[] = [
    { pair: '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8', dex: 'QUAISWAP', tokens: ['Q0', 'WQUAI'] },
    { pair: '0x0036c1A5e62597438cC204F8613c15211D4b7787', dex: 'QUAISWAP', tokens: ['Q0', 'BOSS'] },
    { pair: '0x005935A658E99391786A3Dc6dAA9E8DC7eDDc6c9', dex: 'QUAINANCE', tokens: ['LAPTOP', 'WQUAI'] },
    { pair: '0x0024cA5876d565097C2f6c48739B0D530BEcbec3', dex: 'QUAINANCE', tokens: ['LAPTOP', 'QGIRL'] },
    { pair: '0x006524c3e3d2197dd61a64fef54f099260387209', dex: 'QUAINANCE', tokens: ['BDELTA', 'WQUAI'] }
];

/**
 * Pools that do not exist yet but are meant to: the app checks factory.getPair() for each on load and,
 * once one has been created (e.g. through the Create Pool modal), starts routing swaps through it.
 */
export const CANDIDATE_POOLS: Omit<PoolInfo, 'pair'>[] = [
    { dex: 'QUAISWAP', tokens: ['BDELTA', 'Q0'] },
    { dex: 'QUAINANCE', tokens: ['BDELTA', 'Q0'] },
    { dex: 'QUAISWAP', tokens: ['BDELTA', 'WQUAI'] }
];

export interface SwapRoute {
    id: string;
    label: string;
    dex: DexId;
    /** Only offered once every hop's pool exists (see CANDIDATE_POOLS). */
    optional?: boolean;
    /** Token symbols, first to last. Each adjacent pair must be a pool on `dex`. */
    path: string[];
}

/** One router-owned portion of a cross-DEX navigation path. */
export interface RouteSegment {
    dex: DexId;
    /** Token symbols, first to last. Every adjacent pair is a pool on `dex`. */
    path: string[];
}

/**
 * A route that crosses DEX boundaries at a shared token. Each segment is settled by its own router, so these
 * swaps require more than one wallet transaction and are deliberately not presented as atomic.
 */
export interface CrossDexRoute {
    id: string;
    label: string;
    path: string[];
    segments: RouteSegment[];
    crossDex: true;
}

export type NavigationRoute = SwapRoute | CrossDexRoute;

const NAVIGATION_TOKEN_PRIORITY = ['QRB', 'Q0', 'BDELTA', 'WQUAI'];

function tokenPriority(symbol: string): [number, string] {
    const index = NAVIGATION_TOKEN_PRIORITY.indexOf(symbol);
    return [index < 0 ? NAVIGATION_TOKEN_PRIORITY.length : index, symbol];
}

function compareTokens(a: string, b: string): number {
    const [aRank, aName] = tokenPriority(a);
    const [bRank, bName] = tokenPriority(b);
    return aRank - bRank || aName.localeCompare(bName);
}

function comparePaths(a: string[], b: string[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const cmp = compareTokens(a[i], b[i]);
        if (cmp) return cmp;
    }
    return a.length - b.length;
}

function routeScore(route: { path: string[]; segments: RouteSegment[] }): string {
    // Prefer the shortest bridge, then the fewest router changes. The token priority keeps the QRB -> Q0 ->
    // BDELTA -> WQUAI path stable and readable when more pools are added later.
    return [route.path.length, route.segments.length, ...route.path.map(t => tokenPriority(t)[0])].join(':');
}

function betterCrossRoute(a: CrossDexRoute, b: CrossDexRoute): CrossDexRoute {
    const scoreA = routeScore(a).split(':').map(Number);
    const scoreB = routeScore(b).split(':').map(Number);
    for (let i = 0; i < Math.max(scoreA.length, scoreB.length); i++) {
        const cmp = (scoreA[i] ?? 0) - (scoreB[i] ?? 0);
        if (cmp) return cmp < 0 ? a : b;
    }
    return comparePaths(a.path, b.path) <= 0 ? a : b;
}

function groupSegments(edges: { from: string; to: string; dex: DexId }[]): RouteSegment[] {
    const segments: RouteSegment[] = [];
    for (const edge of edges) {
        const current = segments[segments.length - 1];
        if (current?.dex === edge.dex) current.path.push(edge.to);
        else segments.push({ dex: edge.dex, path: [edge.from, edge.to] });
    }
    return segments;
}

/**
 * Build the best simple paths that cross between live DEXes at a shared token. A path is intentionally capped at
 * four pools: that covers the QRB -> Q0 -> BDELTA -> WQUAI bridge without turning the selector into an unbounded
 * graph search. The swap screen can reverse a route, so each endpoint pair is emitted once.
 */
export function buildCrossDexRoutes(pools: PoolInfo[], maxHops: number = 4): CrossDexRoute[] {
    const graph = new Map<string, { to: string; dex: DexId }[]>();
    const add = (from: string, to: string, dex: DexId) => {
        const edges = graph.get(from) ?? [];
        edges.push({ to, dex });
        graph.set(from, edges);
    };

    for (const pool of pools) {
        const [a, b] = pool.tokens;
        if (a === b) continue;
        add(a, b, pool.dex);
        add(b, a, pool.dex);
    }

    const candidates: CrossDexRoute[] = [];
    const symbols = [...graph.keys()].sort(compareTokens);
    for (const start of symbols) {
        const walk = (current: string, path: string[], edges: { from: string; to: string; dex: DexId }[]) => {
            if (edges.length >= 2 && new Set(edges.map(e => e.dex)).size > 1) {
                const orientedPath = compareTokens(path[0], path[path.length - 1]) <= 0 ? path : [...path].reverse();
                const orientedEdges = orientedPath[0] === path[0]
                    ? edges
                    : [...edges].reverse().map(e => ({ from: e.to, to: e.from, dex: e.dex }));
                const segments = groupSegments(orientedEdges);
                candidates.push({
                    id: `CROSS_${orientedPath.join('_')}_${segments.map(s => s.dex).join('_')}`,
                    label: `${orientedPath.join(' → ')} · ${segments.map(s => DEXES[s.dex].label).join(' → ')}`,
                    path: orientedPath,
                    segments,
                    crossDex: true
                });
            }
            if (edges.length >= maxHops) return;
            for (const edge of graph.get(current) ?? []) {
                if (path.includes(edge.to)) continue;
                walk(edge.to, [...path, edge.to], [...edges, { from: current, to: edge.to, dex: edge.dex }]);
            }
        };
        walk(start, [start], []);
    }

    const best = new Map<string, CrossDexRoute>();
    for (const candidate of candidates) {
        const endpoints = [candidate.path[0], candidate.path[candidate.path.length - 1]].sort(compareTokens).join('/');
        const previous = best.get(endpoints);
        if (!previous || betterCrossRoute(candidate, previous) === candidate) best.set(endpoints, candidate);
    }
    return [...best.values()].sort((a, b) => comparePaths(a.path, b.path));
}

/** Orient a cross-DEX plan in the direction selected by the swap form. */
export function orientedSegments(route: CrossDexRoute, reversed: boolean): RouteSegment[] {
    if (!reversed) return route.segments.map(s => ({ dex: s.dex, path: [...s.path] }));
    return [...route.segments].reverse().map(s => ({ dex: s.dex, path: [...s.path].reverse() }));
}

export const SWAP_ROUTES: SwapRoute[] = [
    { id: 'Q0_WQUAI', label: 'Q0 / WQUAI', dex: 'QUAISWAP', path: ['Q0', 'WQUAI'] },
    { id: 'Q0_BOSS', label: 'Q0 / BOSS', dex: 'QUAISWAP', path: ['Q0', 'BOSS'] },
    { id: 'BOSS_WQUAI', label: 'BOSS / WQUAI', dex: 'QUAISWAP', path: ['BOSS', 'Q0', 'WQUAI'] },
    { id: 'LAPTOP_WQUAI', label: 'LAPTOP / WQUAI', dex: 'QUAINANCE', path: ['LAPTOP', 'WQUAI'] },
    { id: 'LAPTOP_QGIRL', label: 'LAPTOP / QGIRL', dex: 'QUAINANCE', path: ['LAPTOP', 'QGIRL'] },
    { id: 'BDELTA_WQUAI', label: 'BDELTA / WQUAI', dex: 'QUAINANCE', path: ['BDELTA', 'WQUAI'] },
    { id: 'BDELTA_Q0_QUAISWAP', label: 'BDELTA / Q0 (Quaiswap)', dex: 'QUAISWAP', path: ['BDELTA', 'Q0'], optional: true },
    { id: 'BDELTA_Q0_QUAINANCE', label: 'BDELTA / Q0 (Quainance)', dex: 'QUAINANCE', path: ['BDELTA', 'Q0'], optional: true },
    { id: 'BDELTA_WQUAI_QUAISWAP', label: 'BDELTA / WQUAI (Quaiswap)', dex: 'QUAISWAP', path: ['BDELTA', 'WQUAI'], optional: true }
];

export function getSwapRoute(id: string): SwapRoute | undefined {
    return SWAP_ROUTES.find(r => r.id === id);
}

/** Path in the requested direction, as symbols. */
export function orientedPath(route: SwapRoute, reversed: boolean): string[] {
    return reversed ? [...route.path].reverse() : [...route.path];
}

export function tokenAddress(symbol: string): string {
    const t = TOKEN_REGISTRY[symbol];
    if (!t) throw new Error(`Unknown token ${symbol}`);
    return t.address;
}

/** Find the registered pool joining two token symbols on a DEX. */
export function findPool(dex: DexId, a: string, b: string, pools: PoolInfo[] = POOL_REGISTRY): PoolInfo | undefined {
    return pools.find(
        p => p.dex === dex && ((p.tokens[0] === a && p.tokens[1] === b) || (p.tokens[0] === b && p.tokens[1] === a))
    );
}
