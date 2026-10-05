// Off-chain mirror of the Qrb boost. The source of truth is the Qrb contract's BOOST_BPS, BOOST_THRESHOLD
// and BOOST_MATURITY constants (packages/contracts/contracts/Qrb.sol); the contract test suite and the
// deploy script both fail if these drift from what the compiled contract reports. Every app string that
// mentions the boost must be built from these, never typed out.

/** Extra farm rewards for a qualifying holder, in basis points of base rewards (5000 = +50%). */
export const QRB_BOOST_BPS = 5000;

/** Minimum QRB balance, in wei (18 decimals), that counts toward the boost: 0.0001 QRB. */
export const QRB_BOOST_THRESHOLD_WEI = 100000000000000n;

/**
 * How long a balance must have stayed at or above the threshold before it is boosted, in seconds (1 day).
 * The holding clock is what stops a balance being borrowed for one transaction to claim the boost.
 */
export const QRB_BOOST_MATURITY_SECONDS = 86400;

/** 5000 -> "50%", 1250 -> "12.5%", 5 -> "0.05%". Mirrors QrbFormat.pct in the contracts. */
export function formatBoostPct(bps: number = QRB_BOOST_BPS): string {
    const whole = Math.floor(bps / 100);
    const rem = bps % 100;
    if (rem === 0) return `${whole}%`;
    if (rem % 10 === 0) return `${whole}.${rem / 10}%`;
    return `${whole}.${String(rem).padStart(2, '0')}%`;
}

/** 86400 -> "1 day", 172800 -> "2 days", 3600 -> "1 hour", 90 -> "90 seconds". Mirrors QrbFormat.duration. */
export function formatBoostDuration(secs: number = QRB_BOOST_MATURITY_SECONDS): string {
    const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
    if (secs !== 0 && secs % 86400 === 0) return unit(secs / 86400, 'day');
    if (secs !== 0 && secs % 3600 === 0) return unit(secs / 3600, 'hour');
    if (secs !== 0 && secs % 60 === 0) return unit(secs / 60, 'minute');
    return unit(secs, 'second');
}

/**
 * Whether a base-unit QRB balance is at or above the boost threshold. This is only the balance half of the
 * rule: the boost also needs the balance to have been held for the maturity period, which only the contract
 * can say (`boostBpsOf`). Use this to explain a shortfall, never to claim a boost is active.
 */
export function meetsQrbBoostThreshold(balanceWei: bigint): boolean {
    return balanceWei >= QRB_BOOST_THRESHOLD_WEI;
}
