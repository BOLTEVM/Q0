import { Interface } from "ethers";
import { loadArtifact, type Artifact } from "./artifacts";
import type { ChainClient } from "./chain";
import { deployContract, sendAndWait, type DeployOptions, type DeployResult } from "./deploy";
import { QRB_BOOST_BPS, QRB_BOOST_MATURITY_SECONDS, QRB_BOOST_THRESHOLD_WEI } from "../../../quai-service/src/registries/qrb";

/** What has been deployed / done so far. Persisted by the CLI after every step so a failure is never a loss. */
export interface DeployProgress {
    qrb?: string;
    nft?: string;
    farm?: string;
    /** Number of farm pools confirmed added, in order. */
    poolsAdded?: number;
    mintedGenesis?: boolean;
    mintedArtifact?: boolean;
    txHashes: Record<string, string>;
}

export interface CircleswapConfig {
    /** Owner of every contract. Must equal the deployer if `mintTo` is set (only the owner can mint). */
    owner: string;
    /** Receives the NFT's 5% royalty. */
    royaltyReceiver: string;
    /** Arweave URI of the artwork (already verified by the caller). */
    artworkURI: string;
    /** If set, mint the 1.0 QRB genesis supply and the 1-of-1 NFT to this address after deploying. */
    mintTo?: string;
    /** If set, also deploy the farm. Rates are wei of reward token per second. */
    farm?: {
        rewardTokenA: string;
        rewardTokenB: string;
        rewardAPerSecond: bigint;
        rewardBPerSecond: bigint;
        /** Pools to add right after deployment, in order: pool ids follow the array index. */
        pools?: { allocPoint: number; lpToken: string }[];
    };
    /**
     * Deploy only the farm, pointed at this already-deployed Qrb. Qrb and the NFT are neither deployed nor
     * minted. Requires `farm`.
     */
    existingQrb?: string;
    /**
     * Continue an interrupted run: contracts already deployed (from a saved DeployProgress) are re-verified and
     * adopted instead of deployed again, and only the remaining steps are performed. Broadcast runs only.
     */
    resume?: Pick<DeployProgress, "qrb" | "nft" | "farm">;
    /** Called with the cumulative progress after every completed step. */
    onProgress?: (progress: DeployProgress) => void;
    /**
     * Dry run only: a deployed contract that really answers the boost interface, used as the Qrb address so the
     * NFT and farm constructors can be simulated exactly. Without one (nothing answers that interface on-chain
     * before Qrb exists) the farm is simulated with no boost source, which its constructor allows, and the NFT's
     * cost is projected from its size relative to Qrb. Real deployments are unaffected: each constructor is
     * simulated against the actually deployed Qrb immediately before it is sent.
     */
    dryRunQrbStandIn?: string;
    deploy: Omit<DeployOptions, "label">;
    /** Artifact loader; overridable for tests. */
    artifact?: (name: string) => Artifact;
}

