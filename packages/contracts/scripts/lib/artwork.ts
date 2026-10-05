import * as crypto from "crypto";
import * as fs from "fs";

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const TXID = /^[A-Za-z0-9_-]{43}$/;

/** The 43-character Arweave transaction id in an `ar://` or `https://arweave.net/` URI. Throws otherwise. */
export function arweaveTxId(uri: string): string {
    const m = /^(?:ar:\/\/|https:\/\/arweave\.net\/)([^/?#]+)$/.exec(uri);
    if (!m || !TXID.test(m[1])) {
        throw new Error(`"${uri}" is not an Arweave URI (expected ar://<43-char txid> or https://arweave.net/<43-char txid>)`);
    }
    return m[1];
}

/** Gateway URL to fetch an Arweave URI over HTTPS. */
export function gatewayUrl(uri: string): string {
    return `https://arweave.net/${arweaveTxId(uri)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface ArtworkCheck {
    uri: string;
    sha256: string;
    bytes: number;
}

/**
 * Fetches `uri` from the Arweave gateway and proves it serves exactly the local file, byte for byte.
 * A 404, a truncated upload or a different image all abort the deploy: the contracts store the URI
 * forever and cannot repoint it.
 */
export async function verifyArtwork(
    uri: string,
    localFile: string,
    fetchImpl: FetchLike = url => fetch(url, { signal: AbortSignal.timeout(60_000) }) as unknown as ReturnType<FetchLike>,
    retries: number = 3,
    retryDelayMs: number = 4000
): Promise<ArtworkCheck> {
    const url = gatewayUrl(uri);
    const local = fs.readFileSync(localFile);
    const expected = sha256Hex(local);

    let lastError = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchImpl(url);
            if (!res.ok) {
                lastError = `HTTP ${res.status} from ${url}`;
            } else {
                const got = new Uint8Array(await res.arrayBuffer());
                const gotHash = sha256Hex(got);
                if (gotHash === expected) return { uri, sha256: expected, bytes: got.length };
                throw new Error(
                    `${url} serves different bytes than ${localFile} (sha256 ${gotHash} vs ${expected}, ${got.length} vs ${local.length} bytes).`
                );
            }
        } catch (e: any) {
            if (String(e.message).includes("serves different bytes")) throw e;
            lastError = e.message;
        }
        if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs));
    }
    throw new Error(`Artwork not available at ${url}: ${lastError}. Upload it first (scripts/upload-artwork.ts).`);
}
