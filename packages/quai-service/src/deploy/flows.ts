// The deployment flows as data: which transactions, in which order, with which arguments, and what to read back
// from the chain afterwards to prove each one did what was intended. Nothing here touches a wallet or the network
// except through the injected `Reader`, so the whole plan is testable and is the same plan for every front end.

import { ZeroAddress } from 'quais';
import { TOKEN_REGISTRY } from '../registries/tokens';
import { QRB_BOOST_BPS, QRB_BOOST_THRESHOLD_WEI, QRB_BOOST_MATURITY_SECONDS } from '../registries/qrb';
import { CIRCLESWAP_ARTIFACTS, type CircleswapArtifactName } from '../generated/circleswapArtifacts';
import { checksum, interfaceOf, isCyprus1QuaiAddress } from './chain';
import { EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT } from '../eip1967';

/** Read-only chain access. The browser supplies raw JSON-RPC; tests supply a fake. */
export interface Reader {
    call(to: string, data: string): Promise<string>;
    getCode(address: string): Promise<string>;
    getStorageAt(address: string, slot: string): Promise<string>;
}

/** Addresses produced so far in a flow, by key (e.g. QRB, QRB_NFT, AMM_FACTORY). */
export type FlowContext = Record<string, string>;

export interface DeployStep {
    id: string;
    label: string;
    kind: 'create' | 'call';
    contract: CircleswapArtifactName;
    /** create: constructor arguments. call: arguments of `fn`. */
    args: (ctx: FlowContext) => unknown[];
    /** call only */
    fn?: string;
    /** call only: the contract being called (a FlowContext key). */
    targetKey?: string;
    /** create only: where the new address is stored in the context. */
    resultKey?: string;
    /** Cost hint shown before anything is signed. */
    note?: string;
    /** Reads the chain and throws if the step did not leave things as intended. Runs after the step, every time. */
    verify: (ctx: FlowContext, reader: Reader) => Promise<void>;
    /** Returns true if the step's effect is already on chain (so a resumed run does not repeat it). */
    alreadyDone?: (ctx: FlowContext, reader: Reader) => Promise<boolean>;
}

export interface Flow {
    id: 'QRB' | 'AMM' | 'FARM';
    title: string;
    steps: DeployStep[];
}

// ---------------------------------------------------------------------------------------------------- validation

const ARWEAVE_URI = /^(ar:\/\/|https:\/\/arweave\.net\/)[A-Za-z0-9_-]{43}$/;
export const MAX_EMISSION_PER_SECOND = 10n ** 36n;
export const MAX_ALLOC_POINT = 10n ** 18n;
export const MAX_FARM_POOLS_HINT = 32;

/** Mirror of ArweaveURI.isValid in the contracts: the constructors refuse anything else, so refuse it early. */
export function isArweaveUri(uri: string): boolean {
    return ARWEAVE_URI.test(uri);
}

