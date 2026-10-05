// Owner actions, done the only way the deployed system allows: scheduled on the timelock, visible to everyone for
// the whole delay, then executed (by anyone) or cancelled. This module builds those transactions and reads the
// queue back from the chain; the Governance modal signs them in the user's wallet.

import { AbiCoder, keccak256, ZeroHash } from 'quais';
import { checksum, interfaceOf, isCyprus1QuaiAddress } from './chain';
import type { Reader } from './flows';

export type OpRisk = 'routine' | 'sensitive' | 'irreversible';

export interface GovOp {
    id: string;
    label: string;
    description: string;
    risk: OpRisk;
    /** The contract the timelock will call. */
    target: string;
    /** The call it will make. */
    data: string;
}

export interface GovTargets {
    factory: string;
    router: string | null;
    timelock: string;
}

const need = (what: string, a: string) => {
    let sum: string;
    try {
        sum = checksum(a.trim());
    } catch {
        throw new Error(`${what} is not a valid address.`);
    }
    if (!isCyprus1QuaiAddress(sum)) throw new Error(`${what} is not a Cyprus-1 address.`);
    return sum;
};

/** Every kind of operation the owner can perform. Arguments are checked here so a typo cannot be scheduled. */
export const OPS = {
    setFeeTo(t: GovTargets, recipient: string | null): GovOp {
        const to = recipient ? need('Fee recipient', recipient) : '0x0000000000000000000000000000000000000000';
        return {
            id: 'setFeeTo',
            label: recipient ? `Turn the protocol fee on (LP shares to ${to})` : 'Turn the protocol fee off',
            description: 'One sixth of the 0.3% swap fee, minted as LP shares to the recipient (0.05% of volume). It dilutes LPs by that amount and nothing more.',
            risk: 'routine',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('setFeeTo', [to])
        };
    },
    upgradeFactory(t: GovTargets, newImpl: string): GovOp {
        return {
            id: 'upgradeFactory',
            label: `Upgrade the factory to ${need('New factory implementation', newImpl)}`,
            description: 'Replaces the factory code. The factory holds no funds, but the router trusts its list of pools: review the new code as carefully as a router upgrade.',
            risk: 'sensitive',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('upgradeToAndCall', [newImpl, '0x'])
        };
    },
    upgradeRouter(t: GovTargets, newImpl: string): GovOp {
        if (!t.router) throw new Error('No router is recorded.');
        return {
            id: 'upgradeRouter',
            label: `Upgrade the router to ${need('New router implementation', newImpl)}`,
            description: 'Replaces the router code. Users approve tokens to the router, so a bad router can spend those approvals: anyone who approved it should be able to read and judge the new code during the delay.',
            risk: 'sensitive',
            target: t.router,
            data: interfaceOf('CircleswapRouter').encodeFunctionData('upgradeToAndCall', [newImpl, '0x'])
        };
    },
    upgradePools(t: GovTargets, newImpl: string): GovOp {
        return {
            id: 'upgradePools',
            label: `Upgrade every pool to ${need('New pool implementation', newImpl)}`,
            description: 'Replaces the code of EVERY pool made from the current beacon, in one transaction, keeping balances. This is the one operation that can reach liquidity: liquidity providers should read the new code and leave during the delay if they do not trust it.',
            risk: 'sensitive',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('upgradePairImplementation', [newImpl])
        };
    },
    freezePools(t: GovTargets): GovOp {
        return {
            id: 'freezePools',
            label: 'Freeze pool upgrades forever',
            description: 'Renounces ownership of the pool beacon. The code of every existing pool can then never change again: no owner, no timelock and no future factory upgrade can reach existing liquidity. Irreversible.',
            risk: 'irreversible',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('freezePairUpgrades')
        };
    },
    newPoolVersion(t: GovTargets, beacon: string): GovOp {
        return {
            id: 'newPoolVersion',
            label: `New pools follow beacon ${need('New pool beacon', beacon)}`,
            description: 'Only pools created afterwards use the new version; existing pools are untouched. The beacon must be owned by the factory. Liquidity providers opt in by choosing a new pool.',
            risk: 'sensitive',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('setPairBeacon', [beacon])
        };
    },
    makeFactoryPermanent(t: GovTargets): GovOp {
        return {
            id: 'makeFactoryPermanent',
            label: 'Make the factory permanent (renounce ownership)',
            description: 'After this the factory code and the fee setting can never change. Irreversible. Freeze pool upgrades first if pools should be permanent too.',
            risk: 'irreversible',
            target: t.factory,
            data: interfaceOf('CircleswapFactory').encodeFunctionData('renounceOwnership')
        };
    },
    makeRouterPermanent(t: GovTargets): GovOp {
        if (!t.router) throw new Error('No router is recorded.');
        return {
            id: 'makeRouterPermanent',
            label: 'Make the router permanent (renounce ownership)',
            description: 'After this the router code can never change, so nobody can ever swap it for something that spends users\' approvals. Irreversible. A new router can still be deployed at a new address.',
            risk: 'irreversible',
            target: t.router,
            data: interfaceOf('CircleswapRouter').encodeFunctionData('renounceOwnership')
        };
    },
    updateDelay(t: GovTargets, seconds: number): GovOp {
        if (!Number.isInteger(seconds) || seconds < 86_400 || seconds > 30 * 86_400) throw new Error('The delay must be between 1 and 30 days.');
        return {
            id: 'updateDelay',
            label: `Change the timelock delay to ${seconds / 86_400} day(s)`,
            description: 'Applies to operations scheduled after this runs. A shorter delay gives users less time to react.',
            risk: 'sensitive',
            target: t.timelock,
            data: interfaceOf('CircleswapTimelock').encodeFunctionData('updateDelay', [seconds])
        };
    }
};

