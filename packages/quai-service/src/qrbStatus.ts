// Reads a wallet's real boost state from the deployed Qrb contract. The contract is the only authority: a
// balance at the threshold is not enough, it must also have been held for the maturity period.
//
//   boostBpsOf(address)        0x3487b7fd
//   boostEligibleAt(address)   0xed0d5560

import { quaiCall, getTokenBalance } from './index';

export interface QrbBoostStatus {
    /** QRB balance, base units. */
    balance: bigint;
    /** Boost the farm will pay this wallet right now, in basis points (0 if not boosted). */
    boostBps: bigint;
    /**
     * Unix seconds at which the wallet becomes (or became) eligible, or 0 if it is below the threshold.
     * A future value means the balance qualifies but has not been held long enough yet.
     */
    eligibleAt: number;
}

const word = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');

export async function getQrbBoostStatus(qrb: string, holder: string): Promise<QrbBoostStatus> {
    const [balance, bps, at] = await Promise.all([
        getTokenBalance(qrb, holder),
        quaiCall(qrb, '0x3487b7fd' + word(holder)),
        quaiCall(qrb, '0xed0d5560' + word(holder))
    ]);
    return {
        balance: BigInt(balance),
        boostBps: !bps || bps === '0x' ? 0n : BigInt(bps),
        eligibleAt: !at || at === '0x' ? 0 : Number(BigInt(at))
    };
}

/** Human status for the UI, from a status and the current time (seconds). */
export function describeQrbBoost(status: QrbBoostStatus, thresholdWei: bigint, nowSeconds: number): 'ACTIVE' | 'MATURING' | 'BELOW_THRESHOLD' {
    if (status.boostBps > 0n) return 'ACTIVE';
    if (status.balance >= thresholdWei && status.eligibleAt > nowSeconds) return 'MATURING';
    return 'BELOW_THRESHOLD';
}
