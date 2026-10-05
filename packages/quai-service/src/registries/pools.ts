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
        factory: DEPLOYED.AMM_FACTORY,
        router: DEPLOYED.AMM_ROUTER
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