export interface CircleswapDeployment {
    dryRun: boolean;
    qrb?: DeployResult;
    nft?: DeployResult;
    farm?: DeployResult;
    /** The Qrb address the farm points at (deployed here, adopted, or `existingQrb`). Absent in a dry run. */
    qrbAddress?: string;
    minted?: { genesisTx: string; artifactTx: string; recipient: string };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

/** The one-number rule, checked against a live contract: the app's constants must equal the chain's. */
async function expectBoostConstants(client: ChainClient, iface: Interface, address: string, who: string) {
    expectEqual(`${who}.BOOST_BPS`, await read(client, iface, address, "BOOST_BPS"), BigInt(QRB_BOOST_BPS));
    expectEqual(`${who}.BOOST_THRESHOLD`, await read(client, iface, address, "BOOST_THRESHOLD"), QRB_BOOST_THRESHOLD_WEI);
    expectEqual(`${who}.BOOST_MATURITY`, await read(client, iface, address, "BOOST_MATURITY"), BigInt(QRB_BOOST_MATURITY_SECONDS));
}

/** Reads a deployed Qrb back and checks it is the contract we meant to deploy. */
export async function verifyQrb(client: ChainClient, art: Artifact, address: string, cfg: CircleswapConfig) {
    const iface = new Interface(art.abi);
    expectEqual("Qrb.name", await read(client, iface, address, "name"), "Circleswap Qrb");
    expectEqual("Qrb.symbol", await read(client, iface, address, "symbol"), "QRB");
    expectEqual("Qrb.owner", await read(client, iface, address, "owner"), cfg.owner);
    expectEqual("Qrb.artworkURI", await read(client, iface, address, "artworkURI"), cfg.artworkURI);
    expectEqual("Qrb.MAX_SUPPLY", await read(client, iface, address, "MAX_SUPPLY"), 10n ** 18n);
    await expectBoostConstants(client, iface, address, "Qrb");
}

export async function verifyNft(client: ChainClient, art: Artifact, address: string, qrb: string, cfg: CircleswapConfig) {
    const iface = new Interface(art.abi);
    expectEqual("NFT.qrb", await read(client, iface, address, "qrb"), qrb);
    expectEqual("NFT.owner", await read(client, iface, address, "owner"), cfg.owner);
    expectEqual("NFT.artworkURI", await read(client, iface, address, "artworkURI"), cfg.artworkURI);
    const [receiver, amount] = await read(client, iface, address, "royaltyInfo", [1, 10_000n]);
    expectEqual("NFT.royaltyReceiver", receiver, cfg.royaltyReceiver);
    expectEqual("NFT.royalty(10000)", amount, 500n);
}

export async function verifyFarm(client: ChainClient, art: Artifact, address: string, qrb: string, cfg: CircleswapConfig) {
    const farm = cfg.farm!;
    const iface = new Interface(art.abi);
    expectEqual("Farm.owner", await read(client, iface, address, "owner"), cfg.owner);
    expectEqual("Farm.qrb", await read(client, iface, address, "qrb"), qrb);
    expectEqual("Farm.rewardTokenA", await read(client, iface, address, "rewardTokenA"), farm.rewardTokenA);
    expectEqual("Farm.rewardTokenB", await read(client, iface, address, "rewardTokenB"), farm.rewardTokenB);
    expectEqual("Farm.rewardAPerSecond", await read(client, iface, address, "rewardAPerSecond"), farm.rewardAPerSecond);
    expectEqual("Farm.rewardBPerSecond", await read(client, iface, address, "rewardBPerSecond"), farm.rewardBPerSecond);
}

/** A contract from an earlier, interrupted run: check code is present and the right size, then adopt it. */
async function adopt(client: ChainClient, art: Artifact, address: string, label: string): Promise<DeployResult> {
    const code = await client.getCode(address);
    if (!code || code === "0x") throw new Error(`Resume: ${label} ${address} has no code on this chain`);
    const want = (art.deployedBytecode.length - 2) / 2;
    const got = (code.length - 2) / 2;
    if (got !== want) throw new Error(`Resume: ${label} ${address} is ${got} bytes, compiled runtime is ${want}`);
    return { dryRun: false, label, estimatedGas: 0n, gasLimit: 0n, maxFee: 0n, address, resumed: true };
}

/**
 * Adds the pools in order and checks the farm reports exactly that list back. Safe to run again after a
 * partial failure: pools already present must match the front of the list, and only the rest are added.
 */
export async function addPools(
    client: ChainClient,
    art: Artifact,
    farmAddress: string,
    pools: { allocPoint: number; lpToken: string }[],
    opts: Omit<DeployOptions, "label">,
    onAdded?: (count: number, txHash: string) => void
) {
    const iface = new Interface(art.abi);
    const existing = Number(await read(client, iface, farmAddress, "poolLength"));
    if (existing > pools.length) {
        throw new Error(`Farm already has ${existing} pools, more than the ${pools.length} to add; refusing to guess`);
    }
    for (let i = 0; i < existing; i++) {
        const info = await read(client, iface, farmAddress, "poolInfo", [i]);
        expectEqual(`Farm.pool[${i}].lpToken (already added)`, info[0], pools[i].lpToken);
        expectEqual(`Farm.pool[${i}].allocPoint (already added)`, info[1], BigInt(pools[i].allocPoint));
    }
    for (let i = existing; i < pools.length; i++) {
        const { txHash } = await sendAndWait(
            client,
            farmAddress,
            iface.encodeFunctionData("addPool", [pools[i].allocPoint, pools[i].lpToken]),
            { ...opts, label: `addPool(${i})` }
        );
        onAdded?.(i + 1, txHash);
    }
    expectEqual("Farm.poolLength", await read(client, iface, farmAddress, "poolLength"), BigInt(pools.length));
    for (let i = 0; i < pools.length; i++) {
        const info = await read(client, iface, farmAddress, "poolInfo", [i]);
        expectEqual(`Farm.pool[${i}].lpToken`, info[0], pools[i].lpToken);
        expectEqual(`Farm.pool[${i}].allocPoint`, info[1], BigInt(pools[i].allocPoint));
    }
}

/**
 * Deploys Qrb, then the NFT and (optionally) the farm pointed at that Qrb, reading every address off its
 * own deployment receipt and verifying each contract's state before moving on. Optionally mints and adds
 * the farm's pools. With `deploy.broadcast` false nothing is sent: every constructor is simulated and costs
 * are reported.
 *
 * Interrupted runs are recoverable: `onProgress` reports what exists after each step, and `resume` feeds it
 * back so nothing is deployed, added or minted twice.
 */
export async function deployCircleswap(client: ChainClient, cfg: CircleswapConfig): Promise<CircleswapDeployment> {
    const load = cfg.artifact ?? loadArtifact;
    const dry = !cfg.deploy.broadcast;
    const farmOnly = cfg.existingQrb !== undefined;
    const resume = dry ? {} : cfg.resume ?? {};

    if (farmOnly && !cfg.farm) throw new Error("existingQrb only makes sense with a farm to deploy");
    if (farmOnly && cfg.mintTo) throw new Error("mintTo cannot be combined with existingQrb (Qrb is not deployed here)");
    if (farmOnly && (resume.qrb || resume.nft)) throw new Error("resume.qrb / resume.nft cannot be combined with existingQrb");
    if (cfg.mintTo && !same(cfg.owner, client.deployer)) {
        throw new Error("mintTo needs owner == deployer: only the owner can mint");
    }

    const qrbArt = load("Qrb");
    const nftArt = farmOnly ? undefined : load("QrbArtifactNFT");
    const farmArt = cfg.farm ? load("CircleswapMasterChef") : undefined;

    const progress: DeployProgress = { txHashes: {} };
    const report = () => cfg.onProgress?.({ ...progress, txHashes: { ...progress.txHashes } });

    let qrb: DeployResult | undefined;
    let nft: DeployResult | undefined;
    let qrbAddress: string | undefined;

    if (farmOnly) {
        qrbAddress = cfg.existingQrb!;
        const code = await client.getCode(qrbAddress);
        if (!code || code === "0x") throw new Error(`existingQrb ${qrbAddress} has no code`);
        await expectBoostConstants(client, new Interface(qrbArt.abi), qrbAddress, "existing Qrb");
    } else {
        qrb = resume.qrb
            ? await adopt(client, qrbArt, resume.qrb, "Qrb")
            : await deployContract(client, qrbArt, [cfg.owner, cfg.artworkURI], { ...cfg.deploy, label: "Qrb" });
        if (!dry) {
            qrbAddress = qrb.address!;
            await verifyQrb(client, qrbArt, qrbAddress, cfg);
            progress.qrb = qrbAddress;
            if (qrb.txHash) progress.txHashes.qrb = qrb.txHash;
            report();
        }
    }

    // While simulating, nothing is deployed yet. The farm can be simulated with no boost source; the NFT needs
    // one that answers the interface, so it is either simulated against a supplied stand-in or projected.
    const ZERO = "0x0000000000000000000000000000000000000000";
    const qrbForFarm = qrbAddress ?? cfg.dryRunQrbStandIn ?? ZERO;
    const qrbForNft = qrbAddress ?? cfg.dryRunQrbStandIn;

    if (nftArt) {
        if (resume.nft) {
            nft = await adopt(client, nftArt, resume.nft, "QrbArtifactNFT");
        } else if (qrbForNft) {
            nft = await deployContract(
                client,
                nftArt,
                [cfg.owner, cfg.royaltyReceiver, cfg.artworkURI, qrbForNft],
                { ...cfg.deploy, label: "QrbArtifactNFT" }
            );
        } else {
            // Dry run, nothing on-chain answers the boost interface yet: project from bytecode size.
            const ratio = (nftArt.bytecode.length - 2) / (qrbArt.bytecode.length - 2);
            const estimatedGas = BigInt(Math.round(Number(qrb!.estimatedGas) * ratio));
            const multiplier = cfg.deploy.gasMultiplier ?? 3;
            const gasLimit = (estimatedGas * BigInt(Math.round(multiplier * 100))) / 100n;
            const gasPrice = await client.getGasPrice();
            nft = { dryRun: true, projected: true, label: "QrbArtifactNFT", estimatedGas, gasLimit, maxFee: gasLimit * gasPrice };
        }
        if (!dry) {
            await verifyNft(client, nftArt, nft.address!, qrbAddress!, cfg);
            progress.nft = nft.address!;
            if (nft.txHash) progress.txHashes.nft = nft.txHash;
            report();
        }
    }

    let farm: DeployResult | undefined;
    if (cfg.farm && farmArt) {
        farm = resume.farm
            ? await adopt(client, farmArt, resume.farm, "CircleswapMasterChef")
            : await deployContract(
                  client,
                  farmArt,
                  [cfg.owner, cfg.farm.rewardTokenA, cfg.farm.rewardTokenB, qrbForFarm, cfg.farm.rewardAPerSecond, cfg.farm.rewardBPerSecond],
                  { ...cfg.deploy, label: "CircleswapMasterChef" }
              );
        if (!dry) {
            await verifyFarm(client, farmArt, farm.address!, qrbAddress!, cfg);
            progress.farm = farm.address!;
            if (farm.txHash) progress.txHashes.farm = farm.txHash;
            report();
            if (cfg.farm.pools?.length) {
                if (!same(cfg.owner, client.deployer)) throw new Error("adding pools needs owner == deployer");
                await addPools(client, farmArt, farm.address!, cfg.farm.pools, cfg.deploy, (count, txHash) => {
                    progress.poolsAdded = count;
                    progress.txHashes[`addPool${count - 1}`] = txHash;
                    report();
                });
                progress.poolsAdded = cfg.farm.pools.length;
                report();
            }
        }
    }

    let minted: CircleswapDeployment["minted"];
    if (!dry && cfg.mintTo && qrb && nft && nftArt) {
        const qrbIface = new Interface(qrbArt.abi);
        const nftIface = new Interface(nftArt.abi);
        let genesisTx = "already minted";
        let artifactTx = "already minted";

        // Each mint is skipped if it already happened, so a resumed run never trips MaxSupplyReached.
        if (!(await read(client, qrbIface, qrb.address!, "genesisMinted"))) {
            const g = await sendAndWait(client, qrb.address!, qrbIface.encodeFunctionData("mintGenesis", [cfg.mintTo]), { ...cfg.deploy, label: "mintGenesis" });
            genesisTx = g.txHash;
            progress.txHashes.mintGenesis = g.txHash;
        }
        expectEqual("Qrb.totalSupply", await read(client, qrbIface, qrb.address!, "totalSupply"), 10n ** 18n);
        progress.mintedGenesis = true;
        report();

        if (!(await read(client, nftIface, nft.address!, "minted"))) {
            const a = await sendAndWait(client, nft.address!, nftIface.encodeFunctionData("mintArtifact", [cfg.mintTo]), { ...cfg.deploy, label: "mintArtifact" });
            artifactTx = a.txHash;
            progress.txHashes.mintArtifact = a.txHash;
        }
        expectEqual("NFT.ownerOf(1)", await read(client, nftIface, nft.address!, "ownerOf", [1]), cfg.mintTo);
        progress.mintedArtifact = true;
        report();

        minted = { genesisTx, artifactTx, recipient: cfg.mintTo };
    }

    return { dryRun: dry, qrb, nft, farm, qrbAddress, minted };
}
