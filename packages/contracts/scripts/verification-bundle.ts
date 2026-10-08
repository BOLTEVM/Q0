/**
 * Collects what an explorer needs to verify the source of every contract a Circleswap AMM deployment made, from the deployment
 * record written by `deploy:quai -- --amm --broadcast` (deployments/<network>.amm.json).
 *
 *   pnpm --filter contracts verify:bundle [--network cyprus1]
 *
 * Writes deployments/verification/<network>/ with: the compiler's standard-JSON input (one file per compilation), a manifest of
 * every contract (address, contract name, constructor arguments, compiler settings), and a README. Nothing is sent anywhere:
 * you upload these to the explorer yourself.
 *
 * Two things to know, because they are why a naive verification fails:
 *  - On Quai a creation transaction's input is the compiled bytecode, the constructor arguments, and a 4-byte salt that was ground
 *    so the address lands in Cyprus-1. The salt is the last 4 bytes of the creation transaction's input and is not a constructor
 *    argument: an explorer that compares inputs must ignore it.
 *  - The deployed code differs from a plain recompile only where the compiler put immutables (the UUPS `__self` address, a beacon
 *    proxy's beacon), which is expected.
 */
import * as fs from "fs";
import * as path from "path";
import { AbiCoder } from "ethers";

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(ROOT, "artifacts");

export interface VerificationItem {
    label: string;
    address: string;
    /** Fully qualified: contracts/amm/CircleswapFactory.sol:CircleswapFactory */
    contract: string;
    /** ABI-encoded constructor arguments, 0x-prefixed ("0x" when there are none). */
    constructorArgs: string;
    creationTx?: string;
    note?: string;
}

export interface Bundle {
    network: string;
    compiler: string;
    settings: unknown;
    items: (VerificationItem & { standardInput: string })[];
    /** build-info id -> its standard-JSON input */
    inputs: Record<string, unknown>;
}

function findFile(dir: string, fileName: string): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const hit = findFile(full, fileName);
            if (hit) return hit;
        } else if (e.name === fileName) return full;
    }
    return null;
}

/** The compilation a contract came from: its fully qualified name and the build-info that holds its sources and settings. */
function compilationOf(name: string, artifactsRoot: string = ARTIFACTS) {
    const artifactPath = findFile(artifactsRoot, `${name}.json`);
    if (!artifactPath) throw new Error(`No compiled artifact for ${name}. Run \`pnpm --filter contracts compile\`.`);
    const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const dbgPath = artifactPath.replace(/\.json$/, ".dbg.json");
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    const infoPath = path.resolve(path.dirname(dbgPath), String(dbg.buildInfo).split(String.fromCharCode(92)).join("/"));
    return { fqn: `${art.sourceName}:${art.contractName}`, infoPath, infoId: path.basename(infoPath, ".json") };
}

