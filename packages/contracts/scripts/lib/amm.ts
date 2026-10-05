import { Interface } from "ethers";
import { loadArtifact, type Artifact } from "./artifacts";
import type { ChainClient } from "./chain";
import { deployContract, sendAndWait, type DeployOptions, type DeployResult } from "./deploy";

/** What exists so far; persisted by the CLI after every step so a failure never loses an address. */
export interface AmmProgress {
    factory?: string;
    router?: string;
    feeToSet?: boolean;
    txHashes: Record<string, string>;
}

export interface AmmConfig {
    /** Owns the factory: the only power is choosing where the protocol fee goes (off by default). */
    owner: string;
    /** Wrapped native QUAI, used by the router for native-QUAI pools and swaps. */
    wquai: string;
    /** Turn the protocol fee on at deploy time (LP tokens for one sixth of the fee are minted here). */
    feeTo?: string;
    /**
     * Two real tokens used to prove, right after the factory exists, that a pool it creates lands where Quai
     * requires (see `checkPoolAddress`). Nothing is created: the factory is only called statically.
     */
    probeTokens: [string, string];
    /** Chain rule for a valid pool address (e.g. must be a Cyprus-1 address). Throw to reject. */
    checkPoolAddress?: (address: string) => void;
    /** Continue an interrupted run: these are re-verified and reused instead of deployed again. */
    resume?: Pick<AmmProgress, "factory" | "router">;
    onProgress?: (progress: AmmProgress) => void;
    deploy: Omit<DeployOptions, "label">;
    artifact?: (name: string) => Artifact;
}

