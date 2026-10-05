// Quai-specific contract-creation helpers. Kept out of the main `quai-service` entry on purpose: they need the
// `quais` SDK, which only the deploy modals load.

import { Interface, getCreateAddress, getZoneForAddress, isQiAddress, getAddress, Zone } from 'quais';
import { CIRCLESWAP_ARTIFACTS, type CircleswapArtifactName } from '../generated/circleswapArtifacts';

export { EIP1967_IMPLEMENTATION_SLOT, EIP1967_BEACON_SLOT, EIP1967_ADMIN_SLOT } from '../eip1967';


/** True for an address that can host contracts in Cyprus-1: right zone, and a Quai (not Qi) address. */
export function isCyprus1QuaiAddress(address: string): boolean {
    try {
        return getZoneForAddress(address) === Zone.Cyprus1 && !isQiAddress(address);
    } catch {
        return false;
    }
}

/** Throws unless `address` is a Cyprus-1 Quai address: a contract anywhere else is unreachable from this shard. */
export function assertCyprus1(address: string): void {
    if (!isCyprus1QuaiAddress(address)) {
        throw new Error(`${address} is not a Cyprus-1 Quai address; a contract there is unreachable from this shard`);
    }
}

/** Checksummed form, which is the only spelling Quai's RPC accepts. Throws on anything that is not an address. */
export function checksum(address: string): string {
    return getAddress(address);
}

export function interfaceOf(name: CircleswapArtifactName): Interface {
    return new Interface(CIRCLESWAP_ARTIFACTS[name].abi);
}

/** Creation bytecode followed by the ABI-encoded constructor arguments. */
export function creationData(name: CircleswapArtifactName, args: unknown[]): string {
    const iface = interfaceOf(name);
    return CIRCLESWAP_ARTIFACTS[name].bytecode + iface.encodeDeploy(args).slice(2);
}

/**
 * Quai only accepts a contract whose address lands in the deployer's zone. The address is derived from
 * (sender, nonce, initcode), so the SDK appends a 4-byte salt to the init data and increments it until the
 * derived address is in-zone. The salt sits after the ABI-encoded constructor arguments, which the constructor
 * ignores. Deterministic for a given (from, nonce, data), and identical to the CLI's
 * (packages/contracts/scripts/lib/quaiClient.ts): tests/deployPlan.test.ts pins the two together.
 *
 * The result is a prediction. The wallet must send the transaction with exactly this nonce, and the address
 * that counts is always the one on the receipt.
 */
export function grindCreationData(
    from: string,
    nonce: number,
    data: string,
    isAcceptable: (address: string) => boolean = isCyprus1QuaiAddress,
    maxAttempts: number = 200_000
): { data: string; predictedAddress: string; attempts: number } {
    let salt = nonce >>> 0;
    for (let attempts = 1; attempts <= maxAttempts; attempts++) {
        const candidate = data + salt.toString(16).padStart(8, '0');
        const predictedAddress = getCreateAddress({ from, nonce, data: candidate });
        if (isAcceptable(predictedAddress)) return { data: candidate, predictedAddress, attempts };
        salt = (salt + 1) >>> 0;
    }
    throw new Error(`Could not grind an in-zone contract address in ${maxAttempts} attempts`);
}
