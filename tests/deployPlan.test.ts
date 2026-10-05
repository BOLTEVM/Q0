import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { Interface, getCreateAddress, Wallet, id, ZeroAddress } from '../packages/quai-service/node_modules/quais';
import {
    CIRCLESWAP_ARTIFACTS,
    creationData,
    grindCreationData,
    isCyprus1QuaiAddress,
    checksum,
    qrbFlow,
    ammFlow,
    farmFlow,
    isArweaveUri,
    renderDeployedTs,
    runFlow,
    quoteStep,
    makeReader,
    emptyProgress,
    loadProgress,
    saveProgress,
    projectCreationGas,
    creationBytes,
    StepError,
    type KeyValueStore,
    type RunnerEnv,
    type Rpc,
    type Flow
} from '../packages/quai-service/src/deploy';
import { CIRCLESWAP_RUNTIME_BYTES } from '../packages/quai-service/src/generated/circleswapRuntimeSizes';
import { DEPLOYED } from '../packages/quai-service/src/registries/deployed';
import {
    applyVerifiedLocalDeployments,
    saveLocalDeployments,
    readLocalDeployments,
    LOCAL_DEPLOYMENTS_KEY,
    EIP1967_IMPLEMENTATION_SLOT
} from '../packages/quai-service/src/bootstrap';
import { renderDeployedTs as cliRenderDeployedTs } from '../packages/contracts/scripts/lib/record';
import { grindCreationData as cliGrind } from '../packages/contracts/scripts/lib/quaiClient';
import { loadArtifact } from '../packages/contracts/scripts/lib/artifacts';

const URI = 'ar://' + 'A'.repeat(43);
const ARTIFACTS_ROOT = path.resolve(__dirname, '../packages/contracts/artifacts/contracts');
const haveArtifacts = fs.existsSync(ARTIFACTS_ROOT);

// A funded Cyprus-1 account for the simulated chain. Grinding makes the creation addresses in-zone too.
function cyprus1Wallet(): string {
    for (let i = 1; i < 100000; i++) {
        const w = new Wallet('0x' + i.toString(16).padStart(64, '0'));
        if (isCyprus1QuaiAddress(w.address)) return w.address;
    }
    throw new Error('no Cyprus-1 test account found');
}
const OWNER = cyprus1Wallet();
const OTHER = checksum('0x0036c1A5e62597438cC204F8613c15211D4b7787');

describe('generated artifacts', () => {
    test.skipIf(!haveArtifacts)('match the Hardhat artifacts byte for byte (regenerate with export:artifacts if this fails)', () => {
        for (const name of Object.keys(CIRCLESWAP_ARTIFACTS) as (keyof typeof CIRCLESWAP_ARTIFACTS)[]) {
            const a = loadArtifact(name);
            expect(CIRCLESWAP_ARTIFACTS[name].bytecode).toBe(a.bytecode);
            expect(JSON.stringify(CIRCLESWAP_ARTIFACTS[name].abi)).toBe(JSON.stringify(a.abi));
            expect(CIRCLESWAP_ARTIFACTS[name].runtimeBytes).toBe((a.deployedBytecode.length - 2) / 2);
            expect(CIRCLESWAP_RUNTIME_BYTES[name]).toBe(CIRCLESWAP_ARTIFACTS[name].runtimeBytes);
        }
    });
});

describe('creation data and address grinding', () => {
    test('constructor arguments are appended to the creation bytecode', () => {
        const data = creationData('Qrb', [OWNER, URI]);
        expect(data.startsWith(CIRCLESWAP_ARTIFACTS.Qrb.bytecode)).toBe(true);
        expect(data.length).toBeGreaterThan(CIRCLESWAP_ARTIFACTS.Qrb.bytecode.length);
    });

    test('grinding finds an in-zone address and matches what the address derivation says', () => {
        const data = creationData('CircleswapFactory', []);
        const g = grindCreationData(OWNER, 7, data);
        expect(isCyprus1QuaiAddress(g.predictedAddress)).toBe(true);
        expect(getCreateAddress({ from: OWNER, nonce: 7, data: g.data })).toBe(g.predictedAddress);
        expect(g.data.startsWith(data)).toBe(true);
    });

    test.skipIf(!haveArtifacts)('is identical to the CLI deploy script (same salt, same address)', () => {
        const data = creationData('CircleswapFactory', []);
        for (const nonce of [0, 1, 42, 1000]) {
            const a = grindCreationData(OWNER, nonce, data);
            const b = cliGrind(OWNER, nonce, data);
            expect(a.data).toBe(b.data);
            expect(a.predictedAddress).toBe(b.predictedAddress);
        }
    }, 60_000);

    test('refuses when no salt lands in zone within the attempt budget', () => {
        expect(() => grindCreationData(OWNER, 0, '0x00', () => false, 50)).toThrow('Could not grind');
    });
});

