/**
 * Inspect and govern a deployed Circleswap AMM from the command line. Reads need no key; nothing is ever sent without
 * --broadcast and QUAI_PRIVATE_KEY. The proposer is usually a multisig, so the default for every write is to PRINT the
 * transaction to submit from it.
 *
 *   pnpm --filter contracts governance -- status   [--json]
 *   pnpm --filter contracts governance -- pending  [--json] [--lookback-blocks 200000] [--exit-code]
 *   pnpm --filter contracts governance -- propose <kind> [argument] [--broadcast]
 *   pnpm --filter contracts governance -- execute <operation id> [--salt 0x..] [--broadcast]
 *   pnpm --filter contracts governance -- cancel  <operation id> [--broadcast]
 *
 * `status` re-reads everything from the chain (code hashes, owners, delays, the pool beacon, every pool) and exits 2 if the
 * verdict is UNSAFE, so it can run from cron. `pending` lists what is queued on the timelock; with --exit-code it exits 3
 * while a sensitive operation (an upgrade that can reach funds) is waiting, so it can alert. Kinds for `propose`:
 *
 *   set-fee-to <address|none>      freeze-pools                   make-router-permanent    update-delay <days>
 *   upgrade-pools <implementation> new-pool-version <beacon>      make-factory-permanent
 *   upgrade-router <implementation> upgrade-factory <implementation>
 *   grant-role <proposer|canceller|executor> <address>            revoke-role <role> <address>
 *
 * Options: --network cyprus1|orchard (default cyprus1), --factory <addr> and --router <addr> (default: deployments/<network>.amm.json,
 * then deployed.ts). A queued operation can run once its delay has passed, by anyone unless execution was closed at deployment.
 */
import * as fs from "fs";
import * as path from "path";
import { QuaiChainClient, NETWORKS, isCyprus1QuaiAddress, type NetworkName } from "./lib/quaiClient";
import { readerOf } from "./lib/amm";
import { sendAndWait } from "./lib/deploy";
import { DEPLOYED } from "../../quai-service/src/registries/deployed";
import { inspectAmm, type IntegrityReport } from "../../quai-service/src/deploy/integrity";
import {
    OPS,
    scheduleTx,
    executeTx,
    cancelTx,
    listOperations,
    describeCall,
    type BatchFn,
    type GovOp,
    type GovTargets,
    type QueuedOp,
    type TimelockRole
} from "../../quai-service/src/deploy/governance";

const ROOT = path.resolve(__dirname, "..");
/** A node answers 10,000 blocks per log query; 200,000 blocks is about eleven days of zone blocks. */
const DEFAULT_LOOKBACK = 200_000;
const READ_ONLY_FROM = "0x0000000000000000000000000000000000000000";

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags = new Set<string>();
    const values: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            positional.push(a);
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            values[key] = next;
            i++;
        } else {
            flags.add(key);
        }
    }
    return { positional, flags, values };
}

/**
 * Leaves with a specific exit code without calling process.exit() in the middle of open network connections, which on Windows
 * can abort the process with a libuv assertion (and a wrong exit code). The code is set, the stack unwinds, the loop drains.
 */
class Exit extends Error {
    constructor(readonly exitCode: number, message = "") {
        super(message);
    }
}

function fail(msg: string, code = 1): never {
    throw new Exit(code, msg);
}

/** Where the deployed factory and router are recorded: flags, then the deploy record, then deployed.ts. */
function resolveTargets(network: NetworkName, values: Record<string, string>): { factory: string; router: string | null } {
    let factory: string | null = values.factory ?? null;
    let router: string | null = values.router ?? null;
    const recordPath = path.join(ROOT, "deployments", `${network}.amm.json`);
    if ((!factory || !router) && fs.existsSync(recordPath)) {
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        factory = factory ?? rec.contracts?.factory ?? null;
        router = router ?? rec.contracts?.router ?? null;
    }
    if (network === "cyprus1") {
        factory = factory ?? DEPLOYED.AMM_FACTORY;
        router = router ?? DEPLOYED.AMM_ROUTER;
    }
    if (!factory) fail(`no factory known for ${network}: pass --factory <address> (the deploy record and deployed.ts have none)`);
    for (const [what, a] of [["factory", factory], ["router", router]] as const) {
        if (a && !isCyprus1QuaiAddress(a)) fail(`${what} ${a} is not a Cyprus-1 Quai address`);
    }
    return { factory, router };
}

/** Plain batching over the node's JSON-RPC (one request per call; the node does not need a real batch). */
function batchOver(rpcUrl: string): BatchFn {
    return calls =>
        Promise.all(
            calls.map(async c => {
                try {
                    const res = await fetch(rpcUrl, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: c.method, params: c.params }),
                        signal: AbortSignal.timeout(30_000)
                    });
                    const json: any = await res.json();
                    if (json.error) return { ok: false as const, error: json.error.message };
                    return { ok: true as const, value: json.result };
                } catch (e: any) {
                    return { ok: false as const, error: String(e?.message ?? e) };
                }
            })
        );
}

