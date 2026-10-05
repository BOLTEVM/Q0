import * as fs from "fs";
import * as path from "path";
import { deployAmm, type AmmProgress } from "./amm";
import { ammRecord, renderDeployedTs } from "./record";
import { QuaiChainClient, assertCyprus1, NETWORKS, isCyprus1QuaiAddress, type NetworkName } from "./quaiClient";
import { TOKEN_REGISTRY } from "../../../quai-service/src/registries/tokens";
import { DEPLOYED } from "../../../quai-service/src/registries/deployed";
import { formatUnits } from "../../../quai-service/src/units";

const ROOT = path.resolve(__dirname, "../..");
const DEPLOYED_TS = path.resolve(ROOT, "../quai-service/src/registries/deployed.ts");

function fail(msg: string): never {
    console.error(`\nError: ${msg}`);
    process.exit(1);
}

/**
 * `deploy-quai.ts --amm`: deploys the Circleswap AMM (factory + router), independently of Qrb, the NFT and the
 * farm. Same safety properties as the rest of the tooling: dry run unless --broadcast, addresses read off
 * receipts, progress saved after every step, --resume to finish an interrupted run.
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

    const resuming = flags.has("resume");
    if (resuming && !broadcast) fail("--resume continues a real deployment, so it needs --broadcast");
    const progressPath = path.join(ROOT, "deployments", `${network}.amm.progress.json`);
    let saved: AmmProgress | undefined;
    if (fs.existsSync(progressPath)) {
        if (resuming) saved = JSON.parse(fs.readFileSync(progressPath, "utf8"));
        else if (broadcast) fail(`${progressPath} exists: an earlier AMM deployment was interrupted. Re-run with --resume to finish it, or delete that file to start over.`);
    } else if (resuming) {
        fail(`--resume needs ${progressPath}, which does not exist.`);
    }
    if (broadcast && !resuming && network === "cyprus1" && DEPLOYED.AMM_FACTORY !== null && !flags.has("force-redeploy")) {
        fail(`deployed.ts already lists an AMM factory at ${DEPLOYED.AMM_FACTORY}. A second one splits liquidity. Pass --force-redeploy if that is really intended.`);
    }

    const client = new QuaiChainClient(network, { privateKey, from: values.from });
    const chainId = await client.getChainId();
    if (chainId !== NETWORKS[network].chainId) fail(`RPC reports chain id ${chainId}, expected ${NETWORKS[network].chainId} for ${network}`);

    const owner = values.owner ?? client.deployer;
    if (!isCyprus1QuaiAddress(owner)) fail(`--owner ${owner} is not a Cyprus-1 Quai address`);
    const feeTo = values["fee-to"];
    if (feeTo && !isCyprus1QuaiAddress(feeTo)) fail(`--fee-to ${feeTo} is not a Cyprus-1 Quai address`);

    console.log(`Network:   ${network} (chain ${chainId})`);
    console.log(`Deployer:  ${client.deployer}  (${formatUnits(await client.getBalance(client.deployer), 18, 4)} QUAI)`);
    console.log(`Owner:     ${owner}`);
    console.log(`WQUAI:     ${TOKEN_REGISTRY.WQUAI.address}`);
    console.log(`Protocol fee: ${feeTo ? `ON, LP tokens for one sixth of the fee go to ${feeTo}` : "off (can be turned on later by the owner)"}`);
    console.log(`Mode:      ${broadcast ? "BROADCAST" : "dry run (nothing will be sent)"}\n`);

    const result = await deployAmm(client, {
        owner,
        wquai: TOKEN_REGISTRY.WQUAI.address,
        feeTo,
        probeTokens: [TOKEN_REGISTRY.Q0.address, TOKEN_REGISTRY.WQUAI.address],
        checkPoolAddress: assertCyprus1,
        resume: saved && { factory: saved.factory, router: saved.router },
        onProgress: p => {
            fs.mkdirSync(path.dirname(progressPath), { recursive: true });
            fs.writeFileSync(progressPath, JSON.stringify(p, null, 2) + "\n");
        },
        deploy: {
            broadcast,
            gasMultiplier: 3,
            confirmations: network === "orchard" ? 3 : 1,
            checkAddress: assertCyprus1,
            log: line => console.log("  " + line)
        }
    });

    console.log("\nMaximum cost (gas limit x current gas price; unused gas is refunded):");
    let total = 0n;
    for (const r of [result.factory, result.router]) {
        total += r.maxFee;
        const note = r.projected ? "  (projected from size; simulated exactly right before it is sent)" : r.resumed ? "  (already deployed)" : "";
        console.log(`  ${r.label.padEnd(20)} est ${r.estimatedGas} gas  limit ${r.gasLimit}  <= ${formatUnits(r.maxFee, 18, 2)} QUAI${note}`);
    }
    console.log(`  ${"total".padEnd(20)} <= ${formatUnits(total, 18, 2)} QUAI`);

    if (result.dryRun) {
        console.log("\nDry run only: nothing was sent. Re-run with --broadcast to deploy.");
        console.log("Also run `pnpm --filter contracts probe:amm` to check, against the live node, that pools land in-zone.");
        return;
    }

    console.log("\nDeployed (addresses read from receipts):");
    console.log(`  CircleswapFactory  ${result.factory.address}`);
    console.log(`  CircleswapRouter   ${result.router.address}`);
    if (result.probePoolAddress) console.log(`  A pool created now would land at ${result.probePoolAddress} (a valid Cyprus-1 address)`);

    fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
    const recordPath = path.join(ROOT, "deployments", `${network}.amm.json`);
    fs.writeFileSync(recordPath, JSON.stringify(ammRecord(network, chainId, client.deployer, owner, result), null, 2) + "\n");
    console.log(`\nWrote ${recordPath}`);

    if (network === "cyprus1") {
        fs.writeFileSync(
            DEPLOYED_TS,
            renderDeployedTs({ ...DEPLOYED, AMM_FACTORY: result.factory.address!, AMM_ROUTER: result.router.address! })
        );
        console.log(`Updated ${DEPLOYED_TS}. Rebuild quai-service and the app: the Circleswap DEX then appears in the pool modal and swap.`);
    }
    if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
    console.log("\nNext: create pools from the app's Create Pool modal (choose Circleswap), or add a Circleswap LP token to the farm with addPool.");
}
