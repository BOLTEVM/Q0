import { Interface } from "ethers";
import * as crypto from "crypto";
import { loadArtifact, type Artifact } from "./artifacts";
import type { ChainClient } from "./chain";
import { deployContract, settleCreate, type DeployOptions, type DeployResult } from "./deploy";
import { ammFlow, probePoolPlacement, type AmmFlowConfig, type DeployStep, type Reader } from "../../../quai-service/src/deploy/flows";
import { inspectAmm, type IntegrityReport } from "../../../quai-service/src/deploy/integrity";
import { CIRCLESWAP_ARTIFACTS } from "../../../quai-service/src/generated/circleswapArtifacts";
import { CIRCLESWAP_RUNTIME_BYTES } from "../../../quai-service/src/generated/circleswapRuntimeSizes";
import { creationGasLimit } from "../../../quai-service/src/deploy/gas";

/**
 * Deploys the Circleswap AMM exactly the way the browser does, because it runs the same plan (`ammFlow`, shared with the
 * deploy modal): a timelock, then the factory and the router, each an implementation plus an ERC-1967 proxy that is
 * initialised in the very transaction that creates it, with the timelock as owner of both. The deployer ends with no
 * power of any kind. Every step is read back from the chain before the next one is built on it, and the finished system
 * is handed to the integrity inspector, which must not call it unsafe.
 */

/** One step of the plan, as far as it got. */
export interface AmmStepRecord {
    done: boolean;
    /** Written the moment the transaction is sent, before waiting for it: a later run settles it rather than sending again. */
    txHash?: string;
    address?: string;
    blockNumber?: number;
    gasUsed?: string;
    gasLimit?: string;
    /** ABI-encoded constructor arguments, for source verification on an explorer. */
    constructorArgs?: string;
}

/** What exists so far; persisted by the CLI after every step so a failure never loses an address or a transaction. */
export interface AmmProgress {
    /** Digest of the settings the run began with: a saved run only resumes under the same ones. */
    fingerprint: string;
    deployer: string;
    /** Addresses by key: AMM_TIMELOCK, AMM_FACTORY_IMPL, AMM_FACTORY, AMM_PAIR_BEACON, AMM_ROUTER_IMPL, AMM_ROUTER. */
    ctx: Record<string, string>;
    steps: Record<string, AmmStepRecord>;
    updatedAt: string;
}

export interface AmmConfig extends AmmFlowConfig {
    /** Continue an interrupted run: finished steps are re-verified and kept, a sent-but-unconfirmed one is settled. */
    resume?: AmmProgress;
    onProgress?: (progress: AmmProgress) => void;
    deploy: Omit<DeployOptions, "label" | "onSent" | "depositedBytes">;
    artifact?: (name: string) => Artifact;
    /**
     * Start even though the balance does not cover the deployment's worst case. Safe, because every step checks its own funds
     * before it is sent and a stopped run resumes where it stopped; it just may need topping up part-way.
     */
    allowUnderfunded?: boolean;
}

export interface AmmStepResult extends DeployResult {
    stepId: string;
    contract: string;
}

