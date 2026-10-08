import * as fs from "fs";
import * as path from "path";
import { deployAmm, readerOf, type AmmProgress } from "./amm";
import { ammRecord, renderDeployedTs } from "./record";
import { QuaiChainClient, assertCyprus1, NETWORKS, isCyprus1QuaiAddress, type NetworkName } from "./quaiClient";
import { TOKEN_REGISTRY } from "../../../quai-service/src/registries/tokens";
import { DEPLOYED } from "../../../quai-service/src/registries/deployed";
import { formatUnits } from "../../../quai-service/src/units";
import { assessAmmSettings, gatherAmmFacts, type AmmSettings } from "../../../quai-service/src/deploy/policy";

const ROOT = path.resolve(__dirname, "../..");
const DEPLOYED_TS = path.resolve(ROOT, "../quai-service/src/registries/deployed.ts");

function fail(msg: string): never {
    console.error(`\nError: ${msg}`);
    process.exit(1);
}

function addressList(raw: string | undefined): string[] {
    return (raw ?? "").split(",").map(x => x.trim()).filter(Boolean);
}

/**
 * `deploy-quai.ts --amm`: deploys the Circleswap AMM, independently of Qrb, the NFT and the farm. It is the same plan the
 * browser modal runs: a timelock that owns the factory and the router (both upgradable proxies), a deployer that keeps no
 * power, every step read back from the chain, and a final integrity check. The launch rules (a multisig proposer, a delay of
 * at least two days, the registry's WQUAI) are the modal's, from the same shared policy. Same safety properties as the rest of
 * the tooling: dry run unless --broadcast, addresses read off receipts, progress saved after every step (including the hash of
 * a transaction that was sent but not yet confirmed), --resume to finish an interrupted run.
 */