describe('deployed.ts record', () => {
    const values = { QRB: OTHER, QRB_NFT: null, MASTERCHEF: null, AMM_FACTORY: null, AMM_ROUTER: null, ARTWORK_URI: URI };

    test.skipIf(!haveArtifacts)('is identical to the CLI script output', () => {
        expect(renderDeployedTs(values)).toBe(cliRenderDeployedTs(values));
    });

    test('matches the checked-in deployed.ts when nothing is deployed', () => {
        const none = { QRB: null, QRB_NFT: null, MASTERCHEF: null, AMM_FACTORY: null, AMM_ROUTER: null, ARTWORK_URI: null };
        const file = fs.readFileSync(path.resolve(__dirname, '../packages/quai-service/src/registries/deployed.ts'), 'utf8').replace(/\r\n/g, '\n');
        expect(renderDeployedTs(none)).toBe(file);
    });

    test('refuses anything that is not a plain address or Arweave URI', () => {
        expect(() => renderDeployedTs({ ...values, QRB: "0x1'; process.exit(1); //" })).toThrow('not a full 20-byte address');
        expect(() => renderDeployedTs({ ...values, ARTWORK_URI: 'https://evil.example/x' })).toThrow('not an Arweave URI');
    });
});

describe('flow validation', () => {
    const qrb = { owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI };
    test('Arweave URIs', () => {
        expect(isArweaveUri(URI)).toBe(true);
        expect(isArweaveUri('https://arweave.net/' + 'a-_'.repeat(14) + 'a')).toBe(true);
        expect(isArweaveUri('https://github.com/x/raw/art.gif')).toBe(false);
        expect(isArweaveUri('ar://short')).toBe(false);
        expect(isArweaveUri(URI + '"')).toBe(false);
    });
    test('addresses must be Cyprus-1', () => {
        expect(() => qrbFlow({ ...qrb, owner: '0x1111111111111111111111111111111111111111' })).toThrow('Cyprus-1');
        expect(() => qrbFlow({ ...qrb, owner: 'nonsense' })).toThrow('not a valid address');
        expect(() => qrbFlow({ ...qrb, artworkUri: 'https://x.test/a.png' })).toThrow('Arweave');
    });
    test('step lists', () => {
        expect(qrbFlow(qrb).steps.map(s => s.id)).toEqual(['qrb', 'nft']);
        expect(qrbFlow({ ...qrb, mintTo: OWNER }).steps.map(s => s.id)).toEqual(['qrb', 'nft', 'mintGenesis', 'mintArtifact']);
        expect(ammFlow({ proposer: OWNER, delaySeconds: 2 * 86_400, wquai: OTHER }).steps.map(s => s.id)).toEqual([
            'timelock',
            'factoryImpl',
            'factoryProxy',
            'routerImpl',
            'routerProxy'
        ]);
    });
    test('the AMM flow refuses an unsafe delay or a non-Cyprus-1 proposer before anything is sent', () => {
        const base = { proposer: OWNER, delaySeconds: 2 * 86_400, wquai: OTHER };
        expect(() => ammFlow({ ...base, delaySeconds: 86_399 })).toThrow('between 1 day and 30 days');
        expect(() => ammFlow({ ...base, delaySeconds: 31 * 86_400 })).toThrow('between 1 day and 30 days');
        expect(() => ammFlow({ ...base, proposer: '0x1111111111111111111111111111111111111111' })).toThrow('Cyprus-1');
    });
    test('farm limits', () => {
        const farm = { owner: OWNER, qrb: null, rewardAPerSecond: 1n, rewardBPerSecond: 1n, pools: [{ stakeToken: OTHER, allocPoint: 10n }] };
        expect(farmFlow(farm).steps.map(s => s.id)).toEqual(['farm', 'pool0']);
        expect(() => farmFlow({ ...farm, rewardAPerSecond: 10n ** 37n })).toThrow('units mistake');
        expect(() => farmFlow({ ...farm, pools: [{ stakeToken: OTHER, allocPoint: 10n ** 19n }] })).toThrow('allocation');
        expect(() => farmFlow({ ...farm, pools: [farm.pools[0], farm.pools[0]] })).toThrow('twice');
    });
    test('creation size projection scales by bytecode size', () => {
        expect(projectCreationGas(1000n, 100, 250)).toBe(2500n);
        const nftStep = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }).steps.find(s => s.contract === 'QrbArtifactNFT')!;
        expect(creationBytes(nftStep)).toBe((CIRCLESWAP_ARTIFACTS.QrbArtifactNFT.bytecode.length - 2) / 2);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// A small in-memory chain: enough of the node and a wallet to run a flow end to end.
// ---------------------------------------------------------------------------------------------------------------

type Handler = (args: any[]) => any;
interface FakeChain {
    rpc: Rpc;
    wallet: { request(a: { method: string; params?: unknown[] }): Promise<any> };
    sent: any[];
    nonce: number;
    block: number;
    contracts: Map<string, { name: keyof typeof CIRCLESWAP_ARTIFACTS; state: Record<string, any> }>;
    receipts: Map<string, any>;
    /** Hide receipts until released (simulates a slow or reorged chain). */
    holdReceipts: boolean;
    failNext: 'revert' | 'wrongZone' | 'noAddress' | null;
    rejectSigning: boolean;
    pendingMined: Map<string, () => void>;
}

function fakeChain(): FakeChain {
    const chain: FakeChain = {
        sent: [],
        nonce: 0,
        block: 100,
        contracts: new Map(),
        receipts: new Map(),
        holdReceipts: false,
        failNext: null,
        rejectSigning: false,
        pendingMined: new Map(),
        rpc: async () => null,
        wallet: { request: async () => null }
    };
    const ifaces: Record<string, Interface> = {};
    const iface = (n: string) => (ifaces[n] ??= new Interface((CIRCLESWAP_ARTIFACTS as any)[n].abi));

    const handlers: Record<string, Handler> = {
        quai_gasPrice: () => '0x3b9aca00',
        quai_getBalance: () => '0x' + (10n ** 24n).toString(16),
        quai_getTransactionCount: () => '0x' + chain.nonce.toString(16),
        quai_blockNumber: () => '0x' + chain.block.toString(16),
        quai_createAccessList: () => ({ accessList: [{ address: OTHER, storageKeys: [] }] }),
        quai_estimateGas: ([tx]) => {
            if (chain.failNext === 'revert') throw new Error('execution reverted');
            return '0x' + (tx.data.length * 50).toString(16);
        },
        quai_getTransactionReceipt: ([hash]) => (chain.holdReceipts ? null : chain.receipts.get(hash) ?? null),
        quai_getStorageAt: ([address, slot]) => {
            const c = chain.contracts.get(address.toLowerCase());
            if (!c) return '0x' + '00'.repeat(32);
            if (c.name === 'ERC1967Proxy' && slot.toLowerCase() === EIP1967_IMPLEMENTATION_SLOT.toLowerCase()) {
                const impl = c.state.implementation ?? '0x' + '0'.repeat(40);
                return '0x' + impl.toLowerCase().replace('0x', '').padStart(64, '0');
            }
            return '0x' + '00'.repeat(32);
        },
        quai_getCode: ([address]) => {
            const c = chain.contracts.get(address.toLowerCase());
            return c ? '0x' + '00'.repeat(CIRCLESWAP_ARTIFACTS[c.name].runtimeBytes) : '0x';
        },
        quai_call: ([tx]) => {
            let c = chain.contracts.get(tx.to.toLowerCase());
            if (!c) throw new Error('call to a non-contract');
            let contractName = c.name;
            if (c.name === 'ERC1967Proxy') {
                const implAddr = c.state.implementation;
                const implContract = chain.contracts.get(implAddr?.toLowerCase());
                if (implContract) {
                    contractName = implContract.name;
                }
            }
            const i = iface(contractName);
            const parsed = i.parseTransaction({ data: tx.data })!;
            if (c.name !== 'ERC1967Proxy' && (c.name === 'CircleswapFactory' || c.name === 'CircleswapRouter' || c.name === 'CircleswapPair') && parsed.name === 'initialize') {
                throw new Error('execution reverted: InvalidInitialization()');
            }
            const view = c.state[parsed.name];
            const value = typeof view === 'function' ? view(...parsed.args) : view;
            return i.encodeFunctionResult(parsed.name, i.getFunction(parsed.name)!.outputs.length > 1 ? value : [value]);
        }
    };
    chain.rpc = async (method, params) => {
        const h = handlers[method];
        if (!h) throw new Error(`fake chain: unhandled ${method}`);
        return h(params as any[]);
    };

    chain.wallet = {
        async request({ method, params }) {
            if (method !== 'quai_sendTransaction') throw Object.assign(new Error('Method not found'), { code: -32601 });
            if (chain.rejectSigning) throw Object.assign(new Error('User rejected the request'), { code: 4001 });
            const tx: any = (params as any[])[0];
            chain.sent.push(tx);
            const hash = '0x' + (chain.sent.length).toString(16).padStart(64, 'a');
            const nonce = Number(BigInt(tx.nonce ?? chain.nonce));
            chain.nonce = nonce + 1;
            chain.block += 1;
            const base = { transactionHash: hash, blockNumber: '0x' + chain.block.toString(16), blockHash: '0x' + chain.block.toString(16).padStart(64, 'b'), gasUsed: '0x5208', status: '0x1' };
            if (!tx.to) {
                // Contract creation: which contract is identified by its creation bytecode prefix.
                const name = (Object.keys(CIRCLESWAP_ARTIFACTS) as (keyof typeof CIRCLESWAP_ARTIFACTS)[]).find(n => tx.data.startsWith(CIRCLESWAP_ARTIFACTS[n].bytecode))!;
                const address = getCreateAddress({ from: tx.from, nonce, data: tx.data });
                const args = tx.data.slice(CIRCLESWAP_ARTIFACTS[name].bytecode.length);
                const decoded = iface(name).getAbiCoder().decode(iface(name).deploy.inputs, '0x' + args);
                const st = stateFor(name, [...decoded], chain, address);
                if (chain.failNext === 'revert') {
                    chain.receipts.set(hash, { ...base, status: '0x0' });
                } else if (chain.failNext === 'noAddress') {
                    chain.receipts.set(hash, { ...base });
                } else {
                    chain.contracts.set(address.toLowerCase(), { name, state: st });
                    chain.receipts.set(hash, { ...base, contractAddress: chain.failNext === 'wrongZone' ? '0x1111111111111111111111111111111111111111' : address.toLowerCase() });
                }
            } else {
                const c = chain.contracts.get(tx.to.toLowerCase())!;
                let contractName = c.name;
                if (c.name === 'ERC1967Proxy') {
                    const implAddr = c.state.implementation;
                    const implContract = chain.contracts.get(implAddr?.toLowerCase());
                    if (implContract) contractName = implContract.name;
                }
                const parsed = iface(contractName).parseTransaction({ data: tx.data })!;
                applyCall(c, parsed.name, [...parsed.args], chain);
                chain.receipts.set(hash, { ...base });
            }
            chain.failNext = null;
            return hash;
        }
    };
    return chain;
}

function stateFor(name: string, args: any[], chain: FakeChain, contractAddress?: string): Record<string, any> {
    const addr = (x: string) => x;
    switch (name) {
        case 'Qrb':
            return { name: 'Circleswap Qrb', symbol: 'QRB', owner: addr(args[0]), artworkURI: args[1], MAX_SUPPLY: 10n ** 18n, BOOST_BPS: 5000n, BOOST_THRESHOLD: 10n ** 14n, BOOST_MATURITY: 86400n, genesisMinted: false, totalSupply: 0n, balanceOf: () => 0n };
        case 'QrbArtifactNFT':
            return { owner: args[0], qrb: args[3], artworkURI: args[2], royaltyInfo: () => [args[1], 500n], minted: false, ownerOf: () => '0x' + '0'.repeat(40) };
        case 'CircleswapTimelock': {
            const delay = BigInt(args[0]);
            const proposers = ((args[1] as string[]) || []).map((x: string) => x.toLowerCase());
            const executors = ((args[2] as string[]) || []).map((x: string) => x.toLowerCase());
            const PROPOSER = id('PROPOSER_ROLE');
            const CANCELLER = id('CANCELLER_ROLE');
            const EXECUTOR = id('EXECUTOR_ROLE');
            const ADMIN = '0x' + '00'.repeat(32);
            return {
                getMinDelay: () => delay,
                PROPOSER_ROLE: PROPOSER,
                CANCELLER_ROLE: CANCELLER,
                EXECUTOR_ROLE: EXECUTOR,
                DEFAULT_ADMIN_ROLE: ADMIN,
                hasRole: (role: string, account: string) => {
                    const r = role.toLowerCase();
                    const a = account.toLowerCase();
                    if (r === ADMIN.toLowerCase()) return a === (contractAddress ?? '').toLowerCase();
                    if (r === PROPOSER.toLowerCase() || r === CANCELLER.toLowerCase()) return proposers.includes(a);
                    if (r === EXECUTOR.toLowerCase()) return executors.includes(a) || executors.includes(ZeroAddress.toLowerCase());
                    return false;
                }
            };
        }
        case 'CircleswapFactory':
            return { owner: OWNER, pairBeacon: '0x' + '0'.repeat(40), feeTo: '0x' + '0'.repeat(40) };
        case 'CircleswapRouter':
            return { factory: '0x' + '0'.repeat(40), WETH: '0x' + '0'.repeat(40), owner: OWNER };
        case 'CircleswapPair':
            return { factory: '0x0000000000000000000000000000000000000001' };
        case 'UpgradeableBeacon':
            return { implementation: () => args[0], owner: () => args[1] };
        case 'ERC1967Proxy': {
            const implAddr = args[0] as string;
            const initData = args[1] as string;
            const impl = chain.contracts.get(implAddr.toLowerCase());
            const st: Record<string, any> = { implementation: implAddr };
            if (impl && initData && initData !== '0x') {
                const i = iface(impl.name);
                const parsed = i.parseTransaction({ data: initData });
                if (parsed) {
                    if (impl.name === 'CircleswapFactory' && parsed.name === 'initialize') {
                        st.owner = parsed.args[0];
                        const beaconAddr = '0x0011111111111111111111111111111111111111';
                        const pairImplAddr = '0x0022222222222222222222222222222222222222';
                        st.pairBeacon = beaconAddr;
                        st.feeTo = '0x' + '0'.repeat(40);
                        st.pairUpgradesFrozen = false;
                        chain.contracts.set(pairImplAddr.toLowerCase(), {
                            name: 'CircleswapPair',
                            state: { factory: '0x0000000000000000000000000000000000000001' }
                        });
                        chain.contracts.set(beaconAddr.toLowerCase(), {
                            name: 'UpgradeableBeacon',
                            state: {
                                owner: () => contractAddress ?? '0x' + '0'.repeat(40),
                                implementation: () => pairImplAddr
                            }
                        });
                    } else if (impl.name === 'CircleswapRouter' && parsed.name === 'initialize') {
                        st.factory = parsed.args[0];
                        st.WETH = parsed.args[1];
                        st.owner = parsed.args[2];
                    }
                }
            }
            return st;
        }
        case 'CircleswapMasterChef':
            return { owner: args[0], rewardTokenA: args[1], rewardTokenB: args[2], qrb: args[3], rewardAPerSecond: args[4], rewardBPerSecond: args[5], pools: [], poolLength: () => 0n, poolInfo: () => ['', 0n, 0n, 0n, 0n, 0n] };
    }
    return {};
}

function applyCall(c: { name: string; state: Record<string, any> }, fn: string, args: any[], _chain: FakeChain) {
    if (c.name === 'Qrb' && fn === 'mintGenesis') {
        c.state.genesisMinted = true;
        c.state.totalSupply = 10n ** 18n;
        c.state.balanceOf = () => 10n ** 18n;
    } else if (c.name === 'QrbArtifactNFT' && fn === 'mintArtifact') {
        c.state.minted = true;
        c.state.ownerOf = () => args[0];
    } else if (fn === 'setFeeTo') {
        c.state.feeTo = args[0];
    } else if (fn === 'setPairBeacon') {
        c.state.pairBeacon = args[0];
    } else if (c.name === 'CircleswapMasterChef' && fn === 'addPool') {
        c.state.pools.push([args[1], args[0]]);
        c.state.poolLength = () => BigInt(c.state.pools.length);
        c.state.poolInfo = (i: bigint) => [c.state.pools[Number(i)][0], c.state.pools[Number(i)][1], 0n, 0n, 0n, 0n];
    }
}

function env(chain: FakeChain, extra: Partial<RunnerEnv> = {}, store?: KeyValueStore): RunnerEnv {
    return { rpc: chain.rpc, wallet: chain.wallet, from: OWNER, chainId: 9, confirmations: 0, pollMs: 1, receiptTimeoutMs: 400, store, ...extra };
}

const memStore = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) };
};