export interface AmmDeployment {
    dryRun: boolean;
    fingerprint: string;
    steps: AmmStepResult[];
    /** Addresses by key; empty on a dry run. */
    ctx: Record<string, string>;
    /** The address the next pool would get (the factory only simulated creating it), when a probe was configured. */
    probePoolAddress?: string | null;
    /** The inspector's reading of the finished system; present only after a broadcast. */
    integrity?: IntegrityReport;
    /** Every step's transaction hash, address and constructor arguments; present only after a broadcast. */
    progress?: AmmProgress;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Digest of the settings that decide what gets deployed. */
export function fingerprintOf(cfg: Pick<AmmFlowConfig, "proposer" | "delaySeconds" | "wquai" | "openExecution" | "guardians">): string {
    const canon = JSON.stringify({
        proposer: cfg.proposer.toLowerCase(),
        delaySeconds: Math.floor(cfg.delaySeconds),
        wquai: cfg.wquai.toLowerCase(),
        open: cfg.openExecution !== false,
        guardians: (cfg.guardians ?? []).map(g => g.toLowerCase()).sort()
    });
    return crypto.createHash("sha256").update(canon).digest("hex");
}

/** The chain client as the read-only surface the plan's verification steps use. */
export function readerOf(client: ChainClient): Reader {
    return {
        call: (to, data) => client.call(to, data),
        getCode: address => client.getCode(address),
        getStorageAt: (address, slot) => client.getStorageAt(address, slot)
    };
}

/**
 * The browser modal deploys the bytes in `generated/circleswapArtifacts.ts` and checks the chain against the hashes beside
 * them; this script deploys the freshly compiled bytes. They must be identical, or a deployment would be spent on code the
 * verification then rejects. Run `compile` and `export:artifacts` if this fails.
 */
export function assertGeneratedMatchesCompiled(names: string[], load: (name: string) => Artifact = loadArtifact) {
    for (const name of names) {
        const compiled = load(name).bytecode;
        const generated = (CIRCLESWAP_ARTIFACTS as Record<string, { bytecode: string }>)[name]?.bytecode;
        if (!generated) throw new Error(`${name} is not in the generated artifacts. Run \`pnpm --filter contracts export:artifacts\`.`);
        if (compiled.toLowerCase() !== generated.toLowerCase()) {
            throw new Error(`The generated artifact for ${name} is stale: it differs from the compiled contract. Run \`pnpm --filter contracts compile && pnpm --filter contracts export:artifacts\`, then try again. Nothing was sent.`);
        }
    }
}

/**
 * What a step that cannot be simulated yet (its constructor needs an address an earlier step will create) will roughly
 * cost, from one that could. These are projections, labelled as such: every step is simulated exactly, against the real
 * addresses, immediately before it is sent.
 */
function projectGas(step: DeployStep, estimates: Record<string, bigint>): bigint | null {
    const proxy = CIRCLESWAP_RUNTIME_BYTES.ERC1967Proxy;
    if (step.id === "factoryProxy" && estimates.factoryImpl) {
        // Its initialize() creates the pool implementation and the beacon: cost scales with the code it deposits.
        const deposited = proxy + CIRCLESWAP_RUNTIME_BYTES.CircleswapPair + CIRCLESWAP_RUNTIME_BYTES.UpgradeableBeacon;
        return (estimates.factoryImpl * BigInt(Math.round(1.15 * 100)) * BigInt(deposited)) / (100n * BigInt(CIRCLESWAP_RUNTIME_BYTES.CircleswapFactory));
    }
    if (step.id === "routerProxy") return 600_000n; // a 130-byte proxy plus a handful of storage writes
    return null;
}

/**
 * Deploys the AMM. With `deploy.broadcast` false nothing is sent: what can be simulated exactly is, the two proxies are
 * projected and labelled so. With it true, every transaction is simulated right before it is sent, its hash is recorded the
 * moment it is sent, and nothing later is built until what came before has been read back from the chain.
 */
export async function deployAmm(client: ChainClient, cfg: AmmConfig): Promise<AmmDeployment> {
    const load = cfg.artifact ?? loadArtifact;
    const dry = !cfg.deploy.broadcast;
    const flow = ammFlow(cfg);
    const fingerprint = fingerprintOf(cfg);
    const reader = readerOf(client);

    assertGeneratedMatchesCompiled([...new Set(flow.steps.map(s => s.contract))], load);

    // --- the saved run, if we are resuming one -------------------------------------------------------------------
    const progress: AmmProgress = { fingerprint, deployer: client.deployer, ctx: {}, steps: {}, updatedAt: new Date().toISOString() };
    if (!dry && cfg.resume) {
        if (cfg.resume.fingerprint !== fingerprint) {
            throw new Error("The saved run was started with different settings (proposer, delay, guardians, WQUAI or execution rule). Resume it with the same settings, or delete the progress file to start over.");
        }
        if (!same(cfg.resume.deployer, client.deployer)) {
            throw new Error(`The saved run was made by ${cfg.resume.deployer}, not ${client.deployer}. Use the same key to resume it.`);
        }
        progress.ctx = { ...cfg.resume.ctx };
        progress.steps = JSON.parse(JSON.stringify(cfg.resume.steps));
    }
    const save = () => {
        progress.updatedAt = new Date().toISOString();
        cfg.onProgress?.(JSON.parse(JSON.stringify(progress)));
    };

    const results: AmmStepResult[] = [];
    const gasPrice = await client.getGasPrice();
    const blockGasLimit = await client.getBlockGasLimit();
    const multiplier = cfg.deploy.gasMultiplier ?? 3;
    const ctx = progress.ctx;

    /** Runtime code a step leaves on chain: the contract, plus whatever its constructor or initialize creates. */
    const deposited = (step: DeployStep) => CIRCLESWAP_RUNTIME_BYTES[step.contract as keyof typeof CIRCLESWAP_RUNTIME_BYTES] + (step.nestedBytes ?? 0);

    /**
     * Prices every step from what can be known before anything exists: exactly (simulated against the node) when its
     * arguments are known, and projected from size, and labelled so, when they need an address an earlier step will create.
     * Every step is simulated again, exactly, right before it is sent.
     */
    const priceAll = async (): Promise<(AmmStepResult & { estimate: bigint })[]> => {
        const out: (AmmStepResult & { estimate: bigint })[] = [];
        const estimates: Record<string, bigint> = {};
        for (const step of flow.steps) {
            const art = load(step.contract);
            const args = step.args({});
            let r: AmmStepResult;
            if (!args.some(a => a === undefined)) {
                const sim = await deployContract(client, art, args, { ...cfg.deploy, label: step.label, broadcast: false, depositedBytes: deposited(step) });
                r = { ...sim, stepId: step.id, contract: step.contract };
            } else {
                const projected = projectGas(step, estimates);
                if (projected === null) throw new Error(`${step.label}: cannot be simulated and has no projection`);
                const initcode = (art.bytecode.length - 2) / 2 + 200; // the creation code plus a proxy's constructor arguments
                const gasLimit = creationGasLimit(projected, deposited(step), initcode, multiplier);
                r = { dryRun: true, projected: true, label: step.label, estimatedGas: projected, gasLimit, maxFee: gasLimit * gasPrice, stepId: step.id, contract: step.contract };
            }
            if (r.gasLimit > blockGasLimit) {
                throw new Error(`${step.label}: the gas limit ${r.gasLimit} is above the block gas limit ${blockGasLimit}, so the node would refuse it. Nothing was sent.`);
            }
            estimates[step.id] = r.estimatedGas;
            out.push({ ...r, estimate: r.estimatedGas });
        }
        return out;
    };

    // --- dry run: price everything, send nothing -----------------------------------------------------------------
    if (dry) {
        const priced = await priceAll();
        return { dryRun: true, fingerprint, steps: priced.map(({ estimate: _e, ...r }) => r), ctx: {} };
    }

    // --- broadcast: know the worst case before the first transaction, not halfway through --------------------------
    const remaining = new Set(flow.steps.filter(s => !progress.steps[s.id]?.done).map(s => s.id));
    if (remaining.size && !cfg.allowUnderfunded) {
        // A step needs its whole limit in hand when it is sent; what it does not use comes back. So the peak is the largest
        // (a step's limit + what the steps before it plausibly used, up to 2.5x their simulated gas, as one earlier deployment did).
        const priced = await priceAll();
        let spent = 0n;
        let peak = 0n;
        for (const p of priced) {
            if (!remaining.has(p.stepId)) continue;
            const need = (p.gasLimit + spent) * gasPrice;
            if (need > peak) peak = need;
            const plausible = (p.estimate * 250n) / 100n;
            spent += plausible < p.gasLimit ? plausible : p.gasLimit;
        }
        const balance = await client.getBalance(client.deployer);
        if (balance < peak) {
            throw new Error(
                `The deployer holds ${balance} wei, but this deployment can need up to ${peak} wei at its peak (a step's gas limit plus what the steps before it used). ` +
                    "Fund it, or pass --allow-underfunded to start anyway (each step checks its own funds before it is sent, and a stopped run resumes). Nothing was sent."
            );
        }
    }

    for (const step of flow.steps) {
        const art = load(step.contract);
        const saved = (progress.steps[step.id] ??= { done: false });
        const label = step.label;
        const resultKey = step.resultKey!;
        const log = cfg.deploy.log ?? (() => {});

        try {
            if (saved.done) {
                if (!saved.address) throw new Error(`${label}: recorded as done but with no address`);
                ctx[resultKey] = saved.address;
                await step.verify(ctx, reader); // the file is a hint; the chain is the authority
                log(`${label}: already deployed at ${saved.address} (verified again)`);
                results.push({ dryRun: false, stepId: step.id, contract: step.contract, label, estimatedGas: 0n, gasLimit: BigInt(saved.gasLimit ?? 0), maxFee: 0n, resumed: true, address: saved.address, txHash: saved.txHash });
                continue;
            }

            let result: AmmStepResult;
            if (saved.txHash) {
                // Sent by an earlier run that died while waiting. Finish THAT transaction; never pay for a second copy.
                log(`${label}: an earlier run sent ${saved.txHash}; waiting for it instead of sending again`);
                const settled = await settleCreate(client, art, saved.txHash, { ...cfg.deploy, label });
                result = { dryRun: false, stepId: step.id, contract: step.contract, label, estimatedGas: 0n, gasLimit: BigInt(saved.gasLimit ?? 0), maxFee: 0n, resumed: true, ...settled };
            } else {
                const args = step.args(ctx);
                if (args.some(a => a === undefined)) throw new Error(`${label}: an earlier step has not produced the address this one needs`);
                saved.constructorArgs = "0x" + new Interface(art.abi).encodeDeploy(args).slice(2);
                const deployed = await deployContract(client, art, args, {
                    ...cfg.deploy,
                    label,
                    broadcast: true,
                    depositedBytes: deposited(step),
                    onSent: txHash => {
                        saved.txHash = txHash;
                        save();
                    }
                });
                saved.gasLimit = deployed.gasLimit.toString();
                result = { ...deployed, stepId: step.id, contract: step.contract };
            }

            // Written before verifying: if verification fails the contract still exists and must not be forgotten.
            saved.address = result.address;
            saved.blockNumber = result.blockNumber;
            if (result.gasUsed !== undefined) saved.gasUsed = result.gasUsed.toString();
            ctx[resultKey] = result.address!;
            save();

            try {
                await step.verify(ctx, reader);
            } catch (e: any) {
                throw new Error(`${e.message} Do not use this deployment.`);
            }
            saved.done = true;
            save();
            results.push(result);
        } catch (e) {
            save();
            throw e;
        }
    }

    // --- the finished system, judged from the chain alone ---------------------------------------------------------
    const integrity = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
    const failed = integrity.checks.filter(c => c.level === "fail");
    if (integrity.verdict === "UNSAFE" || failed.length) {
        throw new Error(
            `The deployed system failed its integrity check (${integrity.verdict}): ${failed.map(c => `${c.title} (${c.detail})`).join("; ") || integrity.summary}. ` +
                "Do not use it or list it anywhere."
        );
    }

    let probePoolAddress: string | null | undefined;
    if (cfg.probe) {
        probePoolAddress = await probePoolPlacement(reader, ctx.AMM_FACTORY, cfg.probe.tokens, cfg.probe.checkPoolAddress);
    }

    return { dryRun: false, fingerprint, steps: results, ctx: { ...ctx }, probePoolAddress, integrity, progress: JSON.parse(JSON.stringify(progress)) };
}