export async function runAmm(opts: {
    flags: Set<string>;
    values: Record<string, string>;
    network: NetworkName;
    privateKey?: string;
    broadcast: boolean;
}) {
    const { flags, values, network, privateKey, broadcast } = opts;
    if (!broadcast && !values.from && !privateKey) fail("set QUAI_PRIVATE_KEY, or pass --from <Cyprus-1 address> to simulate");
    if (values.owner !== undefined) fail("--owner is gone: the factory and router are owned by a timelock now. Name who may queue changes with --proposer <address>.");
    if (values["fee-to"] !== undefined) fail("--fee-to is gone: the protocol fee is an owner action, and the owner is the timelock. Deploy first, then queue it with `pnpm --filter contracts governance -- propose set-fee-to <address>`.");

    const resuming = flags.has("resume");
    if (resuming && !broadcast) fail("--resume continues a real deployment, so it needs --broadcast");
    const progressPath = path.join(ROOT, "deployments", `${network}.amm.progress.json`);
    let saved: AmmProgress | undefined;
    if (fs.existsSync(progressPath)) {
        if (resuming) saved = JSON.parse(fs.readFileSync(progressPath, "utf8"));
        else if (broadcast) fail(`${progressPath} exists: an earlier AMM deployment was interrupted. Re-run with --resume (and the same settings) to finish it, or delete that file to start over.`);
    } else if (resuming) {
        fail(`--resume needs ${progressPath}, which does not exist.`);
    }
    if (broadcast && !resuming && network === "cyprus1" && DEPLOYED.AMM_FACTORY !== null && !flags.has("force-redeploy")) {
        fail(`deployed.ts already lists an AMM factory at ${DEPLOYED.AMM_FACTORY}. A second one splits liquidity. Pass --force-redeploy if that is really intended.`);
    }

    const client = new QuaiChainClient(network, { privateKey, from: values.from });
    const chainId = await client.getChainId();
    if (chainId !== NETWORKS[network].chainId) fail(`RPC reports chain id ${chainId}, expected ${NETWORKS[network].chainId} for ${network}`);

    // --- settings ------------------------------------------------------------------------------------------------
    const mainnetBroadcast = network === "cyprus1" && broadcast;
    if (mainnetBroadcast && values["delay-days"] === undefined) {
        fail("--delay-days <1..30> is required for a mainnet deployment: it is how long every upgrade is public before it can run, and it should be chosen, not defaulted. 2 is the least that is sensible; several is safer.");
    }
    const delayDays = Number(values["delay-days"] ?? 2);
    if (!Number.isFinite(delayDays)) fail(`--delay-days ${values["delay-days"]} is not a number`);
    const proposer = values.proposer ?? (broadcast ? undefined : client.deployer);
    if (!proposer) fail("--proposer <address> is required: the account (use a multisig) that may queue and cancel owner actions. The deployer keeps no power.");
    const probeTokens = addressList(values["probe-tokens"]);
    if (probeTokens.length !== 0 && probeTokens.length !== 2) fail("--probe-tokens takes exactly two comma-separated token addresses");
    const settings: AmmSettings = {
        deployer: client.deployer,
        proposer,
        delaySeconds: Math.round(delayDays * 86_400),
        openExecution: !flags.has("closed-execution"),
        guardians: addressList(values.guardians),
        wquai: values.wquai ?? TOKEN_REGISTRY.WQUAI.address,
        probeTokens: probeTokens.length === 2 ? [probeTokens[0], probeTokens[1]] : [TOKEN_REGISTRY.Q0.address, TOKEN_REGISTRY.WQUAI.address]
    };
    for (const [what, a] of [["--proposer", settings.proposer], ["--wquai", settings.wquai], ...settings.guardians.map(g => ["--guardians", g] as const), ...settings.probeTokens.map(t => ["--probe-tokens", t] as const)] as const) {
        if (!isCyprus1QuaiAddress(a)) fail(`${what} ${a} is not a Cyprus-1 Quai address`);
    }

    const facts = await gatherAmmFacts(readerOf(client), settings);
    const verdict = assessAmmSettings(mainnetBroadcast, settings, facts, {
        allowAccountProposer: flags.has("allow-account-proposer"),
        allowShortDelay: flags.has("allow-short-delay"),
        allowCustomWquai: flags.has("allow-custom-wquai")
    });

    console.log(`Network:    ${network} (chain ${chainId})`);
    console.log(`Deployer:   ${client.deployer}  (${formatUnits(await client.getBalance(client.deployer), 18, 4)} QUAI)`);
    console.log(`Proposer:   ${settings.proposer}  (${facts.proposerIsContract ? "a contract" : "an ordinary account"}): may queue and cancel owner actions`);
    console.log(`Guardians:  ${settings.guardians.length ? settings.guardians.join(", ") + "  (may cancel, nothing else)" : "none"}`);
    console.log(`Delay:      ${settings.delaySeconds / 86_400} day(s): every upgrade, fee change or freeze is public this long before it can run`);
    console.log(`Execution:  ${settings.openExecution ? "open: anyone may run an operation once its delay has passed" : "closed: only the proposer can run a ready operation"}`);
    console.log(`WQUAI:      ${settings.wquai}${facts.wquai.symbol ? `  (${facts.wquai.symbol}, ${facts.wquai.decimals} decimals)` : ""}`);
    console.log(`Owner of the factory and the router: the new timelock. The deployer keeps no role, no key, no ownership.`);
    console.log(`Mode:       ${broadcast ? "BROADCAST" : "dry run (nothing will be sent)"}\n`);
    for (const w of verdict.warnings) console.log(`  warning: ${w}`);
    if (verdict.warnings.length) console.log("");
    if (verdict.errors.length) {
        const flag: Record<string, string> = { allowAccountProposer: "--allow-account-proposer", allowShortDelay: "--allow-short-delay", allowCustomWquai: "--allow-custom-wquai" };
        for (const e of verdict.errors) console.error(`  error: ${e.message}${e.ack ? ` (pass ${flag[e.ack]} only if that is really intended)` : ""}`);
        fail("Not sending anything: fix the above (or, where a flag is named, acknowledge it on purpose).");
    }

    const result = await deployAmm(client, {
        ...settings,
        probe: { tokens: settings.probeTokens, checkPoolAddress: assertCyprus1 },
        resume: saved,
        allowUnderfunded: flags.has("allow-underfunded"),
        onProgress: p => {
            fs.mkdirSync(path.dirname(progressPath), { recursive: true });
            fs.writeFileSync(progressPath, JSON.stringify(p, null, 2) + "\n");
        },
        deploy: {
            broadcast,
            gasMultiplier: 3,
            // Each step's address becomes an input of the next, and a reorg after the fact would orphan it.
            confirmations: 3,
            checkAddress: assertCyprus1,
            log: line => console.log("  " + line)
        }
    });

    console.log("\nMaximum cost (gas limit x current gas price). Unused gas is refunded; a transaction that runs out of gas or reverts uses its whole limit.");
    console.log("Real creation gas on Quai has ranged from about 0.4x to 2.5x the simulator's figure, so the limits are set wide:");
    let total = 0n;
    for (const r of result.steps) {
        total += r.maxFee;
        const note = r.projected ? "  (projected from size; simulated exactly right before it is sent)" : r.resumed ? "  (already deployed)" : "";
        console.log(`  ${r.label.slice(0, 58).padEnd(60)} est ${String(r.estimatedGas).padStart(8)}  limit ${String(r.gasLimit).padStart(9)}  <= ${formatUnits(r.maxFee, 18, 2)} QUAI${note}`);
    }
    console.log(`  ${"total".padEnd(60)} <= ${formatUnits(total, 18, 2)} QUAI`);

    if (result.dryRun) {
        console.log("\nDry run only: nothing was sent. Re-run with --broadcast to deploy.");
        console.log("Also run `pnpm --filter contracts probe:amm` to simulate the whole deployment on the live node and check every nested creation lands in-zone.");
        return;
    }

    const ctx = result.ctx;
    console.log("\nDeployed (every address read from its receipt, and every claim read back from the chain):");
    console.log(`  Timelock (owner)          ${ctx.AMM_TIMELOCK}`);
    console.log(`  CircleswapFactory (proxy) ${ctx.AMM_FACTORY}   -> implementation ${ctx.AMM_FACTORY_IMPL}`);
    console.log(`  CircleswapRouter (proxy)  ${ctx.AMM_ROUTER}   -> implementation ${ctx.AMM_ROUTER_IMPL}`);
    console.log(`  Pool beacon               ${ctx.AMM_PAIR_BEACON}   (owned by the factory; freezable)`);
    if (result.probePoolAddress) console.log(`  A pool created now would land at ${result.probePoolAddress} (a valid Cyprus-1 address)`);
    if (result.integrity) {
        const c = result.integrity.checks;
        console.log(`  Integrity: ${result.integrity.verdict}: ${c.filter(x => x.level === "pass").length} checks pass, ${c.filter(x => x.level === "info").length} notes. ${result.integrity.summary}`);
    }

    fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
    const recordPath = path.join(ROOT, "deployments", `${network}.amm.json`);
    fs.writeFileSync(recordPath, JSON.stringify(ammRecord(network, chainId, client.deployer, settings, result, result.progress!), null, 2) + "\n");
    console.log(`\nWrote ${recordPath}`);

    if (network === "cyprus1") {
        fs.writeFileSync(DEPLOYED_TS, renderDeployedTs({ ...DEPLOYED, AMM_FACTORY: ctx.AMM_FACTORY, AMM_ROUTER: ctx.AMM_ROUTER }));
        console.log(`Updated ${DEPLOYED_TS}. Rebuild quai-service and the app: the Circleswap DEX then appears in the pool modal and swap.`);
    }
    if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);

    console.log("\nNext:");
    console.log("  1. pnpm --filter contracts governance -- status          re-reads everything from the chain and prints the verdict");
    console.log("  2. create the first pools from the app's Create Pool modal (choose Circleswap), seeded at the market ratio");
    console.log("  3. when the pool code is final, queue the one-way freeze (see DEPLOY.md, \"After the AMM is live\"):");
    console.log("       pnpm --filter contracts governance -- propose freeze-pools");
}