function requireAddress(what: string, value: string | null | undefined): string {
    if (!value) throw new Error(`${what} is required.`);
    let sum: string;
    try {
        sum = checksum(value.trim());
    } catch {
        throw new Error(`${what} is not a valid address.`);
    }
    if (!isCyprus1QuaiAddress(sum)) throw new Error(`${what} is not a Cyprus-1 Quai address (it must start with 0x00).`);
    return sum;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function read(reader: Reader, name: CircleswapArtifactName, address: string, fn: string, args: unknown[] = []): Promise<any> {
    const iface = interfaceOf(name);
    const out = await reader.call(address, iface.encodeFunctionData(fn, args));
    const decoded = iface.decodeFunctionResult(fn, out);
    return decoded.length === 1 ? decoded[0] : decoded;
}

function expectEqual(what: string, got: unknown, want: unknown) {
    const eq =
        typeof got === 'string' && typeof want === 'string' && got.startsWith('0x') && want.startsWith('0x') ? same(got, want) : got === want;
    if (!eq) throw new Error(`Post-deploy check failed: ${what} is ${String(got)}, expected ${String(want)}`);
}

/** The runtime code at `address` must be the size the compiler produced (immutables are zero-filled, same length). */
export async function verifyCodeSize(reader: Reader, name: CircleswapArtifactName, address: string): Promise<void> {
    const code = await reader.getCode(address);
    if (!code || code === '0x') throw new Error(`${name} at ${address} has no code on chain.`);
    const got = (code.length - 2) / 2;
    const want = CIRCLESWAP_ARTIFACTS[name].runtimeBytes;
    if (got !== want) throw new Error(`${name} at ${address} is ${got} bytes of code; the compiled contract is ${want}.`);
}


export async function verifyProxy(
    reader: Reader,
    implName: CircleswapArtifactName,
    proxyAddress: string,
    expectedImplAddress: string
): Promise<void> {
    await verifyCodeSize(reader, 'ERC1967Proxy', proxyAddress);
    const raw = await reader.getStorageAt(proxyAddress, EIP1967_IMPLEMENTATION_SLOT);
    if (!raw || raw === '0x' || raw === '0x' + '00'.repeat(32)) {
        throw new Error(`ERC1967Proxy at ${proxyAddress} has empty implementation slot.`);
    }
    const onChainImpl = checksum('0x' + raw.slice(-40));
    expectEqual('EIP-1967 Implementation Slot', onChainImpl, expectedImplAddress);
    await verifyCodeSize(reader, implName, expectedImplAddress);
    // UUPS keeps its upgrade authority in the implementation (the owner), not in a proxy admin: that slot must be empty.
    const admin = await reader.getStorageAt(proxyAddress, EIP1967_ADMIN_SLOT);
    if (admin && /[1-9a-f]/i.test(admin.replace(/^0x/, ''))) {
        throw new Error(`ERC1967Proxy at ${proxyAddress} has an admin set (${admin}); UUPS proxies must not.`);
    }
}

// --------------------------------------------------------------------------------------------------------- Qrb

export interface QrbFlowConfig {
    owner: string;
    /** Receives the 5% ERC-2981 royalty, fixed for the life of the NFT. */
    royaltyReceiver: string;
    artworkUri: string;
    /** Mint the 1.0 QRB genesis supply and the 1-of-1 NFT here after deploying. Omit to mint later. */
    mintTo?: string;
    /** Reuse an already-deployed Qrb (farm-only and NFT-only runs). */
    existingQrb?: string;
}

export function qrbFlow(input: QrbFlowConfig): Flow {
    const owner = requireAddress('Owner', input.owner);
    const royaltyReceiver = requireAddress('Royalty receiver', input.royaltyReceiver);
    const mintTo = input.mintTo ? requireAddress('Mint recipient', input.mintTo) : undefined;
    const uri = input.artworkUri.trim();
    if (!isArweaveUri(uri)) {
        throw new Error('Artwork must be an Arweave URI: ar://<43-character id> or https://arweave.net/<43-character id>.');
    }
    if (same(owner, ZeroAddress)) throw new Error('Owner cannot be the zero address.');

    const steps: DeployStep[] = [];
    if (!input.existingQrb) {
        steps.push({
            id: 'qrb',
            label: 'Deploy Qrb (ERC-20, 1.0 supply)',
            kind: 'create',
            contract: 'Qrb',
            resultKey: 'QRB',
            args: () => [owner, uri],
            verify: async (ctx, r) => {
                await verifyCodeSize(r, 'Qrb', ctx.QRB);
                expectEqual('Qrb.name', await read(r, 'Qrb', ctx.QRB, 'name'), 'Circleswap Qrb');
                expectEqual('Qrb.symbol', await read(r, 'Qrb', ctx.QRB, 'symbol'), 'QRB');
                expectEqual('Qrb.owner', await read(r, 'Qrb', ctx.QRB, 'owner'), owner);
                expectEqual('Qrb.artworkURI', await read(r, 'Qrb', ctx.QRB, 'artworkURI'), uri);
                expectEqual('Qrb.MAX_SUPPLY', await read(r, 'Qrb', ctx.QRB, 'MAX_SUPPLY'), 10n ** 18n);
                // The boost figures are defined once, in the contract; the app mirrors them. A mismatch means the app
                // would promise rewards the farm does not pay.
                expectEqual('Qrb.BOOST_BPS', await read(r, 'Qrb', ctx.QRB, 'BOOST_BPS'), BigInt(QRB_BOOST_BPS));
                expectEqual('Qrb.BOOST_THRESHOLD', await read(r, 'Qrb', ctx.QRB, 'BOOST_THRESHOLD'), QRB_BOOST_THRESHOLD_WEI);
                expectEqual('Qrb.BOOST_MATURITY', await read(r, 'Qrb', ctx.QRB, 'BOOST_MATURITY'), BigInt(QRB_BOOST_MATURITY_SECONDS));
            }
        });
    }
    steps.push({
        id: 'nft',
        label: 'Deploy QrbArtifactNFT (1-of-1, 5% royalty)',
        kind: 'create',
        contract: 'QrbArtifactNFT',
        resultKey: 'QRB_NFT',
        args: ctx => [owner, royaltyReceiver, uri, input.existingQrb ?? ctx.QRB],
        verify: async (ctx, r) => {
            const qrb = input.existingQrb ?? ctx.QRB;
            await verifyCodeSize(r, 'QrbArtifactNFT', ctx.QRB_NFT);
            expectEqual('NFT.qrb', await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'qrb'), qrb);
            expectEqual('NFT.owner', await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'owner'), owner);
            expectEqual('NFT.artworkURI', await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'artworkURI'), uri);
            const [receiver, amount] = await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'royaltyInfo', [1, 10_000n]);
            expectEqual('NFT.royaltyReceiver', receiver, royaltyReceiver);
            expectEqual('NFT.royalty(10000)', amount, 500n);
        }
    });

    if (mintTo && !input.existingQrb) {
        steps.push({
            id: 'mintGenesis',
            label: `Mint the 1.0 QRB to ${mintTo}`,
            kind: 'call',
            contract: 'Qrb',
            fn: 'mintGenesis',
            targetKey: 'QRB',
            args: () => [mintTo],
            note: 'Irreversible: Qrb can be minted exactly once.',
            alreadyDone: async (ctx, r) => Boolean(await read(r, 'Qrb', ctx.QRB, 'genesisMinted')),
            verify: async (ctx, r) => {
                expectEqual('Qrb.totalSupply', await read(r, 'Qrb', ctx.QRB, 'totalSupply'), 10n ** 18n);
                expectEqual('Qrb.balanceOf(recipient)', await read(r, 'Qrb', ctx.QRB, 'balanceOf', [mintTo]), 10n ** 18n);
            }
        });
    }
    if (mintTo) {
        steps.push({
            id: 'mintArtifact',
            label: `Mint the 1-of-1 NFT to ${mintTo}`,
            kind: 'call',
            contract: 'QrbArtifactNFT',
            fn: 'mintArtifact',
            targetKey: 'QRB_NFT',
            args: () => [mintTo],
            note: 'Irreversible: the artifact can be minted exactly once.',
            alreadyDone: async (ctx, r) => Boolean(await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'minted')),
            verify: async (ctx, r) => {
                expectEqual('NFT.ownerOf(1)', await read(r, 'QrbArtifactNFT', ctx.QRB_NFT, 'ownerOf', [1]), mintTo);
            }
        });
    }
    return { id: 'QRB', title: 'Qrb token and artifact NFT', steps };
}