const randomSalt = (): string => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

/** The id the timelock gives an operation: keccak256(abi.encode(target, value, data, predecessor, salt)). */
export function operationId(target: string, data: string, salt: string, predecessor: string = ZeroHash, value: bigint = 0n): string {
    return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], [target, value, data, predecessor, salt]));
}

export interface Transaction {
    to: string;
    data: string;
}

/** The wallet transaction that queues `op`. Returns the salt too: it is needed (with the op) to execute later. */
export function scheduleTx(timelock: string, op: GovOp, delaySeconds: number, salt: string = randomSalt()): { tx: Transaction; salt: string; id: string } {
    return {
        tx: { to: timelock, data: interfaceOf('CircleswapTimelock').encodeFunctionData('schedule', [op.target, 0, op.data, ZeroHash, salt, delaySeconds]) },
        salt,
        id: operationId(op.target, op.data, salt)
    };
}

export const executeTx = (timelock: string, target: string, data: string, salt: string): Transaction => ({
    to: timelock,
    data: interfaceOf('CircleswapTimelock').encodeFunctionData('execute', [target, 0, data, ZeroHash, salt])
});

export const cancelTx = (timelock: string, id: string): Transaction => ({
    to: timelock,
    data: interfaceOf('CircleswapTimelock').encodeFunctionData('cancel', [id])
});

// ------------------------------------------------------------------------------------------------- the queue

export type OpState = 'WAITING' | 'READY' | 'DONE' | 'CANCELLED' | 'UNKNOWN';

export interface QueuedOp {
    id: string;
    target: string;
    data: string;
    salt?: string;
    /** Unix seconds at which it becomes executable. */
    readyAt: number;
    state: OpState;
    scheduledBlock: number;
    scheduleTx?: string;
}

export type BatchCall = { method: string; params: unknown[] };
export type BatchFn = (calls: BatchCall[]) => Promise<Array<{ ok: true; value: any } | { ok: false; error: string }>>;

const LOG_WINDOW = 9_999;

/**
 * Operations scheduled on the timelock in the last `lookbackBlocks` blocks, with their current state read from the
 * chain. The node allows 10,000 blocks per log query, so this is several queries.
 */
