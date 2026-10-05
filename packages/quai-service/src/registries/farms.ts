// Canonical Farm & Staking Registry for Circleswap Dual-Reward Protocol

import { TOKEN_REGISTRY } from './tokens';
import { DEPLOYED } from './deployed';

export interface FarmPool {
    pid: number;
    name: string;
    stakeToken: {
        symbol: string;
        address: string;
        isLP: boolean;
    };
    rewardTokens: {
        tokenA: { symbol: string; name: string; address: string };
        tokenB?: { symbol: string; name: string; address: string };
    };
    allocPoint: number;
    depositFeePct: number;
    isSingleStake?: boolean;
}

/**
 * Address of the deployed CircleswapMasterChef on Cyprus-1, or null until it is deployed (generated into
 * deployed.ts by the deploy script, read off the deployment receipt).
 * While null the app treats every farm as read-only: no stake/harvest transactions are offered and
 * no staked or earned amounts are shown, because there is nothing on-chain to read them from.
 * APR and TVL are not stored here either: they are derived from live reserves once emissions exist.
 */
export const MASTERCHEF_ADDRESS: string | null = DEPLOYED.MASTERCHEF;

export const FARM_REGISTRY: FarmPool[] = [
    {
        pid: 0,
        name: 'Q0 / WQUAI LP Farm',
        stakeToken: {
            symbol: 'Q0-WQUAI LP',
            address: '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8',
            isLP: true
        },
        rewardTokens: {
            tokenA: { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address },
            tokenB: { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address }
        },
        allocPoint: 400,
        depositFeePct: 0
    },
    {
        pid: 1,
        name: 'Q0 / BOSS LP Farm',
        stakeToken: {
            symbol: 'Q0-BOSS LP',
            address: '0x0036c1A5e62597438cC204F8613c15211D4b7787',
            isLP: true
        },
        rewardTokens: {
            tokenA: { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address },
            tokenB: { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address }
        },
        allocPoint: 250,
        depositFeePct: 0
    },
    {
        pid: 2,
        name: 'LAPTOP / WQUAI LP Farm',
        stakeToken: {
            symbol: 'LAPTOP-WQUAI LP',
            address: '0x005935A658E99391786A3Dc6dAA9E8DC7eDDc6c9',
            isLP: true
        },
        rewardTokens: {
            tokenA: { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address },
            tokenB: { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address }
        },
        allocPoint: 200,
        depositFeePct: 0
    },
    {
        pid: 3,
        name: 'LAPTOP / QGIRL LP Farm',
        stakeToken: {
            symbol: 'LAPTOP-QGIRL LP',
            address: '0x0024cA5876d565097C2f6c48739B0D530BEcbec3',
            isLP: true
        },
        rewardTokens: {
            tokenA: { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address },
            tokenB: { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address }
        },
        allocPoint: 150,
        depositFeePct: 0
    },
    {
        pid: 4,
        name: 'BoltDelta Sovereign Staking Pool',
        stakeToken: {
            symbol: 'BDELTA',
            address: TOKEN_REGISTRY.BDELTA.address,
            isLP: false
        },
        rewardTokens: {
            tokenA: { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address }
        },
        allocPoint: 100,
        depositFeePct: 0,
        isSingleStake: true
    },
    {
        pid: 5,
        name: 'Q0 Singularity Staking Pool',
        stakeToken: {
            symbol: 'Q0',
            address: TOKEN_REGISTRY.Q0.address,
            isLP: false
        },
        rewardTokens: {
            tokenA: { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address }
        },
        allocPoint: 100,
        depositFeePct: 0,
        isSingleStake: true
    }
];

export function getFarmPool(pid: number): FarmPool | undefined {
    return FARM_REGISTRY.find(p => p.pid === pid);
}
