// The artwork a deployment will be tied to. The contracts take an Arweave URI in their constructors and have no
// setter, so the link is permanent: before it is used, the bytes it serves must be proven identical to the file
// the owner chose. This module holds that proof; the deploy modals refuse to start without it.

const KEY = 'q0.artwork.v1';
const ID = /^[A-Za-z0-9_-]{43}$/;

export interface SavedArtwork {
  /** ar://<id> */
  uri: string;
  sha256: string;
  bytes: number;
  name: string;
  /** Unix ms when the served bytes were last checked against `sha256`; null if the owner overrode the check. */
  verifiedAt: number | null;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Accepts ar://<id>, https://arweave.net/<id>, or a bare transaction id; returns the canonical ar:// form. */
export function normalizeArweaveUri(input: string): string | null {
  const s = input.trim();
  const m = /^(?:ar:\/\/|https:\/\/arweave\.net\/)?([A-Za-z0-9_-]{43})$/.exec(s);
  return m && ID.test(m[1]) ? `ar://${m[1]}` : null;
}

export const gatewayUrl = (uri: string) => `https://arweave.net/${uri.replace('ar://', '')}`;

export type VerifyOutcome =
  | { status: 'match'; bytes: number }
  | { status: 'mismatch'; bytes: number; sha256: string }
  | { status: 'unreachable'; detail: string };

/** Fetches what the URI serves and compares its SHA-256 with `expectedSha256`. */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function verifyUriServes(uri: string, expectedSha256: string, fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<VerifyOutcome> {
  try {
    const res = await fetcher(gatewayUrl(uri), { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) {
      return { status: 'unreachable', detail: res.status === 404 ? 'Not found yet. A fresh upload can take a few minutes to appear.' : `The gateway answered ${res.status}.` };
    }
    const buf = await res.arrayBuffer();
    const sha = await sha256Hex(buf);
    return sha === expectedSha256 ? { status: 'match', bytes: buf.byteLength } : { status: 'mismatch', bytes: buf.byteLength, sha256: sha };
  } catch (e: any) {
    return { status: 'unreachable', detail: e?.message ?? 'The gateway could not be reached.' };
  }
}

export const DEFAULT_VERIFIED_ARTWORK: SavedArtwork = {
  uri: 'ar://MbJXaZJwc0PjrCK2iwBblrR6m0aAYIUJ7xsIIpQpHQk',
  sha256: 'c377e4cf70bb42e0cea497cc879cc6fb5dcd04ee3f4050c3805992fc3f2ff72f',
  bytes: 2140452,
  name: 'QgoGIF.gif',
  verifiedAt: 1791140000000
};

export function loadArtwork(storage: Pick<Storage, 'getItem'> | null = safeStorage()): SavedArtwork | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return DEFAULT_VERIFIED_ARTWORK;
    const a = JSON.parse(raw) as SavedArtwork;
    return normalizeArweaveUri(a.uri) === a.uri && /^[0-9a-f]{64}$/.test(a.sha256) ? a : DEFAULT_VERIFIED_ARTWORK;
  } catch {
    return DEFAULT_VERIFIED_ARTWORK;
  }
}

export function saveArtwork(a: SavedArtwork, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage blocked: the artwork still works for this session through props */
  }
}

export function clearArtwork(storage: Pick<Storage, 'removeItem'> | null = safeStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`);