function printReport(r: IntegrityReport) {
    const mark = { pass: "PASS", info: "info", warn: "WARN", fail: "FAIL" } as const;
    console.log(`Verdict: ${r.verdict}`);
    console.log(`  ${r.summary}\n`);
    const f = r.facts;
    console.log(`Owner:        ${f.owner ?? "?"}  (${f.ownerKind ?? "unknown"}${f.timelockDelaySeconds ? `, ${f.timelockDelaySeconds / 86_400}-day delay` : ""})`);
    console.log(`Factory impl: ${f.factoryImpl ?? "?"}`);
    console.log(`Router impl:  ${f.routerImpl ?? "?"}`);
    console.log(`Pool beacon:  ${f.pairBeacon ?? "?"}  (owner ${f.pairBeaconOwner ?? "?"})`);
    console.log(`Pool impl:    ${f.pairImpl ?? "?"}`);
    console.log(`Pools:        ${f.pools.checked} of ${f.pools.total} examined: ${f.pools.frozen} frozen, ${f.pools.governed} timelocked, ${f.pools.foreign} outside\n`);
    for (const c of r.checks) console.log(`  [${mark[c.level]}] ${c.title}${c.level === "pass" ? "" : `\n         ${c.detail}`}`);
}

const SENSITIVE = /UPGRADE EVERY POOL|Upgrade the router|Upgrade the factory|Transfer .* ownership/;

function printOp(o: QueuedOp, targets: GovTargets) {
    const text = describeCall(o.target, o.data, targets);
    const when = o.state === "WAITING" || o.state === "READY" ? (o.readyAt ? `runs at ${new Date(o.readyAt * 1000).toISOString()}` : "") : "";
    console.log(`  ${o.state.padEnd(9)} ${text}`);
    console.log(`            id ${o.id}${when ? `  ${when}` : ""}${o.salt ? "" : "  (salt unknown: only its proposer can run it)"}`);
}

