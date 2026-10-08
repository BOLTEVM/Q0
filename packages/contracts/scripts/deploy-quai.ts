/**
 * Deploys the Circleswap contracts to Quai (Cyprus-1): Qrb (ERC-20), QrbArtifactNFT, and optionally the
 * CircleswapMasterChef farm with its pools.
 *
 *   pnpm --filter contracts deploy:quai -- [options]
 *
 * Default is a DRY RUN: every constructor is simulated against the live node and the maximum cost is
 * printed; nothing is signed or sent. Pass --broadcast to deploy. The signing key is read from the
 * QUAI_PRIVATE_KEY environment variable only, and is never printed or written anywhere.
 *
 * Every deployed address is read off that contract's own transaction receipt (full 20-byte address,
 * checked to be a Cyprus-1 address, with code on-chain matching the compiled runtime). No address is ever
 * derived from sender and nonce.
 *
 * Options:
 *   --network cyprus1|orchard   default cyprus1
 *   --from <addr>               simulate as this Cyprus-1 address when no key is set (dry run only)
 *   --owner <addr>              owner of every contract (default: deployer)
 *   --royalty-receiver <addr>   NFT royalty receiver (default: owner)
 *   --artwork-uri <uri>         Arweave URI (ar://<txid> or https://arweave.net/<txid>); default: the
 *                               uri in deployments/artwork.json or $ARTWORK_URI
 *   --artwork-file <path>       local file the URI must serve byte for byte (default: app QgoGIF.gif)
 *   --mint-to <addr>            after deploying, mint 1.0 QRB and the 1-of-1 NFT to this address
 *   --farm                      also deploy the farm; needs REWARD_A_PER_SECOND and REWARD_B_PER_SECOND
 *                               (wei of BDELTA / Q0 per second)
 *   --no-pools                  with --farm: skip adding the FARM_REGISTRY pools (they are added in registry
 *                               order by default so pool ids match the app)
 *   --qrb <addr>                farm only: deploy just the farm against this existing Qrb
 *   --broadcast                 actually send transactions
 *   --resume                    continue an interrupted --broadcast run from deployments/<network>.progress.json:
 *                               contracts already deployed are re-verified and reused, and only what is left is
 *                               done (pools already added and tokens already minted are skipped). Pass the same
 *                               other options as the original run.
 *   --force-redeploy            allow deploying again although deployed.ts already lists a Qrb
 *
 * Circleswap AMM (timelock + factory + router), a separate run from the above, and the same plan as the browser modal:
 *   deploy:quai -- --amm --proposer <addr> --delay-days <1..30> [--guardians <a,b>] [--broadcast] [--resume]
 *   The factory and router are upgradable proxies OWNED BY A TIMELOCK: every upgrade, fee change or freeze is public for the
 *   delay before it can run, and the deployer keeps no power. --proposer (use a multisig) may queue and cancel; optional
 *   --guardians may only cancel; --closed-execution lets only the proposer run a ready operation (default: anyone may).
 *   --wquai and --probe-tokens override the registry's WQUAI and the Q0/WQUAI pair used to prove pools land in-zone.
 *   On mainnet a deployment is refused unless the proposer is a contract, the delay is at least 2 days and WQUAI is the
 *   registry's (--allow-account-proposer / --allow-short-delay / --allow-custom-wquai acknowledge each on purpose).
 *   Progress, including the hash of a transaction sent but not yet confirmed, goes to deployments/<network>.amm.progress.json.
 *   Afterwards use `governance` (scripts/governance.ts) to inspect it and to queue or run owner actions. See DEPLOY.md.
 *
 * Progress is written to deployments/<network>.progress.json after every step, so a failure part-way (after
 * gas has been spent) never loses an address.
 */
import * as fs from "fs";
import * as path from "path";
import { verifyArtwork } from "./lib/artwork";
import { deployCircleswap, type CircleswapConfig, type DeployProgress } from "./lib/circleswap";
import { deploymentRecord, renderDeployedTs } from "./lib/record";
import { runAmm } from "./lib/ammCli";
import { QuaiChainClient, assertCyprus1, NETWORKS, isCyprus1QuaiAddress, type NetworkName } from "./lib/quaiClient";
import { TOKEN_REGISTRY } from "../../quai-service/src/registries/tokens";
import { FARM_REGISTRY } from "../../quai-service/src/registries/farms";
import { DEPLOYED } from "../../quai-service/src/registries/deployed";
import { formatUnits } from "../../quai-service/src/units";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYED_TS = path.resolve(ROOT, "../quai-service/src/registries/deployed.ts");
const DEFAULT_ARTWORK_FILE = path.resolve(ROOT, "../../apps/stats-app/public/QgoGIF.gif");
const PLACEHOLDER_URI = "https://arweave.net/" + "A".repeat(43);