// --------------------------------------------------------------------------------------------------------- AMM

export interface AmmFlowConfig {
    /**
     * Who may propose upgrades and other owner actions (a multisig in production). It holds the proposer and canceller
     * roles on the timelock and owns nothing else: the factory and router are owned by the timelock itself.
     */
    proposer: string;
    /** The timelock delay in seconds, between 1 and 30 days. Every owner action waits at least this long, in public. */
    delaySeconds: number;
    /** Wrapped native QUAI, used by the router for native-QUAI swaps and pools. */
    wquai: string;
    /** Let anyone run an operation once its delay has passed (recommended). If false only the proposer can. */
    openExecution?: boolean;
}

export const TIMELOCK_MIN_DELAY = 86_400;
export const TIMELOCK_MAX_DELAY = 30 * 86_400;
const ONE = '0x0000000000000000000000000000000000000001';

/** A call that must revert: used to prove an implementation is locked and cannot be initialised by anyone. */
async function expectReverts(reader: Reader, to: string, data: string, what: string): Promise<void> {
    try {
        await reader.call(to, data);
    } catch {
        return;
    }
    throw new Error(`Post-deploy check failed: ${what} did not revert, so it is not locked.`);
}

export function ammFlow(input: AmmFlowConfig): Flow {
    const proposer = requireAddress('Proposer', input.proposer);
    const wquai = requireAddress('WQUAI', input.wquai);
    const delay = Math.floor(input.delaySeconds);
    if (!Number.isFinite(delay) || delay < TIMELOCK_MIN_DELAY || delay > TIMELOCK_MAX_DELAY) {
        throw new Error('The timelock delay must be between 1 day and 30 days.');
    }
    const open = input.openExecution !== false;

    const steps: DeployStep[] = [
        {
            id: 'timelock',
            label: `Deploy the timelock (delay ${delay / 86_400} day${delay === 86_400 ? '' : 's'}; owner of everything below)`,
            kind: 'create',
            contract: 'CircleswapTimelock',
            resultKey: 'AMM_TIMELOCK',
            args: () => [delay, [proposer], [open ? ZeroAddress : proposer]],
            verify: async (ctx, r) => {
                const t = ctx.AMM_TIMELOCK;
                await verifyCodeSize(r, 'CircleswapTimelock', t);
                expectEqual('Timelock.getMinDelay', await read(r, 'CircleswapTimelock', t, 'getMinDelay'), BigInt(delay));
                const PROPOSER = await read(r, 'CircleswapTimelock', t, 'PROPOSER_ROLE');
                const CANCELLER = await read(r, 'CircleswapTimelock', t, 'CANCELLER_ROLE');
                const EXECUTOR = await read(r, 'CircleswapTimelock', t, 'EXECUTOR_ROLE');
                const ADMIN = await read(r, 'CircleswapTimelock', t, 'DEFAULT_ADMIN_ROLE');
                expectEqual('Timelock proposer', await read(r, 'CircleswapTimelock', t, 'hasRole', [PROPOSER, proposer]), true);
                expectEqual('Timelock canceller', await read(r, 'CircleswapTimelock', t, 'hasRole', [CANCELLER, proposer]), true);
                expectEqual('Timelock open execution', await read(r, 'CircleswapTimelock', t, 'hasRole', [EXECUTOR, ZeroAddress]), open);
                // Only the timelock itself administers its roles, so changing who may propose is itself delayed.
                expectEqual('Timelock admin is itself', await read(r, 'CircleswapTimelock', t, 'hasRole', [ADMIN, t]), true);
                expectEqual('Proposer is not the admin', await read(r, 'CircleswapTimelock', t, 'hasRole', [ADMIN, proposer]), false);
            }
        },
        {
            id: 'factoryImpl',
            label: 'Deploy the CircleswapFactory implementation (locked)',
            kind: 'create',
            contract: 'CircleswapFactory',
            resultKey: 'AMM_FACTORY_IMPL',
            args: () => [],
            verify: async (ctx, r) => {
                await verifyCodeSize(r, 'CircleswapFactory', ctx.AMM_FACTORY_IMPL);
                await expectReverts(r, ctx.AMM_FACTORY_IMPL, interfaceOf('CircleswapFactory').encodeFunctionData('initialize', [proposer]), 'Factory implementation initialize()');
            }
        },
        {
            id: 'factoryProxy',
            label: 'Deploy the factory proxy, initialised with the timelock as owner',
            kind: 'create',
            contract: 'ERC1967Proxy',
            resultKey: 'AMM_FACTORY',
            // Initialised in the same transaction as creation: there is no window in which anyone else could call initialize.
            args: ctx => [ctx.AMM_FACTORY_IMPL, interfaceOf('CircleswapFactory').encodeFunctionData('initialize', [ctx.AMM_TIMELOCK])],
            verify: async (ctx, r) => {
                const f = ctx.AMM_FACTORY;
                await verifyProxy(r, 'CircleswapFactory', f, ctx.AMM_FACTORY_IMPL);
                expectEqual('Factory.owner is the timelock', await read(r, 'CircleswapFactory', f, 'owner'), ctx.AMM_TIMELOCK);
                const beacon: string = await read(r, 'CircleswapFactory', f, 'pairBeacon');
                ctx.AMM_PAIR_BEACON = beacon;
                await verifyCodeSize(r, 'UpgradeableBeacon', beacon);
                // The pool beacon belongs to the factory, not to a person, and is not frozen yet.
                expectEqual('Pool beacon owner is the factory', await read(r, 'UpgradeableBeacon', beacon, 'owner'), f);
                const pairImpl: string = await read(r, 'UpgradeableBeacon', beacon, 'implementation');
                await verifyCodeSize(r, 'CircleswapPair', pairImpl);
                expectEqual('Pool implementation is locked (factory = 0x...01)', await read(r, 'CircleswapPair', pairImpl, 'factory'), ONE);
                expectEqual('Factory.pairUpgradesFrozen', await read(r, 'CircleswapFactory', f, 'pairUpgradesFrozen'), false);
            }
        },
        {
            id: 'routerImpl',
            label: 'Deploy the CircleswapRouter implementation (locked)',
            kind: 'create',
            contract: 'CircleswapRouter',
            resultKey: 'AMM_ROUTER_IMPL',
            args: () => [],
            verify: async (ctx, r) => {
                await verifyCodeSize(r, 'CircleswapRouter', ctx.AMM_ROUTER_IMPL);
                await expectReverts(r, ctx.AMM_ROUTER_IMPL, interfaceOf('CircleswapRouter').encodeFunctionData('initialize', [ctx.AMM_FACTORY, wquai, proposer]), 'Router implementation initialize()');
            }
        },
        {
            id: 'routerProxy',
            label: 'Deploy the router proxy, initialised with the timelock as owner',
            kind: 'create',
            contract: 'ERC1967Proxy',
            resultKey: 'AMM_ROUTER',
            args: ctx => [ctx.AMM_ROUTER_IMPL, interfaceOf('CircleswapRouter').encodeFunctionData('initialize', [ctx.AMM_FACTORY, wquai, ctx.AMM_TIMELOCK])],
            verify: async (ctx, r) => {
                await verifyProxy(r, 'CircleswapRouter', ctx.AMM_ROUTER, ctx.AMM_ROUTER_IMPL);
                expectEqual('Router.owner is the timelock', await read(r, 'CircleswapRouter', ctx.AMM_ROUTER, 'owner'), ctx.AMM_TIMELOCK);
                expectEqual('Router.factory', await read(r, 'CircleswapRouter', ctx.AMM_ROUTER, 'factory'), ctx.AMM_FACTORY);
                expectEqual('Router.WETH', await read(r, 'CircleswapRouter', ctx.AMM_ROUTER, 'WETH'), wquai);
            }
        }
    ];
    return { id: 'AMM', title: 'Circleswap AMM (timelock-governed factory and router)', steps };
}