describe('runFlow on a simulated chain', () => {
    test('the Qrb flow deploys in order, takes addresses from receipts, verifies, and records progress', async () => {
        const chain = fakeChain();
        const store = memStore();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI });
        const progress = emptyProgress('QRB', 9, OWNER);
        const events: string[] = [];
        await runFlow(env(chain, {}, store), flow, progress, { onStatus: (id, s) => events.push(`${id}:${s}`) });

        expect(chain.sent).toHaveLength(2);
        expect(chain.sent[0].to).toBeUndefined(); // a creation
        expect(isCyprus1QuaiAddress(progress.ctx.QRB)).toBe(true);
        expect(isCyprus1QuaiAddress(progress.ctx.QRB_NFT)).toBe(true);
        expect(progress.steps.qrb.done && progress.steps.nft.done).toBe(true);
        expect(events).toContain('qrb:awaiting-signature');
        expect(events.at(-1)).toBe('nft:done');
        // Persisted, and loadable for a resume.
        expect(loadProgress(store, 'QRB', 9, OWNER)?.ctx.QRB_NFT).toBe(progress.ctx.QRB_NFT);
    });

    test('the transaction carries the nonce the salt was ground for, and the salt is in the data', async () => {
        const chain = fakeChain();
        chain.nonce = 5;
        const progress = emptyProgress('QRB', 9, OWNER);
        await runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), progress);
        expect(Number(BigInt(chain.sent[0].nonce))).toBe(5);
        expect(getCreateAddress({ from: OWNER, nonce: 5, data: chain.sent[0].data })).toBe(progress.ctx.QRB);
    });

    test('calls attach the access list and a modest gas limit; creations a wide one', async () => {
        const chain = fakeChain();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI, mintTo: OWNER });
        await runFlow(env(chain), flow, emptyProgress('QRB', 9, OWNER));
        const [qrbTx, nftTx, mintTx] = chain.sent;
        expect(qrbTx.accessList).toBeUndefined();
        expect(mintTx.accessList?.length).toBeGreaterThan(0);
        const est = (t: any) => BigInt(t.data.length * 50);
        expect(BigInt(qrbTx.gas)).toBe((est(qrbTx) * 300n) / 100n);
        expect(BigInt(mintTx.gas)).toBe((est(mintTx) * 150n) / 100n);
        expect(nftTx.to).toBeUndefined();
    });

    test('a full Qrb flow mints exactly once and a second run repeats nothing', async () => {
        const chain = fakeChain();
        const store = memStore();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI, mintTo: OWNER });
        const progress = emptyProgress('QRB', 9, OWNER);
        await runFlow(env(chain, {}, store), flow, progress);
        expect(chain.sent).toHaveLength(4);

        // Re-running with the saved progress re-verifies on chain and sends nothing.
        const again = loadProgress(store, 'QRB', 9, OWNER)!;
        await runFlow(env(chain, {}, store), flow, again);
        expect(chain.sent).toHaveLength(4);
    });

    test('an "already minted" state on chain is detected even with no saved progress', async () => {
        const chain = fakeChain();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI, mintTo: OWNER });
        const p1 = emptyProgress('QRB', 9, OWNER);
        await runFlow(env(chain), flow, p1);
        const p2 = emptyProgress('QRB', 9, OWNER, p1.ctx); // lost storage, but the addresses are known
        p2.steps.qrb = { done: true, address: p1.ctx.QRB };
        p2.steps.nft = { done: true, address: p1.ctx.QRB_NFT };
        const before = chain.sent.length;
        await runFlow(env(chain), flow, p2);
        expect(chain.sent.length).toBe(before);
        expect(p2.steps.mintGenesis.done).toBe(true);
    });

    test('farm flow adds pools in order and does not add one twice on resume', async () => {
        const chain = fakeChain();
        const pools = [
            { stakeToken: OTHER, allocPoint: 10n },
            { stakeToken: checksum('0x003B4b96bF0793EB1D53B79f8c38746A298eEef8'), allocPoint: 20n }
        ];
        const flow = farmFlow({ owner: OWNER, qrb: null, rewardAPerSecond: 5n, rewardBPerSecond: 7n, pools });
        const progress = emptyProgress('FARM', 9, OWNER);
        await runFlow(env(chain), flow, progress);
        expect(chain.sent).toHaveLength(3);

        const fresh = emptyProgress('FARM', 9, OWNER, progress.ctx);
        fresh.steps.farm = { done: true, address: progress.ctx.MASTERCHEF };
        await runFlow(env(chain), flow, fresh); // pools exist on chain: skipped, not repeated
        expect(chain.sent).toHaveLength(3);
        expect(fresh.steps.pool0.done && fresh.steps.pool1.done).toBe(true);
    });

    test('the AMM flow deploys timelock, factory proxy, and router proxy in order and verifies on the simulated chain', async () => {
        const chain = fakeChain();
        const flow = ammFlow({ proposer: OWNER, delaySeconds: 2 * 86_400, wquai: OTHER });
        const progress = emptyProgress('AMM', 9, OWNER);
        await runFlow(env(chain), flow, progress);
        expect(progress.steps.every(s => s.status === 'done')).toBe(true);
        expect(chain.sent).toHaveLength(5);
        expect(progress.ctx.AMM_TIMELOCK).toBeDefined();
        expect(progress.ctx.AMM_FACTORY_IMPL).toBeDefined();
        expect(progress.ctx.AMM_FACTORY).toBeDefined();
        expect(progress.ctx.AMM_ROUTER_IMPL).toBeDefined();
        expect(progress.ctx.AMM_ROUTER).toBeDefined();
        expect(progress.ctx.AMM_PAIR_BEACON).toBe('0x0011111111111111111111111111111111111111');
    });

    test('a failing simulation sends nothing', async () => {
        const chain = fakeChain();
        chain.failNext = 'revert';
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI });
        await expect(runFlow(env(chain), flow, emptyProgress('QRB', 9, OWNER))).rejects.toThrow('simulation failed, nothing was sent');
        expect(chain.sent).toHaveLength(0);
    });

    test('cancelling in the wallet stops cleanly with nothing recorded as sent', async () => {
        const chain = fakeChain();
        chain.rejectSigning = true;
        const progress = emptyProgress('QRB', 9, OWNER);
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), progress)).rejects.toThrow('cancelled');
        expect(progress.steps.qrb.txHash).toBeUndefined();
    });

    test('declining the confirmation stops before signing', async () => {
        const chain = fakeChain();
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), emptyProgress('QRB', 9, OWNER), { confirm: async () => false })).rejects.toThrow('Stopped before signing');
        expect(chain.sent).toHaveLength(0);
    });

    test('a reverted creation is reported as spent gas and the flow stops', async () => {
        const chain = fakeChain();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI });
        const progress = emptyProgress('QRB', 9, OWNER);
        // Simulation passes, the transaction reverts on chain.
        const real = chain.rpc;
        chain.rpc = async (m, p) => real(m, p);
        chain.failNext = null;
        const origRequest = chain.wallet.request;
        chain.wallet.request = async a => {
            const h = await origRequest(a);
            chain.receipts.set(h, { ...chain.receipts.get(h), status: '0x0' });
            return h;
        };
        await expect(runFlow(env(chain), flow, progress)).rejects.toThrow('reverted on chain');
        expect(chain.sent).toHaveLength(1);
        expect(progress.steps.qrb.done).toBe(false);
    });

    test('a receipt without a contract address is refused (no fallback to a computed address)', async () => {
        const chain = fakeChain();
        chain.failNext = 'noAddress';
        const progress = emptyProgress('QRB', 9, OWNER);
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), progress)).rejects.toThrow('no valid contract address');
        expect(progress.ctx.QRB_IMPL).toBeUndefined();
    });

    test('a contract outside Cyprus-1 is refused', async () => {
        const chain = fakeChain();
        chain.failNext = 'wrongZone';
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), emptyProgress('QRB', 9, OWNER))).rejects.toThrow('Cyprus-1');
    });

    test('code of the wrong size is refused', async () => {
        const chain = fakeChain();
        const realRpc = chain.rpc;
        chain.rpc = async (m, p) => (m === 'quai_getCode' ? '0x' + '00'.repeat(10) : realRpc(m, p));
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), emptyProgress('QRB', 9, OWNER))).rejects.toThrow('the compiled contract is');
    });

    test('a sent transaction that has not confirmed is resumed, never sent again', async () => {
        const chain = fakeChain();
        const store = memStore();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI });
        const progress = emptyProgress('QRB', 9, OWNER);
        chain.holdReceipts = true; // the node has not mined it yet: the run gives up waiting
        await expect(runFlow(env(chain, { receiptTimeoutMs: 40 }, store), flow, progress)).rejects.toBeInstanceOf(StepError);
        expect(chain.sent).toHaveLength(1);
        const saved = loadProgress(store, 'QRB', 9, OWNER)!;
        expect(saved.steps.qrb.txHash).toBeDefined();
        expect(saved.steps.qrb.done).toBe(false);

        chain.holdReceipts = false; // it confirms later; resuming waits on the same hash
        await runFlow(env(chain, {}, store), flow, saved);
        expect(chain.sent).toHaveLength(2); // the Qrb (sent once, then waited on) + the NFT
        expect(saved.steps.qrb.done).toBe(true);
        expect(saved.steps.nft.done).toBe(true);
    });

    test('quoting needs earlier addresses: the NFT cannot be priced before the Qrb it points at exists', async () => {
        const chain = fakeChain();
        const flow = qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI });
        await expect(quoteStep(env(chain), flow.steps[1], {})).rejects.toThrow('has not produced the address');
    });

    test('a zero gas price is refused rather than quoted as free', async () => {
        const chain = fakeChain();
        const realRpc = chain.rpc;
        chain.rpc = async (m, p) => (m === 'quai_gasPrice' ? '0x0' : realRpc(m, p));
        await expect(quoteStep(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }).steps[0], {})).rejects.toThrow('zero gas price');
    });

    test('an underfunded account is refused before signing', async () => {
        const chain = fakeChain();
        const realRpc = chain.rpc;
        chain.rpc = async (m, p) => (m === 'quai_getBalance' ? '0x1' : realRpc(m, p));
        await expect(runFlow(env(chain), qrbFlow({ owner: OWNER, royaltyReceiver: OWNER, artworkUri: URI }), emptyProgress('QRB', 9, OWNER))).rejects.toThrow('can cost up to');
        expect(chain.sent).toHaveLength(0);
    });

    test('progress storage failures never block a deployment', () => {
        const broken: KeyValueStore = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('quota');
            },
            removeItem: () => {
                throw new Error('blocked');
            }
        };
        expect(loadProgress(broken, 'AMM', 9, OWNER)).toBeNull();
        expect(() => saveProgress(broken, emptyProgress('QRB', 9, OWNER))).not.toThrow();
    });

    test('the reader wraps calls with checksummed addresses', async () => {
        const chain = fakeChain();
        const seen: any[] = [];
        const reader = makeReader(async (m, p) => {
            seen.push([m, p]);
            return '0x';
        });
        await reader.getCode(OWNER.toLowerCase());
        expect(seen[0][1][0]).toBe(OWNER);
        void chain;
    });
});

