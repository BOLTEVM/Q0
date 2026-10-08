// "Is the code at this address exactly the compiled contract?", answered from the chain.
//
// Length alone is not an answer (an imitation can be padded to the same length), so the code is compared by hash, with
// the compiler's immutables zeroed and its metadata trailer dropped. See ../codeHash.ts for the exact normalisation.

import { CIRCLESWAP_RUNTIME_BYTES } from '../generated/circleswapRuntimeSizes';
import { CIRCLESWAP_RUNTIME_HASHES } from '../generated/circleswapRuntimeHashes';
import { normalizedCodeHash } from '../codeHash';

export type CompiledName = keyof typeof CIRCLESWAP_RUNTIME_HASHES;

export type CodeState =
    /** Nothing deployed there. */
    | 'missing'
    /** A different amount of code than the compiled contract. */
    | 'wrong-size'
    /** The right amount of code, but not the compiled contract. */
    | 'wrong-code'
    | 'ok';

export interface CodeMatch {
    state: CodeState;
    /** Bytes of code found (0 if none). */
    size: number;
    /** Bytes the compiled contract has. */
    wantSize: number;
}

export async function matchCode(reader: { getCode(address: string): Promise<string> }, name: CompiledName, address: string): Promise<CodeMatch> {
    const wantSize = CIRCLESWAP_RUNTIME_BYTES[name];
    const code = await reader.getCode(address);
    if (!code || code === '0x') return { state: 'missing', size: 0, wantSize };
    const size = (code.length - 2) / 2;
    if (size !== wantSize) return { state: 'wrong-size', size, wantSize };
    const expected = CIRCLESWAP_RUNTIME_HASHES[name];
    return { state: normalizedCodeHash(code, expected.immutables) === expected.hash ? 'ok' : 'wrong-code', size, wantSize };
}