export interface AmmDeployment {
    dryRun: boolean;
    factory: DeployResult;
    router: DeployResult;
    /** The pool address the factory returned for the probe pair, in a broadcast run. */
    probePoolAddress?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

async function read(client: ChainClient, iface: Interface, address: string, fn: string, args: unknown[] = []) {
    const out = await client.call(address, iface.encodeFunctionData(fn, args));
    const decoded = iface.decodeFunctionResult(fn, out);
    return decoded.length === 1 ? decoded[0] : decoded;
}

function expectEqual(what: string, got: unknown, want: unknown) {
    const eq = typeof got === "string" && typeof want === "string" && got.startsWith("0x") && want.startsWith("0x")
        ? same(got, want)
        : got === want;
    if (!eq) throw new Error(`Post-deploy check failed: ${what} is ${String(got)}, expected ${String(want)}`);
}

async function adopt(client: ChainClient, art: Artifact, address: string, label: string, altArt?: Artifact): Promise<DeployResult> {
    const code = await client.getCode(address);
    if (!code || code === "0x") throw new Error(`Resume: ${label} ${address} has no code on this chain`);
    const want = (art.deployedBytecode.length - 2) / 2;
    const got = (code.length - 2) / 2;
    if (got !== want) {
        if (altArt) {
            const altWant = (altArt.deployedBytecode.length - 2) / 2;
            if (got === altWant) {
                return { dryRun: false, label, estimatedGas: 0n, gasLimit: 0n, maxFee: 0n, address, resumed: true };
            }
        }
        throw new Error(`Resume: ${label} ${address} is ${got} bytes, compiled runtime is ${want}`);
    }
    return { dryRun: false, label, estimatedGas: 0n, gasLimit: 0n, maxFee: 0n, address, resumed: true };
}

/** Reads a deployed factory back: owner, and that its pool implementation is real, locked, and the right code. */
export async function verifyFactory(client: ChainClient, factoryArt: Artifact, pairArt: Artifact, address: string, owner: string) {
    const iface = new Interface(factoryArt.abi);
    expectEqual("Factory.owner", await read(client, iface, address, "owner"), owner);

    const impl: string = await read(client, iface, address, "pairImplementation");
    const code = await client.getCode(impl);
    if (!code || code === "0x") throw new Error(`Factory.pairImplementation ${impl} has no code`);
    const want = (pairArt.deployedBytecode.length - 2) / 2;
    const got = (code.length - 2) / 2;
    if (got !== want) throw new Error(`Factory.pairImplementation is ${got} bytes, compiled pool is ${want}`);
    // The implementation must be locked so nobody can initialise it and use it as a pool.
    const pairIface = new Interface(pairArt.abi);
    expectEqual("Pool implementation.factory (locked)", await read(client, pairIface, impl, "factory"), "0x0000000000000000000000000000000000000001");
}

export async function verifyRouter(client: ChainClient, art: Artifact, address: string, factory: string, wquai: string) {
    const iface = new Interface(art.abi);
    expectEqual("Router.factory", await read(client, iface, address, "factory"), factory);
    expectEqual("Router.WETH", await read(client, iface, address, "WETH"), wquai);
}

/**
 * Deploys the Circleswap AMM: the factory (which deploys its own pool implementation) and the router, reading
 * every address off its own deployment receipt, verifying each contract's state, and then proving with a static
 * call that a pool the factory creates lands at a valid address before anyone depends on it. Optionally turns
 * the protocol fee on. With `deploy.broadcast` false nothing is sent: the factory is simulated exactly and the
 * router (which needs a real factory to talk to) is projected from its size, and labelled as such.
 */
export async function deployAmm(client: ChainClient, cfg: AmmConfig): Promise<AmmDeployment> {
    const load = cfg.artifact ?? loadArtifact;
    const factoryArt = load("CircleswapFactory");
    const pairArt = load("CircleswapPair");
    const routerArt = load("CircleswapRouter");
    const proxyArt = load("ERC1967Proxy");
    const dry = !cfg.deploy.broadcast;
    const resume = dry ? {} : cfg.resume ?? {};
    // Only the owner can call setFeeTo, so refuse before spending anything rather than after two deployments.
    if (cfg.feeTo && !same(cfg.owner, client.deployer)) {
        throw new Error("feeTo needs owner == deployer (only the owner can set it). Deploy first, then have the owner call setFeeTo.");
    }

    const progress: AmmProgress = { txHashes: {} };
    const report = () => cfg.onProgress?.({ ...progress, txHashes: { ...progress.txHashes } });

    const isFactoryUpgradeable = factoryArt.abi.some((i: any) => i.type === "function" && i.name === "initialize");
    const isRouterUpgradeable = routerArt.abi.some((i: any) => i.type === "function" && i.name === "initialize");

    let factory: DeployResult;
    if (dry) {
        factory = await deployContract(client, factoryArt, isFactoryUpgradeable ? [] : [cfg.owner], { ...cfg.deploy, label: "CircleswapFactory" });
    } else if (resume.factory) {
        factory = await adopt(client, proxyArt, resume.factory, "CircleswapFactory", factoryArt);
    } else if (isFactoryUpgradeable) {
        const factoryImpl = await deployContract(client, factoryArt, [], { ...cfg.deploy, label: "CircleswapFactoryImpl" });
        const factoryIface = new Interface(factoryArt.abi);
        const factoryInitData = factoryIface.encodeFunctionData("initialize", [cfg.owner]);
        factory = await deployContract(client, proxyArt, [factoryImpl.address, factoryInitData], { ...cfg.deploy, label: "CircleswapFactory" });
    } else {
        factory = await deployContract(client, factoryArt, [cfg.owner], { ...cfg.deploy, label: "CircleswapFactory" });
    }

    if (dry) {
        // The router's constructor requires a factory with code, so it cannot be simulated before one exists.
        const ratio = (routerArt.bytecode.length - 2) / (factoryArt.bytecode.length - 2);
        const estimatedGas = BigInt(Math.round(Number(factory.estimatedGas) * ratio));
        const gasLimit = (estimatedGas * BigInt(Math.round((cfg.deploy.gasMultiplier ?? 3) * 100))) / 100n;
        const router: DeployResult = {
            dryRun: true,
            projected: true,
            label: "CircleswapRouter",
            estimatedGas,
            gasLimit,
            maxFee: gasLimit * (await client.getGasPrice())
        };
        return { dryRun: true, factory, router };
    }

    const factoryAddr = factory.address!;
    await verifyFactory(client, factoryArt, pairArt, factoryAddr, cfg.owner);
    progress.factory = factoryAddr;
    if (factory.txHash) progress.txHashes.factory = factory.txHash;
    report();

    let router: DeployResult;
    if (resume.router) {
        router = await adopt(client, proxyArt, resume.router, "CircleswapRouter", routerArt);
    } else if (isRouterUpgradeable) {
        const routerImpl = await deployContract(client, routerArt, [], { ...cfg.deploy, label: "CircleswapRouterImpl" });
        const routerIface = new Interface(routerArt.abi);
        const routerInitData = routerIface.encodeFunctionData("initialize", [factoryAddr, cfg.wquai, cfg.owner]);
        router = await deployContract(client, proxyArt, [routerImpl.address, routerInitData], { ...cfg.deploy, label: "CircleswapRouter" });
    } else {
        router = await deployContract(client, routerArt, [factoryAddr, cfg.wquai], { ...cfg.deploy, label: "CircleswapRouter" });
    }
    await verifyRouter(client, routerArt, router.address!, factoryAddr, cfg.wquai);
    progress.router = router.address!;
    if (router.txHash) progress.txHashes.router = router.txHash;
    report();

    // Prove pool creation works and lands somewhere valid, without creating anything: a static call to
    // createPair returns the address the pool WOULD get. Quai grinds contract addresses, so this is the
    // real test that clones are placed in-zone. Skipped if that pool already exists (a resumed run).
    const factoryIface = new Interface(factoryArt.abi);
    let probePoolAddress: string | undefined;
    const [t0, t1] = cfg.probeTokens;
    const existing: string = await read(client, factoryIface, factoryAddr, "getPair", [t0, t1]);
    if (same(existing, ZERO)) {
        const out = await client.call(factoryAddr, factoryIface.encodeFunctionData("createPair", [t0, t1]));
        probePoolAddress = factoryIface.decodeFunctionResult("createPair", out)[0] as string;
        if (same(probePoolAddress, ZERO)) throw new Error("Factory.createPair returned the zero address");
        cfg.checkPoolAddress?.(probePoolAddress);
    }

    if (cfg.feeTo) {
        const current: string = await read(client, factoryIface, factoryAddr, "feeTo");
        if (!same(current, cfg.feeTo)) {
            const { txHash } = await sendAndWait(client, factoryAddr, factoryIface.encodeFunctionData("setFeeTo", [cfg.feeTo]), { ...cfg.deploy, label: "setFeeTo" });
            progress.txHashes.setFeeTo = txHash;
        }
        expectEqual("Factory.feeTo", await read(client, factoryIface, factoryAddr, "feeTo"), cfg.feeTo);
        progress.feeToSet = true;
        report();
    }

    return { dryRun: false, factory, router, probePoolAddress };
}
