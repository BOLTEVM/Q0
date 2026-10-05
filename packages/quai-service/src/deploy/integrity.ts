// Reads a deployed Circleswap AMM and answers, from the chain alone, the question that matters about upgradable
// contracts: who can change what, how fast, and can they reach anyone's liquidity?
//
// Nothing is trusted from this app: addresses come in, every claim is read back (code size against the compiled
// contract, the EIP-1967 slots, owners, locks), and the verdict is derived from those reads.

import { checksum, interfaceOf } from './chain';
import { CIRCLESWAP_ARTIFACTS, type CircleswapArtifactName } from '../generated/circleswapArtifacts';
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

export interface IntegrityReport {
    verdict: Verdict;
    summary: string;
    checks: Check[];
    facts: {
        factoryImpl?: string;
        routerImpl?: string;
        owner?: string;
        ownerKind?: 'timelock' | 'renounced' | 'contract' | 'account';
        timelockDelaySeconds?: number;
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

async function codeSize(reader: Reader, address: string): Promise<number> {
    const code = await reader.getCode(address);
    return code && code !== '0x' ? (code.length - 2) / 2 : 0;
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
        const size = await guard(`${key}.proxy`, `${label} proxy code`, () => codeSize(reader, proxy));
        if (size === undefined) return undefined;
        if (size !== CIRCLESWAP_ARTIFACTS.ERC1967Proxy.runtimeBytes) {
            add(`${key}.proxy`, 'fail', `${label} is not a Circleswap proxy`, `${proxy} holds ${size} bytes of code; the compiled ERC1967Proxy is ${CIRCLESWAP_ARTIFACTS.ERC1967Proxy.runtimeBytes}.`);
            return undefined;
        }
        add(`${key}.proxy`, 'pass', `${label} is an ERC-1967 proxy`, `Runtime code matches the compiled proxy (${size} bytes).`);

        const slot = await guard(`${key}.impl`, `${label} implementation slot`, () => reader.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT));
        if (slot === undefined) return undefined;
        if (isEmptyWord(slot)) {
            add(`${key}.impl`, 'fail', `${label} has no implementation`, 'The EIP-1967 implementation slot is empty: the proxy delegates to nothing.');
            return undefined;
        }
        const implAddress = wordAddress(slot);
        const implSize = await codeSize(reader, implAddress);
        const want = CIRCLESWAP_ARTIFACTS[impl].runtimeBytes;
        if (implSize !== want) {
            add(`${key}.impl`, 'fail', `${label} implementation is not the compiled one`, `${implAddress} holds ${implSize} bytes; the compiled ${impl} is ${want}.`);
        } else {
            add(`${key}.impl`, 'pass', `${label} runs the compiled ${impl}`, `Implementation ${implAddress} matches the compiled code size.`);
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
    const owner = await guard('owner', 'Factory owner', () => view(reader, 'CircleswapFactory', factory, 'owner') as Promise<string>);
    if (owner !== undefined) {
        facts.owner = owner;
        if (router) {
            const routerOwner = await guard('router.owner', 'Router owner', () => view(reader, 'CircleswapRouter', router, 'owner') as Promise<string>);
            if (routerOwner !== undefined && !same(routerOwner, owner)) {
                add('router.owner', 'warn', 'Router and factory have different owners', `Factory ${owner}, router ${routerOwner}: two separate upgrade authorities to watch.`);
            }
        }
        if (same(owner, ZERO)) {
            facts.ownerKind = 'renounced';
            add('owner.kind', 'pass', 'Ownership is renounced', 'There is no owner: the factory and router code can never change, and the owner-only settings are fixed.');
        } else {
            const size = await codeSize(reader, owner);
            if (size === CIRCLESWAP_ARTIFACTS.CircleswapTimelock.runtimeBytes) {
                facts.ownerKind = 'timelock';
                const delay = await guard('timelock.delay', 'Timelock delay', () => view(reader, 'CircleswapTimelock', owner, 'getMinDelay') as Promise<bigint>);
                if (delay !== undefined) {
                    facts.timelockDelaySeconds = Number(delay);
                    const days = Number(delay) / 86_400;
                    add(
                        'owner.kind',
                        Number(delay) >= 86_400 ? 'pass' : 'fail',
                        `Owned by a timelock with a ${days >= 1 ? `${days}-day` : `${Number(delay)}-second`} delay`,
                        `Every upgrade or setting change is public for ${days >= 1 ? `${days} day(s)` : `${Number(delay)} seconds`} before it can run, and can be cancelled in that time. Owner: ${owner}.`
                    );
                }
            } else if (size > 0) {
                facts.ownerKind = 'contract';
                add('owner.kind', 'warn', 'Owned by a contract that is not the Circleswap timelock', `${owner} holds ${size} bytes of code. Check that it enforces a delay: if it does not, the code of the factory and router can change instantly.`);
            } else {
                facts.ownerKind = 'account';
                add('owner.kind', 'fail', 'Owned by a single account', `${owner} is an ordinary account: whoever holds its key can replace the factory and router code immediately, with no warning.`);
            }
        }
    }

    // --- the pool beacon: the single place pool code can change ---------------------------------------------
    const beacon = factory && (await guard('beacon', 'Pool beacon', () => view(reader, 'CircleswapFactory', factory, 'pairBeacon') as Promise<string>));
    let beaconFrozen = false;
    if (beacon) {
        facts.pairBeacon = beacon;
        const bsize = await codeSize(reader, beacon);
        if (bsize !== CIRCLESWAP_ARTIFACTS.UpgradeableBeacon.runtimeBytes) {
            add('beacon.code', 'fail', 'The pool beacon is not the compiled UpgradeableBeacon', `${beacon} holds ${bsize} bytes; expected ${CIRCLESWAP_ARTIFACTS.UpgradeableBeacon.runtimeBytes}.`);
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
                const psize = await codeSize(reader, pairImpl);
                const wantPair = CIRCLESWAP_ARTIFACTS.CircleswapPair.runtimeBytes;
                if (psize !== wantPair) add('pair.code', 'fail', 'The pool implementation is not the compiled CircleswapPair', `${pairImpl} holds ${psize} bytes; expected ${wantPair}. This is the code that holds the liquidity.`);
                else add('pair.code', 'pass', 'The pool implementation is the compiled CircleswapPair', pairImpl);
                if (psize > 0) {
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
                const raw = await reader.getStorageAt(pool, EIP1967_BEACON_SLOT);
                facts.pools.checked++;
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
    const timelocked = facts.ownerKind === 'timelock' || facts.ownerKind === 'renounced';
    let verdict: Verdict;
    let summary: string;
    if (failed || !timelocked) {
        verdict = 'UNSAFE';
        summary = failed ? 'At least one check failed: do not trust this deployment until each failure is explained.' : 'The owner is not a timelock: code that holds or routes funds can change without warning.';
    } else if (beaconFrozen && facts.pools.foreign === 0) {
        verdict = 'IMMUTABLE_POOLS';
        summary = 'Existing pools can never change. Factory and router upgrades, if any are still possible, are public and delayed.';
    } else {
        verdict = 'GOVERNED';
        summary = 'Every upgrade is public and delayed. Pool code can still change after the delay until pool upgrades are frozen.';
    }
    return { verdict, summary, checks, facts };
}