// ------------------------------------------------------------------------------------------------------- Farm

export interface FarmPoolInput {
    /** The token staked in the pool: an LP token (a Circleswap pair address) or a single asset. */
    stakeToken: string;
    allocPoint: bigint;
}

export interface FarmFlowConfig {
    owner: string;
    /** Reward token A (BoltDelta) and B (Q0), in wei per second. */
    rewardAPerSecond: bigint;
    rewardBPerSecond: bigint;
    /** The Qrb that supplies the boost, or null for a farm with no boost (immutable either way). */
    qrb: string | null;
    rewardTokenA?: string;
    rewardTokenB?: string;
    pools: FarmPoolInput[];
    /** Reuse an already-deployed farm (add pools only). */
    existingFarm?: string;
}

export function farmFlow(input: FarmFlowConfig): Flow {
    const owner = requireAddress('Owner', input.owner);
    const rewardA = requireAddress('Reward token A', input.rewardTokenA ?? TOKEN_REGISTRY.BDELTA.address);
    const rewardB = requireAddress('Reward token B', input.rewardTokenB ?? TOKEN_REGISTRY.Q0.address);
    const qrb = input.qrb ? requireAddress('Qrb', input.qrb) : ZeroAddress;
    if (input.rewardAPerSecond > MAX_EMISSION_PER_SECOND || input.rewardBPerSecond > MAX_EMISSION_PER_SECOND) {
        throw new Error('An emission rate is above the contract maximum (1e36 wei per second): that is almost certainly a units mistake.');
    }
    if (input.rewardAPerSecond < 0n || input.rewardBPerSecond < 0n) throw new Error('Emission rates cannot be negative.');
    const pools = input.pools.map((p, i) => {
        if (p.allocPoint < 0n || p.allocPoint > MAX_ALLOC_POINT) throw new Error(`Pool ${i + 1}: allocation must be between 0 and 1e18.`);
        return { stakeToken: requireAddress(`Pool ${i + 1} stake token`, p.stakeToken), allocPoint: p.allocPoint };
    });
    const seen = new Set<string>();
    for (const p of pools) {
        if (seen.has(p.stakeToken.toLowerCase())) throw new Error(`Stake token ${p.stakeToken} is listed twice.`);
        seen.add(p.stakeToken.toLowerCase());
    }

    const steps: DeployStep[] = [];
    if (!input.existingFarm) {
        steps.push({
            id: 'farm',
            label: 'Deploy CircleswapMasterChef',
            kind: 'create',
            contract: 'CircleswapMasterChef',
            resultKey: 'MASTERCHEF',
            args: () => [owner, rewardA, rewardB, qrb, input.rewardAPerSecond, input.rewardBPerSecond],
            verify: async (ctx, r) => {
                await verifyCodeSize(r, 'CircleswapMasterChef', ctx.MASTERCHEF);
                const f = ctx.MASTERCHEF;
                expectEqual('Farm.owner', await read(r, 'CircleswapMasterChef', f, 'owner'), owner);
                expectEqual('Farm.qrb', await read(r, 'CircleswapMasterChef', f, 'qrb'), qrb);
                expectEqual('Farm.rewardTokenA', await read(r, 'CircleswapMasterChef', f, 'rewardTokenA'), rewardA);
                expectEqual('Farm.rewardTokenB', await read(r, 'CircleswapMasterChef', f, 'rewardTokenB'), rewardB);
                expectEqual('Farm.rewardAPerSecond', await read(r, 'CircleswapMasterChef', f, 'rewardAPerSecond'), input.rewardAPerSecond);
                expectEqual('Farm.rewardBPerSecond', await read(r, 'CircleswapMasterChef', f, 'rewardBPerSecond'), input.rewardBPerSecond);
            }
        });
    }
    const farmKey = input.existingFarm ? 'EXISTING_FARM' : 'MASTERCHEF';
    pools.forEach((p, i) => {
        steps.push({
            id: `pool${i}`,
            label: `Add farm pool ${i + 1}: ${p.stakeToken} (allocation ${p.allocPoint})`,
            kind: 'call',
            contract: 'CircleswapMasterChef',
            fn: 'addPool',
            targetKey: farmKey,
            args: () => [p.allocPoint, p.stakeToken],
            note: 'Only the owner can add pools, so the connected wallet must be the owner.',
            // A pool is identified by position, so a resumed run must not add it again: count what is on chain.
            alreadyDone: async (ctx, r) => {
                const length = Number(await read(r, 'CircleswapMasterChef', ctx[farmKey], 'poolLength'));
                if (length <= i) return false;
                const info = await read(r, 'CircleswapMasterChef', ctx[farmKey], 'poolInfo', [i]);
                expectEqual(`Farm.pool[${i}].lpToken (already added)`, info[0], p.stakeToken);
                expectEqual(`Farm.pool[${i}].allocPoint (already added)`, info[1], p.allocPoint);
                return true;
            },
            verify: async (ctx, r) => {
                const info = await read(r, 'CircleswapMasterChef', ctx[farmKey], 'poolInfo', [i]);
                expectEqual(`Farm.pool[${i}].lpToken`, info[0], p.stakeToken);
                expectEqual(`Farm.pool[${i}].allocPoint`, info[1], p.allocPoint);
            }
        });
    });
    return { id: 'FARM', title: 'Circleswap farm (MasterChef)', steps };
}
