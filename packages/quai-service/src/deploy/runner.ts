// Runs a deployment flow through the user's wallet. The app never holds a key: every transaction is built here,
// simulated against the node, and then handed to the wallet to sign. What this adds over "just send it":
//
//  * a revert on Quai burns the whole gas limit, so nothing is sent until the node has simulated it successfully;
//  * creation gas on Quai is ~2.5x the estimate, so creations get a wide limit and calls a modest one;
//  * a contract's address is taken from its receipt and from nowhere else (Quai grinds addresses), must be a
//    Cyprus-1 address, and must have the compiled code on chain before the next step is built on it;
//  * a transaction that was sent but not yet confirmed is written down first, so a reload or a timeout resumes
//    waiting for it instead of deploying a second copy.

import { CIRCLESWAP_ARTIFACTS } from '../generated/circleswapArtifacts';
import { assertCyprus1, checksum, creationData, grindCreationData, interfaceOf } from './chain';
import type { DeployStep, Flow, FlowContext, Reader } from './flows';
import { emptyProgress, saveProgress, type FlowProgress, type KeyValueStore } from './progress';

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export interface WalletLike {
    request(args: { method: string; params?: unknown[] }): Promise<any>;
}

export interface RunnerEnv {
    rpc: Rpc;
    wallet: WalletLike;
    /** The connected account: a Cyprus-1 address. It signs, and pays. */
    from: string;
    chainId?: number;
    /** Blocks that must be built on top of a receipt before it is trusted. Default 2. */
    confirmations?: number;
    /** Gas limit = estimate x this. Quai creations cost ~2.5x the estimate. Default 3. */
    creationGasMultiplier?: number;
    callGasMultiplier?: number;
    pollMs?: number;
    receiptTimeoutMs?: number;
    store?: KeyValueStore;
    /**
     * Checks that a created contract's address is usable. The default is the Cyprus-1 rule, which production must
     * keep. Only a test chain that is not Quai (whose addresses ignore the init code the salt is ground into) should
     * replace it.
     */
    zoneCheck?: (address: string) => void;
}

export class StepError extends Error {
    constructor(
        message: string,
        readonly detail: { txHash?: string; address?: string } = {}
    ) {
        super(message);
        this.name = 'StepError';
    }
}

export function makeReader(rpc: Rpc): Reader {
    return {
        call: (to, data) => rpc('quai_call', [{ to: checksum(to), data }, 'latest']),
        getCode: address => rpc('quai_getCode', [checksum(address), 'latest']),
        getStorageAt: async (address, slot) => {
            try {
                return await rpc('quai_getStorageAt', [checksum(address), slot, 'latest']);
            } catch {
                return await rpc('eth_getStorageAt', [checksum(address), slot, 'latest']);
            }
        }
    };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);

export interface StepQuote {
    stepId: string;
    kind: 'create' | 'call';
    to?: string;
    /** What will be signed: for a creation this already carries the address-grinding salt. */
    data: string;
    nonce?: number;
    /** Creations only. A prediction: the receipt's address is the one that counts. */
    predictedAddress?: string;
    gasEstimate: bigint;
    gasLimit: bigint;
    gasPrice: bigint;
    /** gasLimit x gasPrice, in wei: the most this transaction can cost. */
    maxFee: bigint;
    accessList?: unknown[];
}

/** The gas price is a number the node reports; a bad answer must not become a zero-cost quote. */
async function gasPriceOf(rpc: Rpc): Promise<bigint> {
    const price = BigInt(await rpc('quai_gasPrice', []));
    if (price <= 0n) throw new Error('The node reported a zero gas price.');
    return price;
}

/**
 * Simulates one step against the live node and sizes its gas. Throws if the simulation reverts, so a doomed
 * transaction is never offered for signing. Needs every address the step depends on to be in `ctx` already.
 */