async function main() {
    const { positional, flags, values } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = positional;
    if (!command || !["status", "pending", "propose", "execute", "cancel"].includes(command)) {
        fail("usage: governance <status|pending|propose|execute|cancel> ... (see the header of scripts/governance.ts)");
    }
    const network = (values.network ?? "cyprus1") as NetworkName;
    if (!(network in NETWORKS)) fail(`--network must be one of ${Object.keys(NETWORKS).join(", ")}`);
    const writes = command === "propose" || command === "execute" || command === "cancel";
    const broadcast = flags.has("broadcast");
    const privateKey = process.env.QUAI_PRIVATE_KEY;
    if (broadcast && !writes) fail("--broadcast only applies to propose, execute and cancel");
    if (broadcast && !privateKey) fail("--broadcast needs QUAI_PRIVATE_KEY in the environment (the proposer's key, or any funded key to execute)");

    const client = new QuaiChainClient(network, { privateKey, from: values.from ?? READ_ONLY_FROM });
    const chainId = await client.getChainId();
    if (chainId !== NETWORKS[network].chainId) fail(`RPC reports chain id ${chainId}, expected ${NETWORKS[network].chainId} for ${network}`);
    const reader = readerOf(client);
    const { factory, router } = resolveTargets(network, values);

    // Everything starts from the chain: who owns the factory, and is that really the compiled timelock?
    const report = await inspectAmm(reader, { factory, router });
    if (command === "status") {
        if (flags.has("json")) console.log(JSON.stringify(report, null, 2));
        else printReport(report);
        throw new Exit(report.verdict === "UNSAFE" ? 2 : 0);
    }
    if (report.facts.ownerKind !== "timelock" || !report.facts.owner) {
        fail(`the owner of ${factory} is not a Circleswap timelock (${report.facts.ownerKind ?? "unknown"}), so there is no public queue to govern through. Run \`status\` for the full reading.`);
    }
    const targets: GovTargets = { factory, router, timelock: report.facts.owner };
    const delay = report.facts.timelockDelaySeconds ?? 0;

    const lookback = Number(values["lookback-blocks"] ?? DEFAULT_LOOKBACK);
    const loadQueue = async () => listOperations(reader, batchOver(NETWORKS[network].rpc), targets.timelock, await client.getBlockNumber(), lookback);

    if (command === "pending") {
        const ops = await loadQueue();
        const active = ops.filter(o => o.state === "WAITING" || o.state === "READY");
        if (flags.has("json")) console.log(JSON.stringify(ops.map(o => ({ ...o, text: describeCall(o.target, o.data, targets) })), null, 2));
        else {
            console.log(`Timelock ${targets.timelock} (${delay / 86_400}-day delay): ${active.length} active, ${ops.length - active.length} finished or cancelled in the last ${lookback} blocks.\n`);
            for (const o of ops) printOp(o, targets);
        }
        const sensitive = active.filter(o => SENSITIVE.test(describeCall(o.target, o.data, targets)));
        if (flags.has("exit-code") && sensitive.length) throw new Exit(3);
        return;
    }

    // ---- writes: build the transaction, print it for the proposer, and send it only when asked ----------------------
    const send = async (label: string, tx: { to: string; data: string }) => {
        console.log(`\nTransaction to submit${broadcast ? "" : " from the proposer (e.g. through your multisig)"}:`);
        console.log(JSON.stringify({ to: tx.to, data: tx.data, value: "0" }, null, 2));
        if (!broadcast) {
            console.log("\nNothing was sent. Re-run with --broadcast (and QUAI_PRIVATE_KEY) to send it from this machine.");
            return;
        }
        const { txHash } = await sendAndWait(client, tx.to, tx.data, { label, broadcast: true, confirmations: 2, checkAddress: undefined });
        console.log(`\nSent and confirmed: ${txHash}`);
    };

    if (command === "propose") {
        const [kind, arg, arg2] = rest;
        if (!kind) fail("propose needs a kind (see the header of scripts/governance.ts)");
        const role = (r: string | undefined): TimelockRole => {
            if (r !== "proposer" && r !== "canceller" && r !== "executor") fail("the role must be proposer, canceller or executor");
            return r;
        };
        let op: GovOp;
        try {
            op =
                kind === "set-fee-to" ? OPS.setFeeTo(targets, !arg || arg === "none" ? null : arg)
                : kind === "freeze-pools" ? OPS.freezePools(targets)
                : kind === "make-router-permanent" ? OPS.makeRouterPermanent(targets)
                : kind === "make-factory-permanent" ? OPS.makeFactoryPermanent(targets)
                : kind === "upgrade-pools" ? OPS.upgradePools(targets, arg ?? "")
                : kind === "new-pool-version" ? OPS.newPoolVersion(targets, arg ?? "")
                : kind === "upgrade-router" ? OPS.upgradeRouter(targets, arg ?? "")
                : kind === "upgrade-factory" ? OPS.upgradeFactory(targets, arg ?? "")
                : kind === "update-delay" ? OPS.updateDelay(targets, Math.round(Number(arg) * 86_400))
                : kind === "grant-role" ? OPS.grantRole(targets, role(arg), arg2 ?? "")
                : kind === "revoke-role" ? OPS.revokeRole(targets, role(arg), arg2 ?? "")
                : fail(`unknown kind "${kind}"`);
        } catch (e: any) {
            fail(e.message);
        }
        const { tx, salt, id } = scheduleTx(targets.timelock, op, delay);
        console.log(`${op.label}\n  risk: ${op.risk}\n  ${op.description}\n`);
        console.log(`It will be public from the moment it is queued and can run ${delay / 86_400} day(s) later (about ${new Date(Date.now() + delay * 1000).toISOString()}), by anyone, unless a proposer or guardian cancels it first.`);
        console.log(`Operation id: ${id}\nSALT (keep it: needed to execute, and a multisig does not reveal it): ${salt}`);
        await send("schedule", tx);
        if (!broadcast) console.log(`Afterwards: governance -- execute ${id} --salt ${salt}`);
        return;
    }

    // execute / cancel: find the operation in the queue
    const [id] = rest;
    if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) fail(`${command} needs the 32-byte operation id (see \`pending\`)`);
    const op = (await loadQueue()).find(o => o.id.toLowerCase() === id.toLowerCase());
    if (!op) fail(`operation ${id} was not scheduled in the last ${lookback} blocks (try --lookback-blocks)`);
    console.log(`${op.state}: ${describeCall(op.target, op.data, targets)}`);
    if (command === "cancel") {
        if (op.state !== "WAITING" && op.state !== "READY") fail(`the operation is ${op.state}: only a waiting or ready one can be cancelled`);
        await send("cancel", cancelTx(targets.timelock, op.id));
        return;
    }
    if (op.state !== "READY") fail(`the operation is ${op.state}${op.state === "WAITING" && op.readyAt ? `; it can run at ${new Date(op.readyAt * 1000).toISOString()}` : ""}`);
    const salt = values.salt ?? op.salt;
    if (!salt) fail("the salt is unknown (the operation was scheduled through another contract): pass it with --salt");
    await send("execute", executeTx(targets.timelock, op.target, op.data, salt));
}

main().catch(e => {
    if (e instanceof Exit) {
        if (e.message) console.error(`\nError: ${e.message}`);
        process.exitCode = e.exitCode;
        return;
    }
    console.error(`\nFailed: ${e.message}`);
    process.exitCode = 1;
});
