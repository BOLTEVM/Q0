// How much gas to allow a contract creation. One rule, used by the browser runner and the command line alike.
//
// The node's simulator is not a reliable guide to what a creation really costs on Quai, and it errs in BOTH directions:
// a 16.9 KB contract once used 2.5x its simulated gas, a 19.3 KB one a month later used 0.43x of what the same bytecode
// simulates to today, and the simulator prices creations made from inside a constructor (a proxy whose initialize()
// creates more contracts) erratically. Gas the transaction does not use is refunded, but running out reverts and burns the
// entire limit, so the cheap mistake is a generous limit and the expensive one a tight limit.
//
//     limit = max( estimate x 3,  2 x (what ordinary EVM rules require) + 500,000 )
//
// The second term is a floor that does not trust the simulator at all: the code a transaction deposits costs 200 gas a
// byte, its init data 16 a byte, plus the fixed creation cost, doubled for safety.

export const CREATION_GAS_MULTIPLIER = 3;
const CODE_DEPOSIT_GAS_PER_BYTE = 200n;
const CALLDATA_GAS_PER_BYTE = 16n;
const CREATION_BASE_GAS = 53_000n;

/** What a creation needs under ordinary EVM rules: the floor of its cost, not a prediction. */
export function minimumCreationGas(depositedBytes: number, initcodeBytes: number): bigint {
    return CREATION_BASE_GAS + CODE_DEPOSIT_GAS_PER_BYTE * BigInt(depositedBytes) + CALLDATA_GAS_PER_BYTE * BigInt(initcodeBytes);
}

/**
 * The gas limit for a contract creation.
 * @param estimate        what the node's simulator reported
 * @param depositedBytes  runtime code the transaction leaves on chain: the contract itself plus anything its constructor
 *                        (or, for a proxy, the initialize call it makes) creates in turn
 * @param initcodeBytes   length of the transaction's data
 */
export function creationGasLimit(estimate: bigint, depositedBytes: number, initcodeBytes: number, multiplier: number = CREATION_GAS_MULTIPLIER): bigint {
    const padded = (estimate * BigInt(Math.round(multiplier * 100))) / 100n;
    const floor = 2n * minimumCreationGas(depositedBytes, initcodeBytes) + 500_000n;
    return padded > floor ? padded : floor;
}