export async function quoteStep(env: RunnerEnv, step: DeployStep, ctx: FlowContext): Promise<StepQuote> {
    const args = step.args(ctx);
    if (args.some(a => a === undefined)) throw new StepError(`${step.label}: an earlier step has not produced the address this one needs yet.`);
    const from = checksum(env.from);

    if (step.kind === 'create') {
        const raw = creationData(step.contract, args);
        const nonce = Number(BigInt(await env.rpc('quai_getTransactionCount', [from, 'pending'])));
        const ground = grindCreationData(from, nonce, raw);
        let estimate: bigint;
        try {
            estimate = BigInt(await env.rpc('quai_estimateGas', [{ from, data: ground.data }]));
        } catch (e: any) {
            throw new StepError(`${step.label}: simulation failed, nothing was sent. ${e?.message ?? e}`);
        }
        const gasLimit = (estimate * BigInt(Math.round((env.creationGasMultiplier ?? 3) * 100))) / 100n;
        const gasPrice = await gasPriceOf(env.rpc);
        return {
            stepId: step.id,
            kind: 'create',
            data: ground.data,
            nonce,
            predictedAddress: ground.predictedAddress,
            gasEstimate: estimate,
            gasLimit,
            gasPrice,
            maxFee: gasLimit * gasPrice
        };
    }

    const to = checksum(ctx[step.targetKey!]);
    const data = interfaceOf(step.contract).encodeFunctionData(step.fn!, args);
    const base = { from, to, data };
    let estimate: bigint;
    try {
        estimate = BigInt(await env.rpc('quai_estimateGas', [base]));
    } catch (e: any) {
        throw new StepError(`${step.label}: simulation failed, nothing was sent. ${e?.message ?? e}`);
    }
    // Cyprus-1 needs the access list on any call that touches more than one contract; without it the call can
    // revert and burn its whole gas limit even though the simulation above succeeded.
    let accessList: unknown[] | undefined;
    try {
        accessList = (await env.rpc('quai_createAccessList', [base]))?.accessList;
    } catch (e: any) {
        throw new StepError(`${step.label}: could not build the access list, nothing was sent. ${e?.message ?? e}`);
    }
    const gasLimit = (estimate * BigInt(Math.round((env.callGasMultiplier ?? 1.5) * 100))) / 100n;
    const gasPrice = await gasPriceOf(env.rpc);
    return {
        stepId: step.id,
        kind: 'call',
        to,
        data,
        gasEstimate: estimate,
        gasLimit,
        gasPrice,
        maxFee: gasLimit * gasPrice,
        ...(accessList && accessList.length ? { accessList } : {})
    };
}

/**
 * Rough gas for a creation that cannot be simulated yet (its constructor needs an address an earlier step will
 * create), scaled from one that could: same per-byte cost, by creation-code size. Labelled a projection in the UI.
 */
export function projectCreationGas(quotedEstimate: bigint, quotedBytes: number, targetBytes: number): bigint {
    if (quotedBytes <= 0) return 0n;
    return (quotedEstimate * BigInt(targetBytes)) / BigInt(quotedBytes);
}

export function creationBytes(step: DeployStep): number {
    return (CIRCLESWAP_ARTIFACTS[step.contract].bytecode.length - 2) / 2;
}

export interface StepResult {
    txHash: string;
    blockNumber: number;
    gasUsed?: bigint;
    /** Creations: the address from the receipt. */
    address?: string;
}

async function waitForReceipt(env: RunnerEnv, txHash: string): Promise<any> {
    const deadline = Date.now() + (env.receiptTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
        let receipt: any = null;
        try {
            receipt = await env.rpc('quai_getTransactionReceipt', [txHash]);
        } catch {
            /* transient node error: keep polling */
        }
        if (receipt && receipt.blockNumber) return receipt;
        await sleep(env.pollMs ?? 1500);
    }
    throw new StepError(
        'The transaction has not been mined yet. It may still confirm: check it on the explorer, and use Resume rather than sending again.',
        { txHash }
    );
}