export async function listOperations(
    reader: Reader,
    batch: BatchFn,
    timelock: string,
    latestBlock: number,
    lookbackBlocks: number
): Promise<QueuedOp[]> {
    const iface = interfaceOf('CircleswapTimelock');
    const scheduled = iface.getEvent('CallScheduled')!.topicHash;
    const windows: { from: number; to: number }[] = [];
    for (let to = latestBlock; to > Math.max(0, latestBlock - lookbackBlocks); to -= LOG_WINDOW + 1) windows.push({ from: Math.max(0, to - LOG_WINDOW), to });
    const res = await batch(windows.map(w => ({ method: 'quai_getLogs', params: [{ address: timelock, fromBlock: '0x' + w.from.toString(16), toBlock: '0x' + w.to.toString(16), topics: [scheduled] }] })));

    const ops = new Map<string, QueuedOp>();
    for (const r of res) {
        if (!r.ok || !Array.isArray(r.value)) continue;
        for (const log of r.value) {
            try {
                const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                if (!parsed) continue;
                ops.set(parsed.args.id as string, {
                    id: parsed.args.id as string,
                    target: checksum(parsed.args.target as string),
                    data: parsed.args.data as string,
                    readyAt: 0,
                    state: 'UNKNOWN',
                    scheduledBlock: Number(BigInt(log.blockNumber)),
                    scheduleTx: log.transactionHash
                });
            } catch {
                /* a log that does not parse is not ours */
            }
        }
    }
    const list = [...ops.values()];

    // The salt is not in the event, only in the calldata of the transaction that scheduled the operation. When that
    // was a direct call to `schedule` it can be read back; when a multisig made the call it cannot, and the
    // operation can only be executed by whoever kept the salt.
    const withTx = list.filter(o => o.scheduleTx);
    const txs = await batch(withTx.map(o => ({ method: 'quai_getTransactionByHash', params: [o.scheduleTx] })));
    withTx.forEach((op, i) => {
        const r = txs[i];
        const input: string | undefined = r.ok ? r.value?.input ?? r.value?.data : undefined;
        if (!input) return;
        try {
            const parsed = iface.parseTransaction({ data: input });
            if (parsed?.name === 'schedule' && operationId(parsed.args.target, parsed.args.data, parsed.args.salt, parsed.args.predecessor, parsed.args.value) === op.id) {
                op.salt = parsed.args.salt as string;
            }
        } catch {
            /* scheduled through another contract: salt unknown */
        }
    });

    for (const op of list) {
        try {
            const state = Number(await reader.call(timelock, iface.encodeFunctionData('getOperationState', [op.id])).then(h => BigInt(h)));
            const ts = Number(await reader.call(timelock, iface.encodeFunctionData('getTimestamp', [op.id])).then(h => BigInt(h)));
            op.readyAt = ts > 1 ? ts : 0;
            // OpenZeppelin: 0 Unset, 1 Waiting, 2 Ready, 3 Done. Unset after a schedule log means it was cancelled.
            op.state = state === 1 ? 'WAITING' : state === 2 ? 'READY' : state === 3 ? 'DONE' : 'CANCELLED';
        } catch {
            op.state = 'UNKNOWN';
        }
    }
    return list.sort((a, b) => b.scheduledBlock - a.scheduledBlock);
}

/** A plain-language reading of a queued call, for the people who have to decide whether to stay. */
export function describeCall(target: string, data: string, known: GovTargets): string {
    const sel = data.slice(0, 10).toLowerCase();
    const tgt = target.toLowerCase();
    const factoryIface = interfaceOf('CircleswapFactory');
    const routerIface = interfaceOf('CircleswapRouter');
    const tryDecode = (iface: ReturnType<typeof interfaceOf>) => {
        try {
            return iface.parseTransaction({ data });
        } catch {
            return null;
        }
    };
    if (tgt === known.factory.toLowerCase()) {
        const p = tryDecode(factoryIface);
        if (p?.name === 'upgradePairImplementation') return `UPGRADE EVERY POOL to ${p.args[0]}`;
        if (p?.name === 'freezePairUpgrades') return 'FREEZE pool upgrades forever';
        if (p?.name === 'upgradeToAndCall') return `Upgrade the factory to ${p.args[0]}`;
        if (p?.name === 'setFeeTo') return `Set the protocol fee recipient to ${p.args[0]}`;
        if (p?.name === 'setPairBeacon') return `New pools will follow beacon ${p.args[0]}`;
        if (p?.name === 'renounceOwnership') return 'Make the factory permanent (renounce ownership)';
        if (p?.name === 'transferOwnership') return `Transfer factory ownership to ${p.args[0]}`;
    }
    if (known.router && tgt === known.router.toLowerCase()) {
        const p = tryDecode(routerIface);
        if (p?.name === 'upgradeToAndCall') return `Upgrade the router to ${p.args[0]}`;
        if (p?.name === 'renounceOwnership') return 'Make the router permanent (renounce ownership)';
        if (p?.name === 'transferOwnership') return `Transfer router ownership to ${p.args[0]}`;
    }
    if (tgt === known.timelock.toLowerCase()) return `Change the timelock itself (${sel})`;
    return `Call ${sel} on ${target}`;
}
