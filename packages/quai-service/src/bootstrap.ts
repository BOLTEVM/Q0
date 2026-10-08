// Start-up step for deployments made from the browser. A deployment made in the UI is remembered in this
// browser's storage until its addresses are committed to registries/deployed.ts. Because those addresses decide
// where swaps, stakes and LP deposits are sent, nothing in storage is trusted: each one is re-checked on chain
// (it must be a Cyprus-1 contract with exactly the compiled code) BEFORE the app's modules are loaded, and any
// that fails the check is dropped and reported.
//
// Deliberately imports nothing heavy (no `quais`, no bytecode): it must run before, and instead of, the rest of
// the package. A value already set in the generated deployed.ts always wins and is never overridden.

import { getAddress } from 'quais';
import { DEPLOYED, type DeployedAddresses } from './registries/deployed';
import { CIRCLESWAP_RUNTIME_BYTES } from './generated/circleswapRuntimeSizes';
import { EIP1967_IMPLEMENTATION_SLOT } from './eip1967';
export { EIP1967_IMPLEMENTATION_SLOT, EIP1967_BEACON_SLOT, EIP1967_ADMIN_SLOT } from './eip1967';

export const LOCAL_DEPLOYMENTS_KEY = 'q0.deployments.v1';
const RPC = 'https://rpc.quai.network/cyprus1';

type AddressKey = Exclude<keyof DeployedAddresses, 'ARTWORK_URI'>;
const CONTRACT_OF: Record<AddressKey, keyof typeof CIRCLESWAP_RUNTIME_BYTES> = {
    QRB: 'Qrb',
    QRB_NFT: 'QrbArtifactNFT',
    MASTERCHEF: 'CircleswapMasterChef',
    AMM_FACTORY: 'CircleswapFactory',
    AMM_ROUTER: 'CircleswapRouter'
};
const ADDRESS_KEYS = Object.keys(CONTRACT_OF) as AddressKey[];
const ADDRESS = /^0x00[0-9a-fA-F]{38}$/; // a Cyprus-1 address: 20 bytes starting 0x00
const ARWEAVE = /^(ar:\/\/|https:\/\/arweave\.net\/)[A-Za-z0-9_-]{43}$/;

export interface StoredDeployments {
    chainId: number;
    savedAt: number;
    values: Partial<DeployedAddresses>;
}

export interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const browserStorage = (): KeyValueStorage | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null; // storage blocked
    }
};