/** Waits for `confirmations` blocks on top of the receipt, then re-reads it to catch a reorg. */
async function confirmed(env: RunnerEnv, txHash: string, receipt: any): Promise<any> {
    const want = env.confirmations ?? 2;
    if (want <= 0) return receipt;
    const target = Number(BigInt(receipt.blockNumber)) + want;
    const deadline = Date.now() + (env.receiptTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
        let head = 0;
        try {
            head = Number(BigInt(await env.rpc('quai_blockNumber', [])));
        } catch {
            /* keep polling */
        }
        if (head >= target) break;
        await sleep(env.pollMs ?? 1500);
    }
    const again = await env.rpc('quai_getTransactionReceipt', [txHash]);
    if (!again || again.blockHash !== receipt.blockHash) {
        throw new StepError('The transaction moved or disappeared after it was first seen (a reorg). Nothing is trusted until it settles; use Resume.', { txHash });
    }
    return again;
}

function assertSuccess(receipt: any, txHash: string) {
    const ok = receipt.status === '0x1' || receipt.status === 1 || receipt.status === '1';
    if (!ok) {
        throw new StepError('The transaction reverted on chain. On Quai a revert uses up the whole gas limit, so that gas is spent.', { txHash });
    }
}

/**
 * Reads the outcome of an already-sent transaction: waits for it, checks it succeeded, takes the created address
 * off the receipt, and proves the contract is what was intended. Used both right after sending and to resume.
 */
export async function settleStep(env: RunnerEnv, step: DeployStep, ctx: FlowContext, txHash: string): Promise<StepResult> {
    const receipt = await confirmed(env, txHash, await waitForReceipt(env, txHash));
    assertSuccess(receipt, txHash);
    const result: StepResult = {
        txHash,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        ...(receipt.gasUsed ? { gasUsed: BigInt(receipt.gasUsed) } : {})
    };

    if (step.kind === 'create') {
        // The complete address from the receipt, or nothing: there is no fallback to an address computed from the
        // sender and nonce, because Quai grinds contract addresses and a computed one can be wrong.
        const raw = receipt.contractAddress;
        if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
            throw new StepError('The receipt has no valid contract address, so nothing was recorded.', { txHash });
        }
        const address = checksum(raw);
        try {
            (env.zoneCheck ?? assertCyprus1)(address);
        } catch (e: any) {
            throw new StepError(`${e.message} The gas is spent and the contract cannot be used.`, { txHash, address });
        }
        result.address = address;
        ctx[step.resultKey!] = address;
    }
    try {
        await step.verify(ctx, makeReader(env.rpc));
    } catch (e: any) {
        throw new StepError(`${e.message} Do not use this deployment.`, { txHash, address: result.address });
    }
    return result;
}

/** Quotes (if not already quoted), sends one step through the wallet, records it as pending, then settles it. */
export async function runStep(
    env: RunnerEnv,
    step: DeployStep,
    ctx: FlowContext,
    opts: { quote?: StepQuote; onSent?: (txHash: string) => void } = {}
): Promise<StepResult> {
    const quote = opts.quote ?? (await quoteStep(env, step, ctx));
    const from = checksum(env.from);

    const params: Record<string, unknown> = {
        from,
        data: quote.data,
        gas: hex(quote.gasLimit),
        value: '0x0',
        ...(quote.kind === 'call' ? { to: quote.to } : {}),
        // The address of a creation depends on the nonce it is sent with, so the wallet must use the one the
        // salt was ground for.
        ...(quote.nonce !== undefined ? { nonce: hex(quote.nonce) } : {}),
        ...(quote.accessList ? { accessList: quote.accessList } : {})
    };

    // Affordability: a limit the account cannot cover will be refused by the node after the user has signed.
    const balance = BigInt(await env.rpc('quai_getBalance', [from, 'latest']));
    if (balance < quote.maxFee) {
        throw new StepError(`${step.label}: the account holds ${balance} wei but the gas limit can cost up to ${quote.maxFee} wei.`);
    }

    let txHash: string;
    try {
        txHash = await sendViaWallet(env.wallet, params);
    } catch (e: any) {
        const rejected = e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message));
        throw new StepError(rejected ? 'Signing was cancelled in the wallet. Nothing was sent.' : `The wallet could not send the transaction: ${e?.message ?? e}`);
    }
    opts.onSent?.(txHash);
    return settleStep(env, step, ctx, txHash);
}

