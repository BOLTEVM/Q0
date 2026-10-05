// Exact base-unit conversion. Never route token amounts through Number: a balance above 2^53 wei
// (~0.009 tokens at 18 decimals) loses its low digits, and `Number(x) * 1e18` is off for most inputs.

/** "1.25" -> 1250000000000000000n. Throws on malformed input or more fractional digits than `decimals`. */
export function parseUnits(value: string, decimals: number = 18): bigint {
    const v = value.trim();
    if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') {
        throw new Error(`Invalid amount "${value}"`);
    }
    const [whole, frac = ''] = v.split('.');
    if (frac.length > decimals) {
        throw new Error(`Too many decimal places (max ${decimals})`);
    }
    return BigInt((whole || '0') + frac.padEnd(decimals, '0'));
}

/** 1250000000000000000n -> "1.25". Truncates (never rounds up) to `maxFraction` places, trims trailing zeros. */
export function formatUnits(value: bigint | string, decimals: number = 18, maxFraction: number = 6): string {
    const raw = typeof value === 'bigint' ? value : BigInt(value || '0');
    const neg = raw < 0n;
    const abs = neg ? -raw : raw;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
    const out = frac ? `${whole}.${frac}` : whole.toString();
    return neg ? `-${out}` : out;
}

/** Slippage tolerance ceiling, in percent. Above this a "minimum received" protects nothing. */
export const MAX_SLIPPAGE_PCT = 50;

/**
 * A slippage tolerance that is always safe to turn into basis points: finite, and within [0, 50]. Anything
 * else (NaN, Infinity, a negative number from a mistyped field) is pulled back to a safe value instead of
 * throwing inside BigInt() or producing a minimum above the quoted output, which would make the swap
 * revert on-chain and burn its gas limit.
 */
export function clampSlippagePct(pct: number, fallback: number = 1): number {
    if (typeof pct !== 'number' || Number.isNaN(pct)) return fallback;
    if (pct < 0) return 0;
    if (pct > MAX_SLIPPAGE_PCT) return MAX_SLIPPAGE_PCT;
    return pct; // finite here: +-Infinity are caught by the range checks above
}