describe('browser-local deployments (start-up check)', () => {
    const storage = () => {
        const s = memStore();
        return s;
    };
    const ok = (size: number, factoryReply?: string) => async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const result = body.method === 'quai_getCode' ? '0x' + '00'.repeat(size) : factoryReply;
        return { ok: true, json: async () => ({ result }) };
    };
    const reset = () => {
        for (const k of Object.keys(DEPLOYED) as (keyof typeof DEPLOYED)[]) (DEPLOYED as any)[k] = null;
    };

    test('applies an address only when the chain has exactly the compiled code', async () => {
        reset();
        const s = storage();
        saveLocalDeployments({ QRB: OWNER }, s);
        const report = await applyVerifiedLocalDeployments({ storage: s, fetcher: ok(CIRCLESWAP_RUNTIME_BYTES.Qrb) as any });
        expect(report.applied).toEqual(['QRB']);
        expect(DEPLOYED.QRB).toBe(OWNER);
        reset();
    });

    test('drops and forgets an address that has no code or the wrong code', async () => {
        reset();
        const s = storage();
        saveLocalDeployments({ QRB: OWNER }, s);
        const report = await applyVerifiedLocalDeployments({ storage: s, fetcher: ok(0) as any });
        expect(report.applied).toEqual([]);
        expect(report.rejected[0].key).toBe('QRB');
        expect(DEPLOYED.QRB).toBeNull();
        expect(readLocalDeployments(s)?.values.QRB).toBeUndefined();

        saveLocalDeployments({ QRB: OWNER }, s);
        const wrong = await applyVerifiedLocalDeployments({ storage: s, fetcher: ok(123) as any });
        expect(wrong.rejected[0].reason).toContain('123 bytes');
    });

    test('never overrides a value the generated deployed.ts already sets', async () => {
        reset();
        DEPLOYED.QRB = OTHER;
        const s = storage();
        saveLocalDeployments({ QRB: OWNER }, s);
        const report = await applyVerifiedLocalDeployments({ storage: s, fetcher: ok(CIRCLESWAP_RUNTIME_BYTES.Qrb) as any });
        expect(report.shadowed).toEqual(['QRB']);
        expect(DEPLOYED.QRB).toBe(OTHER);
        reset();
    });

    test('a router is refused unless it was built for the factory beside it', async () => {
        reset();
        const s = storage();
        const factory = checksum('0x0006112e89ee10615273ed72fe035cc068bc57a9');
        const factoryImpl = checksum('0x0006112e89ee10615273ed72fe035cc068bc57aa');
        const routerImpl = checksum('0x0006112e89ee10615273ed72fe035cc068bc57ab');
        saveLocalDeployments({ AMM_FACTORY: factory, AMM_ROUTER: OWNER }, s);
        const fetcher = async (_u: string, init: any) => {
            const body = JSON.parse(init.body);
            if (body.method === 'quai_getStorageAt') {
                const isRouter = body.params[0].toLowerCase() === OWNER.toLowerCase();
                const targetImpl = isRouter ? routerImpl : factoryImpl;
                return { ok: true, json: async () => ({ result: '0x' + '00'.repeat(12) + targetImpl.slice(2) }) };
            }
            if (body.method === 'quai_getCode') {
                const target = body.params[0].toLowerCase();
                let size = CIRCLESWAP_RUNTIME_BYTES.ERC1967Proxy;
                if (target === factoryImpl.toLowerCase()) size = CIRCLESWAP_RUNTIME_BYTES.CircleswapFactory;
                else if (target === routerImpl.toLowerCase()) size = CIRCLESWAP_RUNTIME_BYTES.CircleswapRouter;
                return { ok: true, json: async () => ({ result: '0x' + '00'.repeat(size) }) };
            }
            return { ok: true, json: async () => ({ result: '0x' + '0'.repeat(24) + 'f'.repeat(40) }) }; // some other factory
        };
        const report = await applyVerifiedLocalDeployments({ storage: s, fetcher: fetcher as any });
        expect(report.applied).toEqual(['AMM_FACTORY']);
        expect(report.rejected.map(r => r.key)).toEqual(['AMM_ROUTER']);
        expect(DEPLOYED.AMM_ROUTER).toBeNull();
        reset();
    });

    test('does nothing (and makes no network call) when nothing is stored, or storage is unreadable', async () => {
        reset();
        let calls = 0;
        const fetcher = async () => {
            calls++;
            return { ok: true, json: async () => ({ result: '0x' }) };
        };
        expect((await applyVerifiedLocalDeployments({ storage: storage(), fetcher: fetcher as any })).applied).toEqual([]);
        expect((await applyVerifiedLocalDeployments({ storage: null, fetcher: fetcher as any })).applied).toEqual([]);
        const junk = storage();
        junk.setItem(LOCAL_DEPLOYMENTS_KEY, '{not json');
        expect((await applyVerifiedLocalDeployments({ storage: junk, fetcher: fetcher as any })).applied).toEqual([]);
        expect(calls).toBe(0);
    });

    test('an RPC failure rejects the address rather than trusting storage', async () => {
        reset();
        const s = storage();
        saveLocalDeployments({ QRB: OWNER }, s);
        const down = async () => ({ ok: false, json: async () => ({}) });
        const report = await applyVerifiedLocalDeployments({ storage: s, fetcher: down as any });
        expect(report.applied).toEqual([]);
        expect(DEPLOYED.QRB).toBeNull();
    });

    test('only full Cyprus-1 addresses are ever stored', () => {
        const s = storage();
        saveLocalDeployments({ QRB: '0x1111111111111111111111111111111111111111', QRB_NFT: "0x00'; drop" as any, MASTERCHEF: OWNER, ARTWORK_URI: 'https://evil.test' }, s);
        expect(readLocalDeployments(s)?.values).toEqual({ MASTERCHEF: OWNER });
    });
});

// Keep the type import used under noUnusedLocals-style checkers.
export type _Unused = Flow;