/** quai_sendTransaction, falling back to eth_sendTransaction only if the wallet does not know the former. */
async function sendViaWallet(wallet: WalletLike, params: Record<string, unknown>): Promise<string> {
    try {
        return await wallet.request({ method: 'quai_sendTransaction', params: [params] });
    } catch (err: any) {
        const missing = err?.code === -32601 || /Method not found|does not exist/i.test(String(err?.message));
        if (!missing) throw err;
        return wallet.request({ method: 'eth_sendTransaction', params: [params] });
    }
}

export type StepStatus = 'pending' | 'quoting' | 'awaiting-signature' | 'confirming' | 'done' | 'skipped' | 'failed';

export interface FlowHooks {
    onStatus?: (stepId: string, status: StepStatus, info?: { txHash?: string; address?: string; error?: string; quote?: StepQuote }) => void;
    /** Called before each signature with the quote; return false to stop (the user declined). */
    confirm?: (step: DeployStep, quote: StepQuote) => Promise<boolean>;
}

/**
 * Runs a flow to completion or to the first failure, persisting after every step. Steps already recorded as done
 * are re-verified against the chain (not trusted from storage) and skipped; a step recorded as sent but not done is
 * waited on rather than sent again.
 */
export async function runFlow(env: RunnerEnv, flow: Flow, progress: FlowProgress, hooks: FlowHooks = {}): Promise<FlowProgress> {
    const save = () => env.store && saveProgress(env.store, progress);
    const reader = makeReader(env.rpc);
    const ctx = progress.ctx;

    for (const step of flow.steps) {
        const saved = progress.steps[step.id] ?? { done: false };
        progress.steps[step.id] = saved;
        const status = (s: StepStatus, info?: Parameters<NonNullable<FlowHooks['onStatus']>>[2]) => hooks.onStatus?.(step.id, s, info);

        try {
            if (saved.done) {
                if (saved.address && step.resultKey) ctx[step.resultKey] = saved.address;
                await step.verify(ctx, reader); // storage is a hint, the chain is the authority
                status('done', { txHash: saved.txHash, address: saved.address });
                continue;
            }

            let result: StepResult;
            if (saved.txHash) {
                status('confirming', { txHash: saved.txHash });
                result = await settleStep(env, step, ctx, saved.txHash);
            } else {
                status('quoting');
                if (step.alreadyDone && (await step.alreadyDone(ctx, reader))) {
                    saved.done = true;
                    save();
                    status('skipped');
                    continue;
                }
                const quote = await quoteStep(env, step, ctx);
                status('awaiting-signature', { quote });
                if (hooks.confirm && !(await hooks.confirm(step, quote))) throw new StepError('Stopped before signing.');
                result = await runStep(env, step, ctx, {
                    quote,
                    onSent: txHash => {
                        saved.txHash = txHash; // written down before waiting: a reload resumes this, never resends
                        save();
                        status('confirming', { txHash });
                    }
                });
            }
            saved.done = true;
            saved.txHash = result.txHash;
            saved.blockNumber = result.blockNumber;
            if (result.gasUsed !== undefined) saved.gasUsed = result.gasUsed.toString();
            if (result.address) saved.address = result.address;
            save();
            status('done', { txHash: result.txHash, address: result.address });
        } catch (e: any) {
            status('failed', { error: e?.message ?? String(e), txHash: e?.detail?.txHash ?? saved.txHash, address: e?.detail?.address });
            save();
            throw e;
        }
    }
    return progress;
}

export { emptyProgress };
