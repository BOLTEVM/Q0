// Canonical Token Registry for Circleswap on Quai Network (Cyprus-1 Shard)

import { DEPLOYED } from './deployed';

export interface TokenInfo {
    symbol: string;
    name: string;
    decimals: number;
    address: string;
    isNative?: boolean;
    /** False for a token whose contract is not deployed yet; its address is a placeholder and must not be queried. */
    deployed?: boolean;
    isDualReward?: boolean;
    rewardRole?: 'DUAL_REWARD_A' | 'DUAL_REWARD_B' | 'GOVERNANCE_ARTIFACT';
    iconUrl?: string;
    description?: string;
}

export const TOKEN_REGISTRY: Record<string, TokenInfo> = {
    Q0: {
        symbol: 'Q0',
        name: 'QBOLT',
        decimals: 18,
        address: '0x00325150094E51107a931980Fdfc3bB1a4C48379',
        isDualReward: true,
        rewardRole: 'DUAL_REWARD_B',
        description: 'Circleswap Core Ecosystem Token & Dual Reward B'
    },
    BDELTA: {
        symbol: 'BDELTA',
        name: 'BOLTDELTA [delta.boltevm.com]',
        decimals: 18,
        address: '0x002d4A4fBAC3DF3342eD17FDBa5139818a43B508',
        isDualReward: true,
        rewardRole: 'DUAL_REWARD_A',
        description: 'BoltDelta Primary Incentive Token & Dual Reward A'
    },
    QRB: {
        symbol: 'QRB',
        name: 'Circleswap Qrb',
        decimals: 18,
        // Read from the generated deployed.ts; the 0x…01 placeholder is never a real contract.
        address: DEPLOYED.QRB ?? '0x0000000000000000000000000000000000000001',
        deployed: DEPLOYED.QRB !== null,
        rewardRole: 'GOVERNANCE_ARTIFACT',
        description: 'Sovereign 1-of-1 Genesis Artifact of Circleswap'
    },
    WQUAI: {
        symbol: 'WQUAI',
        name: 'Wrapped Quai',
        decimals: 18,
        address: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB',
        description: 'Wrapped Native Quai for AMM Routing'
    },
    BOSS: {
        symbol: 'BOSS',
        name: 'Quai Boss',
        decimals: 18,
        address: '0x004AFDb66677D177B759356D2367AeA3A79Fe58b',
        description: 'Quai Boss Community Token'
    },
    LAPTOP: {
        symbol: 'LAPTOP',
        name: 'FOOTJOB',
        decimals: 18,
        address: '0x000B27eDB0ca650059f70103D749F9eD1C3e71be',
        description: 'Quainance Ecosystem Token'
    },
    QGIRL: {
        symbol: 'QGIRL',
        name: 'QUAIRONIKA',
        decimals: 18,
        address: '0x001Db8F715A3135E0DB0A984dcD64d928dc76702',
        description: 'Quaironika Ecosystem Asset'
    },
    FEW: {
        symbol: 'FEW',
        name: 'FEW',
        decimals: 18,
        address: '0x001656Ffa3435B2d0FE5f5EfB1CaBD765CA1f68E',
        description: 'FEW Token on Cyprus-1'
    },
    TRAVEL: {
        symbol: 'TRAVEL',
        name: 'Travel Battery',
        decimals: 18,
        address: '0x006c18DD0086f7fB61058d79367a8Bda47E4D0C7',
        description: 'Travel Battery Utility Token'
    },
    QWHALE: {
        symbol: 'QWHALE',
        name: 'QUAI WHALE',
        decimals: 18,
        address: '0x006d31B1fFA989418653B00372A7112726cAD455',
        description: 'Quai Whale Community Token'
    },
    AXEQCAT: {
        symbol: 'AXEQCAT',
        name: 'AxeQcat',
        decimals: 18,
        address: '0x00416094760215dB9cE00f316bd51b79B3d9f629',
        description: 'AxeQcat Meme Asset'
    },
    QCON: {
        symbol: 'QCON',
        name: 'Connor Mattimore',
        decimals: 18,
        address: '0x006EC223cf37EA984E2490A73944338b66843f74',
        description: 'Connor Mattimore Community Asset'
    },
    CHEEZ: {
        symbol: 'CHEEZ',
        name: 'CHEEZ',
        decimals: 18,
        address: '0x0016c3221B6a1707427d660945CD284a9Be58Cec',
        description: 'CHEEZ Token on Cyprus-1'
    },
    QAXE: {
        symbol: 'QAXE',
        name: 'QuaiAxe',
        decimals: 18,
        address: '0x0035187a7660f595D93cd53a4D16c635D6cFFC8f',
        description: 'QuaiAxe Community Token'
    },
    QUAI: {
        symbol: 'QUAI',
        name: 'Quai',
        decimals: 18,
        address: '0x0000000000000000000000000000000000000000',
        isNative: true,
        description: 'Cyprus-1 Shard Native Gas Asset'
    }
};

export const REGISTERED_TOKENS = Object.values(TOKEN_REGISTRY);

export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
    return TOKEN_REGISTRY[symbol.toUpperCase()];
}

export function getTokenByAddress(address: string): TokenInfo | undefined {
    const clean = address.toLowerCase();
    // Use the live registry object rather than the startup snapshot so the browser can safely register
    // user-imported ERC-20 metadata for pool discovery without changing the generated token list.
    return Object.values(TOKEN_REGISTRY).find(t => t.address.toLowerCase() === clean);
}