/** Builds the bundle for an AMM deployment record (the shape `ammRecord` writes). */
export function buildBundle(record: any, artifactsRoot: string = ARTIFACTS): Bundle {
    const c = record.contracts ?? {};
    const tx = record.transactions ?? {};
    const coder = AbiCoder.defaultAbiCoder();
    const want: (Omit<VerificationItem, "contract"> & { name: string })[] = [
        { label: "Timelock", name: "CircleswapTimelock", address: c.timelock, constructorArgs: tx.timelock?.constructorArgs ?? "0x", creationTx: tx.timelock?.txHash },
        { label: "Factory implementation", name: "CircleswapFactory", address: c.factoryImplementation, constructorArgs: tx.factoryImpl?.constructorArgs ?? "0x", creationTx: tx.factoryImpl?.txHash },
        { label: "Factory proxy", name: "ERC1967Proxy", address: c.factory, constructorArgs: tx.factoryProxy?.constructorArgs ?? "0x", creationTx: tx.factoryProxy?.txHash },
        { label: "Router implementation", name: "CircleswapRouter", address: c.routerImplementation, constructorArgs: tx.routerImpl?.constructorArgs ?? "0x", creationTx: tx.routerImpl?.txHash },
        { label: "Router proxy", name: "ERC1967Proxy", address: c.router, constructorArgs: tx.routerProxy?.constructorArgs ?? "0x", creationTx: tx.routerProxy?.txHash },
        {
            label: "Pool beacon",
            name: "UpgradeableBeacon",
            address: c.pairBeacon,
            // created by the factory proxy's initialize(): new UpgradeableBeacon(poolImplementation, factory)
            constructorArgs: c.pairImplementation && c.factory ? coder.encode(["address", "address"], [c.pairImplementation, c.factory]) : "0x",
            creationTx: tx.factoryProxy?.txHash,
            note: "Created inside the factory proxy's creation transaction (by its initialize call); there is no separate creation transaction."
        },
        {
            label: "Pool implementation",
            name: "CircleswapPair",
            address: c.pairImplementation,
            constructorArgs: "0x",
            creationTx: tx.factoryProxy?.txHash,
            note: "Created inside the factory proxy's creation transaction (by its initialize call); there is no separate creation transaction."
        }
    ];

    const inputs: Record<string, unknown> = {};
    let compiler = "";
    let settings: unknown;
    const items = want
        .filter(w => w.address)
        .map(w => {
            const { fqn, infoPath, infoId } = compilationOf(w.name, artifactsRoot);
            if (!inputs[infoId]) {
                const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
                inputs[infoId] = info.input;
                compiler = compiler || `v${info.solcLongVersion}`;
                settings = settings ?? info.input?.settings;
            }
            const { name: _n, ...rest } = w;
            return { ...rest, contract: fqn, standardInput: `${infoId}.standard-input.json` };
        });
    return { network: record.network, compiler, settings, items, inputs };
}

export function writeBundle(bundle: Bundle, outDir: string) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [id, input] of Object.entries(bundle.inputs)) fs.writeFileSync(path.join(outDir, `${id}.standard-input.json`), JSON.stringify(input));
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ network: bundle.network, compiler: bundle.compiler, settings: bundle.settings, items: bundle.items }, null, 2) + "\n");
    const lines = bundle.items.map(
        i => `- ${i.label}: ${i.address}\n    contract ${i.contract}\n    input    ${i.standardInput}\n    args     ${i.constructorArgs}${i.creationTx ? `\n    tx       ${i.creationTx}` : ""}${i.note ? `\n    note     ${i.note}` : ""}`
    );
    fs.writeFileSync(
        path.join(outDir, "README.md"),
        [
            `# Source verification bundle (${bundle.network})`,
            "",
            `Compiler ${bundle.compiler}; settings in manifest.json (optimizer, via-IR, EVM version). Upload each contract's standard-JSON input`,
            "with its constructor arguments to the explorer.",
            "",
            "On Quai the creation transaction's input is the bytecode, the constructor arguments and a 4-byte salt (ground so the address lands",
            "in Cyprus-1). The salt is the last 4 bytes of that input and is not a constructor argument. The deployed code differs from a plain",
            "recompile only at immutables (UUPS `__self`, a beacon proxy's beacon).",
            "",
            ...lines,
            ""
        ].join("\n")
    );
}

function main() {
    const argv = process.argv.slice(2);
    const network = argv[argv.indexOf("--network") + 1] && argv.includes("--network") ? argv[argv.indexOf("--network") + 1] : "cyprus1";
    const recordPath = path.join(ROOT, "deployments", `${network}.amm.json`);
    if (!fs.existsSync(recordPath)) {
        console.error(`No deployment record at ${recordPath}: deploy first (deploy:quai -- --amm --broadcast).`);
        process.exit(1);
    }
    const bundle = buildBundle(JSON.parse(fs.readFileSync(recordPath, "utf8")));
    const out = path.join(ROOT, "deployments", "verification", network);
    writeBundle(bundle, out);
    console.log(`Wrote ${bundle.items.length} contracts and ${Object.keys(bundle.inputs).length} standard-JSON input(s) to ${out}`);
}

if (require.main === module) main();
