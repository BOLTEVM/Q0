// Exact comparison of deployed code with compiled code.
//
// A length check proves very little: anyone can pad a malicious contract to the length of the real one. The hash used
// here covers every executable byte, with two normalisations, so it is the same wherever the contract was built:
//
//  * immutable values are zeroed. The compiler leaves zeros where an immutable lives and the constructor writes the
//    real value into the deployed code (UUPS's `__self`, for one), so the on-chain bytes differ from the compiled bytes
//    in exactly those ranges. The ranges come from the compiler's own `immutableReferences`.
//  * the CBOR metadata trailer is dropped. It is not executable (it follows the final INVALID) and encodes a hash of the
//    sources, which changes with line endings and file paths, not with behaviour.
//
// Used by the exporter (to compute the expected hash from the compiled artifact) and by the verifiers (to compute the
// hash of what is actually on chain), so both sides always run the same function.

import { keccak256 } from 'quais';

/** [byte offset, byte length] of one immutable inside the runtime code. */
export type ImmutableRange = readonly [number, number];

const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** The code without its CBOR metadata trailer (a 2-byte big-endian length at the very end, covering the data before it). */
export function stripMetadata(code: string): string {
    if (!HEX.test(code)) throw new Error('Code is not a hex string.');
    const bytes = (code.length - 2) / 2;
    if (bytes < 2) return code;
    const cborLength = parseInt(code.slice(-4), 16);
    const total = cborLength + 2;
    // A trailer that does not fit inside the code is not a trailer: hash everything rather than guess.
    if (total >= bytes) return code;
    return code.slice(0, code.length - total * 2);
}

/** `code` with each immutable range replaced by zeros. */
export function zeroImmutables(code: string, immutables: readonly ImmutableRange[]): string {
    if (!HEX.test(code)) throw new Error('Code is not a hex string.');
    let hex = code.slice(2);
    for (const [start, length] of immutables) {
        if (start < 0 || length <= 0 || (start + length) * 2 > hex.length) {
            // Shorter than the compiled code: it cannot be the same contract. Leave it for the comparison to reject.
            return code;
        }
        hex = hex.slice(0, start * 2) + '00'.repeat(length) + hex.slice((start + length) * 2);
    }
    return '0x' + hex;
}

/** keccak256 of the code as described at the top of this file. */
export function normalizedCodeHash(code: string, immutables: readonly ImmutableRange[] = []): string {
    return keccak256(stripMetadata(zeroImmutables(code, immutables)));
}
