// Reads a deployed Circleswap AMM and answers, from the chain alone, the question that matters about upgradable
// contracts: who can change what, how fast, and can they reach anyone's liquidity?
//
// Nothing is trusted from this app: addresses come in, every claim is read back (code size against the compiled
// contract, the EIP-1967 slots, owners, locks), and the verdict is derived from those reads.

import { checksum, interfaceOf } from './chain';
import type { CircleswapArtifactName } from '../generated/circleswapArtifacts';
import { matchCode, type CodeMatch, type CompiledName } from './code';
import { EIP1967_ADMIN_SLOT, EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT } from '../eip1967';
import type { Reader } from './flows';

export type Level = 'pass' | 'info' | 'warn' | 'fail';

export interface Check {
    id: string;
    level: Level;
    title: string;
    detail: string;
}

export type Verdict =
    /** Owner is a timelock (or nobody) and every pool is on a frozen beacon: no one can reach existing liquidity. */
    | 'IMMUTABLE_POOLS'
    /** Everything is behind a real timelock, but pool code can still be upgraded after the delay (not frozen yet). */
    | 'GOVERNED'
    /** Something lets a person upgrade code that holds or routes funds immediately, or the deployment is not what it claims. */
    | 'UNSAFE';

export type OwnerKind = 'timelock' | 'renounced' | 'contract' | 'account';

export interface IntegrityReport {
    verdict: Verdict;
    summary: string;
    checks: Check[];
    facts: {
        factoryImpl?: string;
        routerImpl?: string;
        owner?: string;
        ownerKind?: OwnerKind;
        timelockDelaySeconds?: number;
        /** The router's own owner: it can differ from the factory's (a router can be made permanent on its own). */
        routerOwner?: string;
        routerOwnerKind?: OwnerKind;
        routerTimelockDelaySeconds?: number;
        pairBeacon?: string;
        pairBeaconOwner?: string;
        pairImpl?: string;
        pools: { total: number; checked: number; frozen: number; governed: number; foreign: number };
    };
}

const ZERO = '0x0000000000000000000000000000000000000000';
const ONE = '0x0000000000000000000000000000000000000001';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const wordAddress = (hex: string) => checksum('0x' + hex.replace(/^0x/, '').padStart(64, '0').slice(-40));
const isEmptyWord = (hex: string | null | undefined) => !hex || !/[1-9a-f]/i.test(hex.replace(/^0x/, ''));

async function view(reader: Reader, name: CircleswapArtifactName, to: string, fn: string, args: unknown[] = []): Promise<any> {
    const iface = interfaceOf(name);
    const out = await reader.call(to, iface.encodeFunctionData(fn, args));
    const decoded = iface.decodeFunctionResult(fn, out);
    return decoded.length === 1 ? decoded[0] : decoded;
}

/** Why the code at `address` is not the compiled `name`, in words a reader can act on. */
function mismatch(address: string, name: string, m: CodeMatch): string {
    if (m.state === 'missing') return `${address} holds no code.`;
    if (m.state === 'wrong-size') return `${address} holds ${m.size} bytes; the compiled ${name} is ${m.wantSize}.`;
    return `${address} holds ${m.size} bytes, the same length as the compiled ${name}, but different code: it is an imitation, not the Circleswap contract.`;
}

async function reverts(reader: Reader, to: string, data: string): Promise<boolean> {
    try {
        await reader.call(to, data);
        return false;
    } catch {
        return true;
    }
}

export interface InspectOptions {
    /** How many of the factory's newest pools to examine. Default 200. */
    maxPools?: number;
}

