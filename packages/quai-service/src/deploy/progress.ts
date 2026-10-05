// Where a half-finished deployment is remembered. After a failure part-way (gas already spent) nothing may be
// lost, so the address of every deployed contract and the hash of every sent transaction is written down as it
// happens. Storage is only a hint: a resumed run re-verifies everything against the chain.

import type { FlowContext } from './flows';

/** The subset of Storage the progress store needs, so tests and non-browser hosts can supply their own. */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface StepProgress {
    done: boolean;
    /** Set the moment the wallet returns a hash, before the transaction is confirmed. */
    txHash?: string;
    blockNumber?: number;
    gasUsed?: string;
    address?: string;
}

export interface FlowProgress {
    flow: string;
    chainId: number;
    from: string;
    ctx: FlowContext;
    steps: Record<string, StepProgress>;
    /**
     * A digest of the settings the run was started with (owner, artwork, rates, pools...). A saved run is only
     * resumed under the same settings: its recorded addresses and skipped steps belong to them.
     */
    fingerprint?: string;
    updatedAt: number;
}

export const progressKey = (flow: string, chainId: number, from: string) => `q0.deploy.v1.${chainId}.${flow}.${from.toLowerCase()}`;

export function emptyProgress(flow: string, chainId: number, from: string, ctx: FlowContext = {}, fingerprint?: string): FlowProgress {
    return { flow, chainId, from, ctx: { ...ctx }, steps: {}, ...(fingerprint !== undefined ? { fingerprint } : {}), updatedAt: Date.now() };
}

/** True when a saved run may be resumed under `fingerprint` (a run saved without one is treated as a mismatch). */
export function sameSettings(progress: FlowProgress, fingerprint: string): boolean {
    return progress.fingerprint === fingerprint;
}

export function loadProgress(store: KeyValueStore, flow: string, chainId: number, from: string): FlowProgress | null {
    try {
        const raw = store.getItem(progressKey(flow, chainId, from));
        if (!raw) return null;
        const p = JSON.parse(raw) as FlowProgress;
        if (p.flow !== flow || p.chainId !== chainId || p.from.toLowerCase() !== from.toLowerCase() || typeof p.steps !== 'object') return null;
        return p;
    } catch {
        return null; // unreadable storage must never block a deployment, only the resume shortcut
    }
}

export function saveProgress(store: KeyValueStore, progress: FlowProgress): void {
    progress.updatedAt = Date.now();
    try {
        store.setItem(progressKey(progress.flow, progress.chainId, progress.from), JSON.stringify(progress));
    } catch {
        /* quota or private mode: the receipt is still on chain and on screen */
    }
}

export function clearProgress(store: KeyValueStore, flow: string, chainId: number, from: string): void {
    try {
        store.removeItem(progressKey(flow, chainId, from));
    } catch {
        /* nothing to clear */
    }
}

/** Steps with a sent transaction that was never confirmed: the ones a resume must wait on, not resend. */
export function pendingSteps(progress: FlowProgress): string[] {
    return Object.entries(progress.steps)
        .filter(([, s]) => !s.done && s.txHash)
        .map(([id]) => id);
}
