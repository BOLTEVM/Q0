/**
 * Live pre-flight for the Circleswap AMM on Quai Cyprus-1. Sends NOTHING and needs no funds or key.
 *
 *   pnpm --filter contracts probe:amm
 *
 * It simulates (quai_call / quai_estimateGas) a throwaway contract whose constructor does exactly what the
 * factory does at run time: deploy the factory (which deploys the pool implementation), then create pools as
 * minimal-proxy clones. Quai grinds contract addresses into the creator's zone, so the questions are:
 *
 *   1. Do all nested creations (factory, implementation, clones) land on Cyprus-1 Quai addresses?
 *   2. Does a clone initialise and work (the probe reads the results back)?
 *   3. What does it cost: deploying the factory, and creating a pool?
 *
 * The probe reverts on purpose in its last mode, returning the addresses in the revert data.
 */
import * as crypto from "crypto";
import { AbiCoder, Interface } from "ethers";
import { Wallet, getZoneForAddress, isQiAddress, Zone } from "quais";
import { loadArtifact } from "./lib/artifacts";
import { NETWORKS, grindCreationData, isCyprus1QuaiAddress } from "./lib/quaiClient";
import { TOKEN_REGISTRY } from "../../quai-service/src/registries/tokens";

const RPC = NETWORKS.cyprus1.rpc;

async function rpc(method: string, params: unknown[]): Promise<{ result?: any; error?: { message: string; data?: string } }> {
    const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60_000)
    });
    return res.json() as any;
}

/** Any Cyprus-1 Quai address will do as the simulated sender: nothing is signed or sent. */
function throwawaySender(): string {
    for (let i = 0; i < 200_000; i++) {
        const w = new Wallet("0x" + crypto.randomBytes(32).toString("hex"));
        if (isCyprus1QuaiAddress(w.address)) return w.address;
    }
    throw new Error("could not find a Cyprus-1 address");
}

async function main() {
    const probe = loadArtifact("AmmProbe");
    const iface = new Interface(probe.abi);
    const from = throwawaySender();
    const { Q0, WQUAI, BOSS } = TOKEN_REGISTRY;
    const nonce = parseInt((await rpc("quai_getTransactionCount", [from, "pending"])).result, 16);

    const initcode = (mode: number) =>
        grindCreationData(from, nonce, probe.bytecode + iface.encodeDeploy([mode, Q0.address, WQUAI.address, BOSS.address]).slice(2)).data;

    console.log(`Simulating as ${from} on ${RPC}\n`);

    // ---- cost: factory alone, then factory + one pool
    const gas: number[] = [];
    for (const mode of [0, 1]) {
        const r = await rpc("quai_estimateGas", [{ from, data: initcode(mode) }]);
        if (r.error) throw new Error(`mode ${mode} simulation failed: ${r.error.message}`);
        gas.push(parseInt(r.result, 16));
    }
    const gasPrice = BigInt((await rpc("quai_gasPrice", [])).result);
    const perPool = gas[1] - gas[0];
    const quai = (g: number) => (Number((BigInt(g) * gasPrice) / 10n ** 14n) / 10_000).toFixed(2);
    console.log(`Deploy the factory (+ pool implementation): ~${gas[0]} gas`);
    console.log(`Create one pool (clone + initialize):       ~${perPool} gas`);
    console.log(`  at today's gas price: factory ~${quai(gas[0])} QUAI, pool ~${quai(perPool)} QUAI`);
    console.log("  These are simulator ESTIMATES. Quai's simulator understates creation gas (real usage has run ~2.5x the estimate on");
    console.log("  earlier deployments) and is not even monotonic for nested creations, so treat them as rough. The modal simulates every");
    console.log("  real transaction right before you sign it and shows the actual maximum fee.\n");

    // ---- placement: create two pools and read the addresses back from the revert data
    const r = await rpc("quai_call", [{ from, data: initcode(2) }, "latest"]);
    const data: string | undefined = r.error?.data ?? (typeof r.result === "string" ? r.result : undefined);
    if (!data || !data.startsWith(iface.getError("Probe")!.selector)) {
        throw new Error(`the probe did not return its addresses (${r.error?.message ?? "no revert data"}). Raw: ${JSON.stringify(r).slice(0, 300)}`);
    }
    const [factory, implementation, pairOne, pairTwo] = AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "address", "address"],
        "0x" + data.slice(10)
    );
    let allGood = true;
    for (const [label, addr] of [["factory", factory], ["pool implementation", implementation], ["pool #1 (clone)", pairOne], ["pool #2 (clone)", pairTwo]] as const) {
        const ok = getZoneForAddress(addr) === Zone.Cyprus1 && !isQiAddress(addr);
        allGood &&= ok;
        console.log(`${label.padEnd(22)} ${addr}  ${ok ? "Cyprus-1 Quai address" : "WRONG ZONE"}`);
    }
    if (pairOne === pairTwo) throw new Error("both pools got the same address");
    console.log(allGood ? "\nPASS: every nested creation landed on Cyprus-1, and clones initialised." : "\nFAIL: a creation landed outside Cyprus-1.");
    process.exit(allGood ? 0 : 1);
}

main().catch(e => {
    console.error(`\nProbe failed: ${e.message}`);
    process.exit(1);
});