/** Inspects the factory (and router, if given) at these proxy addresses. Never throws on a bad deployment: it reports it. */
export async function inspectAmm(reader: Reader, input: { factory: string; router?: string | null }, opts: InspectOptions = {}): Promise<IntegrityReport> {
    const checks: Check[] = [];
    const add = (id: string, level: Level, title: string, detail: string) => checks.push({ id, level, title, detail });
    const facts: IntegrityReport['facts'] = { pools: { total: 0, checked: 0, frozen: 0, governed: 0, foreign: 0 } };
    const guard = async <T>(id: string, title: string, fn: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await fn();
        } catch (e: any) {
            add(id, 'fail', title, `Could not be read: ${e?.message ?? e}`);
            return undefined;
        }
    };

    const factory = checksum(input.factory);
    const router = input.router ? checksum(input.router) : null;

    // --- a proxy of the right kind, pointing at the right code, locked, with no admin ------------------------------
    const inspectProxy = async (label: 'Factory' | 'Router', proxy: string, impl: CircleswapArtifactName) => {
        const key = label.toLowerCase();
        const proxyCode = await guard(`${key}.proxy`, `${label} proxy code`, () => matchCode(reader, 'ERC1967Proxy', proxy));
        if (proxyCode === undefined) return undefined;
        if (proxyCode.state !== 'ok') {
            add(`${key}.proxy`, 'fail', `${label} is not a Circleswap proxy`, mismatch(proxy, 'ERC1967Proxy', proxyCode));
            return undefined;
        }
        add(`${key}.proxy`, 'pass', `${label} is an ERC-1967 proxy`, `Runtime code is exactly the compiled proxy (${proxyCode.size} bytes, code hash checked).`);

        const slot = await guard(`${key}.impl`, `${label} implementation slot`, () => reader.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT));
        if (slot === undefined) return undefined;
        if (isEmptyWord(slot)) {
            add(`${key}.impl`, 'fail', `${label} has no implementation`, 'The EIP-1967 implementation slot is empty: the proxy delegates to nothing.');
            return undefined;
        }
        const implAddress = wordAddress(slot);
        const implCode = await matchCode(reader, impl as CompiledName, implAddress);
        if (implCode.state !== 'ok') {
            add(`${key}.impl`, 'fail', `${label} implementation is not the compiled one`, mismatch(implAddress, impl, implCode));
        } else {
            add(`${key}.impl`, 'pass', `${label} runs the compiled ${impl}`, `Implementation ${implAddress} is exactly the compiled code (${implCode.size} bytes, code hash checked).`);
        }

        const initData = impl === 'CircleswapFactory'
            ? interfaceOf(impl).encodeFunctionData('initialize', [ZERO === proxy ? ONE : proxy])
            : interfaceOf(impl).encodeFunctionData('initialize', [proxy, proxy, proxy]);
        if (await reverts(reader, implAddress, initData)) add(`${key}.impl.locked`, 'pass', `${label} implementation is locked`, 'Calling initialize on the bare implementation reverts, so nobody can take it over.');
        else add(`${key}.impl.locked`, 'fail', `${label} implementation can be initialised`, 'initialize() on the implementation did not revert: someone could take it over and self-destruct or misuse it.');

        const admin = await reader.getStorageAt(proxy, EIP1967_ADMIN_SLOT);
        if (isEmptyWord(admin)) add(`${key}.admin`, 'pass', `${label} has no proxy admin`, 'The EIP-1967 admin slot is empty, as it must be for a UUPS proxy: upgrade authority lives in the owner only.');
        else add(`${key}.admin`, 'fail', `${label} proxy has an admin`, `Admin slot holds ${admin}: a second upgrade authority exists beside the owner.`);
        return implAddress;
    };

    facts.factoryImpl = await inspectProxy('Factory', factory, 'CircleswapFactory');
    if (router) facts.routerImpl = await inspectProxy('Router', router, 'CircleswapRouter');

    // --- who owns it, and what stands between that owner and an upgrade -----------------------------------------
    // The factory and the router are judged separately: the router is the sensitive one (users approve tokens to it), and a
    // router owned by a person is unsafe however well the factory is governed.
    interface OwnerReading {
        owner: string;
        kind: OwnerKind;
        delaySeconds?: number;
        codeSize: number;
    }
    const readOwner = async (label: 'Factory' | 'Router', proxy: string, name: 'CircleswapFactory' | 'CircleswapRouter'): Promise<OwnerReading | undefined> => {
        const key = label.toLowerCase();
        const owner = await guard(`${key}.owner`, `${label} owner`, () => view(reader, name, proxy, 'owner') as Promise<string>);
        if (owner === undefined) return undefined;
        if (same(owner, ZERO)) return { owner, kind: 'renounced', codeSize: 0 };
        const code = await matchCode(reader, 'CircleswapTimelock', owner);
        if (code.state === 'ok') {
            const delay = await guard(`${key}.timelock.delay`, `${label} timelock delay`, () => view(reader, 'CircleswapTimelock', owner, 'getMinDelay') as Promise<bigint>);
            return { owner, kind: 'timelock', delaySeconds: delay === undefined ? undefined : Number(delay), codeSize: code.size };
        }
        return { owner, kind: code.size > 0 ? 'contract' : 'account', codeSize: code.size };
    };
    const delayText = (seconds: number) => (seconds >= 86_400 ? `${seconds / 86_400}-day` : `${seconds}-second`);

    const factoryOwner = await readOwner('Factory', factory, 'CircleswapFactory');
    if (factoryOwner) {
        facts.owner = factoryOwner.owner;
        facts.ownerKind = factoryOwner.kind;
        facts.timelockDelaySeconds = factoryOwner.delaySeconds;
        if (factoryOwner.kind === 'renounced') {
            add('owner.kind', 'pass', 'Factory ownership is renounced', 'There is no owner: the factory code can never change, and the owner-only settings are fixed.');
        } else if (factoryOwner.kind === 'timelock') {
            if (factoryOwner.delaySeconds !== undefined) {
                const long = factoryOwner.delaySeconds >= 86_400;
                add(
                    'owner.kind',
                    long ? 'pass' : 'fail',
                    `Factory owned by a timelock with a ${delayText(factoryOwner.delaySeconds)} delay`,
                    `Every upgrade or setting change is public for ${long ? `${factoryOwner.delaySeconds / 86_400} day(s)` : `${factoryOwner.delaySeconds} seconds`} before it can run, and can be cancelled in that time. Owner: ${factoryOwner.owner}.`
                );
            }
        } else if (factoryOwner.kind === 'contract') {
            add('owner.kind', 'warn', 'Factory owned by a contract that is not the Circleswap timelock', `${factoryOwner.owner} holds ${factoryOwner.codeSize} bytes of code that is not the compiled timelock. Check that it enforces a delay: if it does not, the factory code can change instantly.`);
        } else {
            add('owner.kind', 'fail', 'Factory owned by a single account', `${factoryOwner.owner} is an ordinary account: whoever holds its key can replace the factory code immediately, with no warning.`);
        }
    }

    if (router) {
        const routerOwner = await readOwner('Router', router, 'CircleswapRouter');
        if (routerOwner) {
            facts.routerOwner = routerOwner.owner;
            facts.routerOwnerKind = routerOwner.kind;
            facts.routerTimelockDelaySeconds = routerOwner.delaySeconds;
            if (routerOwner.kind === 'renounced') {
                add('router.owner.kind', 'pass', 'The router is permanent', 'Ownership is renounced: its code can never change, so nobody can swap it for something that spends the token approvals users have given it.');
            } else if (routerOwner.kind === 'timelock') {
                if (routerOwner.delaySeconds !== undefined) {
                    const long = routerOwner.delaySeconds >= 86_400;
                    const sameLock = factoryOwner !== undefined && same(factoryOwner.owner, routerOwner.owner);
                    add(
                        'router.owner.kind',
                        long ? 'pass' : 'fail',
                        `Router owned by a timelock with a ${delayText(routerOwner.delaySeconds)} delay`,
                        `A router upgrade is public for ${long ? `${routerOwner.delaySeconds / 86_400} day(s)` : `${routerOwner.delaySeconds} seconds`} before it can run, so anyone who approved tokens to it can revoke first.${sameLock ? '' : ` This is a different timelock from the factory's (${routerOwner.owner}): two authorities to watch.`}`
                    );
                }
            } else if (routerOwner.kind === 'contract') {
                add('router.owner.kind', 'warn', 'Router owned by a contract that is not the Circleswap timelock', `${routerOwner.owner} holds ${routerOwner.codeSize} bytes of code that is not the compiled timelock. Check that it enforces a delay: if it does not, the router can be replaced instantly.`);
            } else {
                add('router.owner.kind', 'fail', 'Router owned by a single account', `${routerOwner.owner} is an ordinary account: whoever holds its key can replace the router at once and spend every token approval users have given it.`);
            }
        }
    }

    // --- the pool beacon: the single place pool code can change ---------------------------------------------
    const beacon = factory && (await guard('beacon', 'Pool beacon', () => view(reader, 'CircleswapFactory', factory, 'pairBeacon') as Promise<string>));
    let beaconFrozen = false;
    if (beacon) {
        facts.pairBeacon = beacon;
        const beaconCode = await matchCode(reader, 'UpgradeableBeacon', beacon);
        if (beaconCode.state !== 'ok') {
            add('beacon.code', 'fail', 'The pool beacon is not the compiled UpgradeableBeacon', mismatch(beacon, 'UpgradeableBeacon', beaconCode));
        } else {
            add('beacon.code', 'pass', 'The pool beacon is the compiled UpgradeableBeacon', `${beacon}`);
            const bOwner = (await guard('beacon.owner', 'Pool beacon owner', () => view(reader, 'UpgradeableBeacon', beacon, 'owner') as Promise<string>)) ?? undefined;
            if (bOwner !== undefined) {
                facts.pairBeaconOwner = bOwner;
                if (same(bOwner, ZERO)) {
                    beaconFrozen = true;
                    add('beacon.owner', 'pass', 'Pool upgrades are frozen', 'The beacon has no owner. The code of every pool made from it is fixed forever: nobody, including the factory owner and any future factory upgrade, can change it.');
                } else if (same(bOwner, factory)) {
                    add('beacon.owner', facts.ownerKind === 'timelock' ? 'info' : 'fail', 'Pool code can still be upgraded, through the factory owner', facts.ownerKind === 'timelock' ? 'The beacon belongs to the factory, so a pool upgrade needs the timelock delay. Freeze it (a one-way, delayed operation) to make existing pools permanent.' : 'The beacon belongs to the factory, whose owner is not a timelock: pool code can be replaced instantly.');
                } else {
                    add('beacon.owner', 'fail', 'A third party can upgrade pool code', `The beacon is owned by ${bOwner}, which is neither nobody nor the factory: it can replace the code of every pool made from this beacon, and with it all their liquidity.`);
                }
            }
            const pairImpl = (await guard('beacon.impl', 'Pool implementation', () => view(reader, 'UpgradeableBeacon', beacon, 'implementation') as Promise<string>)) ?? undefined;
            if (pairImpl) {
                facts.pairImpl = pairImpl;
                const pairCode = await matchCode(reader, 'CircleswapPair', pairImpl);
                if (pairCode.state !== 'ok') add('pair.code', 'fail', 'The pool implementation is not the compiled CircleswapPair', `${mismatch(pairImpl, 'CircleswapPair', pairCode)} This is the code that holds the liquidity.`);
                else add('pair.code', 'pass', 'The pool implementation is the compiled CircleswapPair', `${pairImpl}: exactly the compiled code (${pairCode.size} bytes, code hash checked).`);
                if (pairCode.size > 0) {
                    const f = await view(reader, 'CircleswapPair', pairImpl, 'factory').catch(() => null);
                    if (f && same(f, ONE)) add('pair.locked', 'pass', 'The pool implementation is locked', 'Its own `factory` is 0x…01 and initialize reverts, so it cannot be used directly.');
                    else add('pair.locked', 'fail', 'The pool implementation is not locked', 'It can be initialised directly.');
                }
            }
        }
    }

    // --- every pool: which beacon it follows, and whether that beacon can still change -----------------------
    if (beacon) {
        const total = Number(await view(reader, 'CircleswapFactory', factory, 'allPairsLength').catch(() => 0n));
        const max = opts.maxPools ?? 200;
        facts.pools.total = total;
        const first = Math.max(0, total - max);
        const foreign = new Set<string>();
        for (let i = first; i < total; i++) {
            try {
                const pool: string = await view(reader, 'CircleswapFactory', factory, 'allPairs', [i]);
                const poolCode = await matchCode(reader, 'BeaconProxy', pool);
                const raw = await reader.getStorageAt(pool, EIP1967_BEACON_SLOT);
                facts.pools.checked++;
                if (poolCode.state !== 'ok') {
                    facts.pools.foreign++;
                    foreign.add(`${pool} (${poolCode.state === 'missing' ? 'no code' : 'code is not the compiled pool proxy'})`);
                    continue;
                }
                if (isEmptyWord(raw)) {
                    facts.pools.foreign++;
                    foreign.add(`${pool} (no beacon: not a Circleswap pool proxy)`);
                    continue;
                }
                const poolBeacon = wordAddress(raw);
                const owner = await view(reader, 'UpgradeableBeacon', poolBeacon, 'owner').catch(() => null);
                if (owner && same(owner, ZERO)) facts.pools.frozen++;
                else if (owner && (same(owner, factory) || same(poolBeacon, beacon))) facts.pools.governed++;
                else {
                    facts.pools.foreign++;
                    foreign.add(`${pool} (beacon ${poolBeacon} owned by ${owner ?? 'unknown'})`);
                }
            } catch (e: any) {
                facts.pools.foreign++;
                foreign.add(`pool #${i}: unreadable (${e?.message ?? e})`);
            }
        }
        const p = facts.pools;
        if (p.total === 0) add('pools', 'info', 'No pools yet', 'Nothing to inspect; every pool created later follows the factory\'s current beacon.');
        else {
            if (p.foreign > 0) add('pools.foreign', 'fail', `${p.foreign} pool(s) are not under the factory's governance`, [...foreign].slice(0, 5).join('; '));
            if (p.frozen > 0) add('pools.frozen', 'pass', `${p.frozen} pool(s) are permanently immutable`, 'Their beacon has no owner.');
            if (p.governed > 0) add('pools.governed', beaconFrozen ? 'info' : 'info', `${p.governed} pool(s) can be upgraded through the timelock`, 'Freeze the beacon to make them permanent.');
            if (p.total > p.checked) add('pools.partial', 'info', `Only the newest ${p.checked} of ${p.total} pools were examined`, 'Raise the limit to inspect more.');
        }
    }

    const failed = checks.some(c => c.level === 'fail');
    const delayedOrNobody = (k: OwnerKind | undefined) => k === 'timelock' || k === 'renounced';
    const timelocked = delayedOrNobody(facts.ownerKind) && (!router || delayedOrNobody(facts.routerOwnerKind));
    let verdict: Verdict;
    let summary: string;
    if (failed || !timelocked) {
        verdict = 'UNSAFE';
        summary = failed ? 'At least one check failed: do not trust this deployment until each failure is explained.' : 'An owner is not a timelock: code that holds or routes funds can change without warning.';
    } else if (beaconFrozen && facts.pools.foreign === 0) {
        verdict = 'IMMUTABLE_POOLS';
        summary = 'Existing pools can never change. Factory and router upgrades, if any are still possible, are public and delayed.';
    } else {
        verdict = 'GOVERNED';
        summary = 'Every upgrade is public and delayed. Pool code can still change after the delay until pool upgrades are frozen.';
    }
    return { verdict, summary, checks, facts };
}