function parseArgs(argv: string[]) {
    const flags = new Set<string>();
    const values: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            values[key] = next;
            i++;
        } else {
            flags.add(key);
        }
    }
    return { flags, values };
}

function fail(msg: string): never {
    console.error(`\nError: ${msg}`);
    process.exit(1);
}

async function main() {
    const { flags, values } = parseArgs(process.argv.slice(2));
    const broadcast = flags.has("broadcast");
    const network = (values.network ?? "cyprus1") as NetworkName;
    if (!(network in NETWORKS)) fail(`--network must be one of ${Object.keys(NETWORKS).join(", ")}`);

    const privateKey = process.env.QUAI_PRIVATE_KEY;
    if (broadcast && !privateKey) fail("--broadcast needs QUAI_PRIVATE_KEY in the environment");
    if (!privateKey && !values.from) fail("set QUAI_PRIVATE_KEY, or pass --from <Cyprus-1 address> to simulate");

    if (flags.has("amm")) {
        await runAmm({ flags, values, network, privateKey, broadcast });
        return;
    }

    const resuming = flags.has("resume");
    if (resuming && !broadcast) fail("--resume continues a real deployment, so it needs --broadcast");
    const progressPath = path.join(ROOT, "deployments", `${network}.progress.json`);
    let savedProgress: DeployProgress | undefined;
    if (fs.existsSync(progressPath)) {
        if (resuming) {
            savedProgress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
        } else if (broadcast) {
            fail(`${progressPath} exists: an earlier deployment was interrupted. Re-run with --resume to finish it (nothing is deployed twice), or delete that file if you really want to start over.`);
        }
    } else if (resuming) {
        fail(`--resume needs ${progressPath}, which does not exist.`);
    }

    if (broadcast && !resuming && network === "cyprus1" && DEPLOYED.QRB !== null && !flags.has("force-redeploy") && !values.qrb) {
        fail(`deployed.ts already lists Qrb at ${DEPLOYED.QRB}. Qrb is 1-of-1; deploying again creates a second one. Pass --force-redeploy if that is really intended.`);
    }

    const client = new QuaiChainClient(network, { privateKey, from: values.from });
    const chainId = await client.getChainId();
    if (chainId !== NETWORKS[network].chainId) {
        fail(`RPC reports chain id ${chainId}, expected ${NETWORKS[network].chainId} for ${network}`);
    }

    // Artwork: must be Arweave, and must serve exactly the local file. A dry run may use a placeholder
    // URI to price the deployment, but a broadcast never does.
    const artworkFile = values["artwork-file"] ?? DEFAULT_ARTWORK_FILE;
    const recorded = fs.existsSync(path.join(ROOT, "deployments/artwork.json"))
        ? JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/artwork.json"), "utf8")).uri
        : undefined;
    let artworkURI: string | undefined = values["artwork-uri"] ?? process.env.ARTWORK_URI ?? recorded;
    if (!artworkURI && !broadcast && !values.qrb) {
        artworkURI = PLACEHOLDER_URI;
        console.warn("WARNING: no artwork URI given; simulating with a placeholder. A broadcast requires a real Arweave URI.\n");
    }
    if (values.qrb) {
        artworkURI = artworkURI ?? DEPLOYED.ARTWORK_URI ?? PLACEHOLDER_URI; // unused in farm-only mode
    } else if (!artworkURI) {
        fail("no artwork URI: upload with scripts/upload-artwork.ts, or pass --artwork-uri / set ARTWORK_URI");
    } else if (artworkURI !== PLACEHOLDER_URI) {
        console.log(`Verifying ${artworkURI} serves ${artworkFile} ...`);
        const check = await verifyArtwork(artworkURI, artworkFile);
        console.log(`  ok: ${check.bytes} bytes, sha256 ${check.sha256}\n`);
    }

    const owner = values.owner ?? client.deployer;
    if (!isCyprus1QuaiAddress(owner)) fail(`--owner ${owner} is not a Cyprus-1 Quai address`);
    const royaltyReceiver = values["royalty-receiver"] ?? owner;

    let farm: CircleswapConfig["farm"];
    if (flags.has("farm")) {
        if (!process.env.REWARD_A_PER_SECOND || !process.env.REWARD_B_PER_SECOND) {
            fail("--farm needs REWARD_A_PER_SECOND and REWARD_B_PER_SECOND (wei of BDELTA / Q0 per second)");
        }
        farm = {
            rewardTokenA: TOKEN_REGISTRY.BDELTA.address,
            rewardTokenB: TOKEN_REGISTRY.Q0.address,
            rewardAPerSecond: BigInt(process.env.REWARD_A_PER_SECOND),
            rewardBPerSecond: BigInt(process.env.REWARD_B_PER_SECOND),
            pools: flags.has("no-pools")
                ? undefined
                : FARM_REGISTRY.map(p => ({ allocPoint: p.allocPoint, lpToken: p.stakeToken.address }))
        };
        if (!flags.has("no-pools")) {
            // Pool ids must equal registry pids or the app stakes into the wrong pool.
            FARM_REGISTRY.forEach((p, i) => {
                if (p.pid !== i) fail(`FARM_REGISTRY pid ${p.pid} is at index ${i}; pool ids must be 0..n-1 in order`);
            });
        }
    } else if (flags.has("no-pools") || values.qrb) {
        fail("--no-pools and --qrb need --farm");
    }

    console.log(`Network:   ${network} (chain ${chainId})`);
    console.log(`Deployer:  ${client.deployer}  (${formatUnits(await client.getBalance(client.deployer), 18, 4)} QUAI)`);
    console.log(`Owner:     ${owner}`);
    if (!values.qrb) console.log(`Royalty:   ${royaltyReceiver}`);
    console.log(`Artwork:   ${artworkURI}`);
    console.log(`Mode:      ${broadcast ? "BROADCAST" : "dry run (nothing will be sent)"}\n`);

    const result = await deployCircleswap(client, {
        owner,
        royaltyReceiver,
        artworkURI: artworkURI!,
        mintTo: values["mint-to"],
        farm,
        existingQrb: values.qrb,
        resume: savedProgress && { qrb: savedProgress.qrb, nft: savedProgress.nft, farm: savedProgress.farm },
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

    const rows = [result.qrb, result.nft, result.farm].filter(Boolean) as NonNullable<typeof result.qrb>[];
    console.log("\nMaximum cost (gas limit x current gas price; unused gas is refunded):");
    let total = 0n;
    for (const r of rows) {
        total += r.maxFee;
        const note = r.projected ? "  (projected from size; simulated exactly right before it is sent)" : "";
        console.log(`  ${r.label.padEnd(22)} est ${r.estimatedGas} gas  limit ${r.gasLimit}  <= ${formatUnits(r.maxFee, 18, 2)} QUAI${note}`);
    }
    console.log(`  ${"total".padEnd(22)} <= ${formatUnits(total, 18, 2)} QUAI`);

    if (result.dryRun) {
        console.log("\nDry run only: nothing was sent. Re-run with --broadcast to deploy.");
        return;
    }

    console.log("\nDeployed (addresses read from receipts):");
    if (result.qrb) console.log(`  Qrb              ${result.qrb.address}`);
    if (result.nft) console.log(`  QrbArtifactNFT   ${result.nft.address}`);
    if (result.farm) console.log(`  MasterChef       ${result.farm.address}`);

    fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
    const recordPath = path.join(ROOT, "deployments", `${network}.json`);
    fs.writeFileSync(recordPath, JSON.stringify(deploymentRecord(network, chainId, client.deployer, artworkURI!, result), null, 2) + "\n");
    console.log(`\nWrote ${recordPath}`);

    if (network === "cyprus1") {
        const qrbAddr = result.qrb?.address ?? result.qrbAddress ?? DEPLOYED.QRB;
        const nftAddr = result.nft?.address ?? DEPLOYED.QRB_NFT;
        if (!qrbAddr || !nftAddr) {
            console.log("deployed.ts not updated: it needs both a Qrb and an NFT address.");
        } else {
            fs.writeFileSync(
                DEPLOYED_TS,
                renderDeployedTs({
                    QRB: qrbAddr,
                    QRB_NFT: nftAddr,
                    MASTERCHEF: result.farm?.address ?? DEPLOYED.MASTERCHEF,
                    AMM_FACTORY: DEPLOYED.AMM_FACTORY,
                    AMM_ROUTER: DEPLOYED.AMM_ROUTER,
                    ARTWORK_URI: result.qrb ? artworkURI! : DEPLOYED.ARTWORK_URI ?? artworkURI!
                })
            );
            console.log(`Updated ${DEPLOYED_TS}. Rebuild quai-service and the app to pick the addresses up.`);
        }
    }
    if (result.farm && flags.has("no-pools")) {
        console.log("\nThe farm has no pools: call addPool from the owner in registry order (pids 0..n-1) before opening it.");
    }
    // Everything is done and recorded; the progress file has served its purpose.
    if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
    console.log("Next: fund the farm with BDELTA and Q0 reward inventory; it pays rewards only from its own balance.");
}

main().catch(e => {
    console.error(`\nFailed: ${e.message}`);
    const dir = path.join(ROOT, "deployments");
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (f.endsWith(".progress.json")) {
            console.error(`\nPart of the deployment succeeded and is saved in deployments/${f}. Fix the problem above, then re-run the same command with --resume: nothing already deployed, added or minted is repeated.`);
        }
    }
    process.exit(1);
});