export function readLocalDeployments(storage: KeyValueStorage | null = browserStorage()): StoredDeployments | null {
    try {
        const raw = storage?.getItem(LOCAL_DEPLOYMENTS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredDeployments;
        return parsed && parsed.chainId === 9 && parsed.values && typeof parsed.values === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** Remembers addresses for this browser. They take effect only after the start-up check above passes. */
export function saveLocalDeployments(values: Partial<DeployedAddresses>, storage: KeyValueStorage | null = browserStorage()): void {
    const clean: Partial<DeployedAddresses> = {};
    for (const key of ADDRESS_KEYS) {
        const v = values[key];
        if (v && ADDRESS.test(v)) clean[key] = getAddress(v);
    }
    if (values.ARTWORK_URI && ARWEAVE.test(values.ARTWORK_URI)) clean.ARTWORK_URI = values.ARTWORK_URI;
    const existing = readLocalDeployments(storage)?.values ?? {};
    storage?.setItem(LOCAL_DEPLOYMENTS_KEY, JSON.stringify({ chainId: 9, savedAt: Date.now(), values: { ...existing, ...clean } } satisfies StoredDeployments));
}

export function clearLocalDeployments(storage: KeyValueStorage | null = browserStorage()): void {
    storage?.removeItem(LOCAL_DEPLOYMENTS_KEY);
}

export interface BootstrapReport {
    applied: AddressKey[];
    /** Stored values that failed the on-chain check and were dropped. */
    rejected: { key: string; reason: string }[];
    /** Stored values ignored because the generated deployed.ts already sets them. */
    shadowed: string[];
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

async function rpc(fetcher: Fetcher, rpcUrl: string, method: string, params: unknown[]): Promise<any> {
    const res = await fetcher(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(8000) : undefined
    });
    if (!res.ok) throw new Error('RPC unavailable');
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

/**
 * Applies the browser-local deployments that pass the on-chain check to the shared `DEPLOYED` object. Call it,
 * and await it, before importing anything that reads `DEPLOYED` at load (the registries, the app).
 */
export async function applyVerifiedLocalDeployments(
    opts: { storage?: KeyValueStorage | null; fetcher?: Fetcher; rpcUrl?: string } = {}
): Promise<BootstrapReport> {
    const report: BootstrapReport = { applied: [], rejected: [], shadowed: [] };
    const storage = opts.storage === undefined ? browserStorage() : opts.storage;
    const stored = readLocalDeployments(storage);
    if (!stored) return report;
    const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    const rpcUrl = opts.rpcUrl ?? RPC;

    const accepted: Partial<Record<AddressKey, string>> = {};
    await Promise.all(
        ADDRESS_KEYS.map(async key => {
            const rawAddress = stored.values[key];
            if (!rawAddress) return;
            if (DEPLOYED[key] !== null) {
                report.shadowed.push(key);
                return;
            }
            try {
                if (!ADDRESS.test(rawAddress)) throw new Error('not a Cyprus-1 address');
                const address = getAddress(rawAddress);
                if (key === 'AMM_FACTORY' || key === 'AMM_ROUTER') {
                    const code: string = await rpc(fetcher, rpcUrl, 'quai_getCode', [address, 'latest']);
                    const size = code && code !== '0x' ? (code.length - 2) / 2 : 0;
                    if (size === 0) throw new Error('no contract at this address');
                    const wantProxy = CIRCLESWAP_RUNTIME_BYTES.ERC1967Proxy;
                    if (size !== wantProxy) throw new Error(`${size} bytes of code, the compiled ERC1967Proxy is ${wantProxy}`);

                    const rawImpl: string = await rpc(fetcher, rpcUrl, 'quai_getStorageAt', [address, EIP1967_IMPLEMENTATION_SLOT, 'latest']);
                    if (!rawImpl || rawImpl === '0x' || rawImpl === '0x' + '00'.repeat(32)) {
                        throw new Error('EIP-1967 implementation slot is empty');
                    }
                    const implAddress = getAddress('0x' + rawImpl.slice(-40));
                    if (!ADDRESS.test(implAddress)) throw new Error('implementation is not a Cyprus-1 address');

                    const implCode: string = await rpc(fetcher, rpcUrl, 'quai_getCode', [implAddress, 'latest']);
                    const implSize = implCode && implCode !== '0x' ? (implCode.length - 2) / 2 : 0;
                    if (implSize === 0) throw new Error('no contract at implementation address');
                    const wantImpl = CIRCLESWAP_RUNTIME_BYTES[CONTRACT_OF[key]];
                    if (implSize !== wantImpl) throw new Error(`${implSize} bytes of code at implementation, the compiled ${CONTRACT_OF[key]} is ${wantImpl}`);
                    accepted[key] = address;
                } else {
                    const code: string = await rpc(fetcher, rpcUrl, 'quai_getCode', [address, 'latest']);
                    const size = code && code !== '0x' ? (code.length - 2) / 2 : 0;
                    if (size === 0) throw new Error('no contract at this address');
                    const want = CIRCLESWAP_RUNTIME_BYTES[CONTRACT_OF[key]];
                    if (size !== want) throw new Error(`${size} bytes of code, the compiled ${CONTRACT_OF[key]} is ${want}`);
                    accepted[key] = address;
                }
            } catch (e: any) {
                report.rejected.push({ key, reason: e?.message ?? 'check failed' });
            }
        })
    );

    // A router is only meaningful next to the factory it was built for.
    if (accepted.AMM_ROUTER) {
        const factory = accepted.AMM_FACTORY ?? DEPLOYED.AMM_FACTORY;
        try {
            if (!factory) throw new Error('no factory to pair with');
            const routerAddr = getAddress(accepted.AMM_ROUTER);
            const factoryAddr = getAddress(factory);
            const out: string = await rpc(fetcher, rpcUrl, 'quai_call', [{ to: routerAddr, data: '0xc45a0155' }, 'latest']); // factory()
            if (typeof out !== 'string' || getAddress('0x' + out.slice(-40)) !== factoryAddr) throw new Error('router was built for a different factory');
        } catch (e: any) {
            report.rejected.push({ key: 'AMM_ROUTER', reason: e?.message ?? 'check failed' });
            delete accepted.AMM_ROUTER;
        }
    }

    for (const key of ADDRESS_KEYS) {
        const v = accepted[key];
        if (v) {
            DEPLOYED[key] = v;
            report.applied.push(key);
        }
    }
    if (DEPLOYED.ARTWORK_URI === null && stored.values.ARTWORK_URI && ARWEAVE.test(stored.values.ARTWORK_URI)) {
        DEPLOYED.ARTWORK_URI = stored.values.ARTWORK_URI;
    }

    // Drop whatever failed so a stale pointer cannot come back on the next load.
    // Transient network or RPC errors must not prune otherwise valid saved deployments.
    if (report.rejected.length && storage) {
        const isNetworkErr = (reason: string) => /RPC unavailable|timeout|Failed to fetch|NetworkError|fetch failed/i.test(reason);
        const trulyInvalid = report.rejected.filter(r => !isNetworkErr(r.reason));
        if (trulyInvalid.length > 0) {
            const keep = { ...stored.values };
            for (const r of trulyInvalid) delete (keep as Record<string, unknown>)[r.key];
            storage.setItem(LOCAL_DEPLOYMENTS_KEY, JSON.stringify({ ...stored, values: keep }));
        }
    }
    return report;
}
