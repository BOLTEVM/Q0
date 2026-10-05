/**
 * Uploads the Qrb artwork to Arweave (through Turbo) and records the permanent URI for the deploy script.
 *
 *   pnpm --filter contracts upload:artwork -- [--dry-run] [--file <path>]
 *
 * --dry-run  hash the file and ask Turbo for the price; needs no wallet, spends nothing.
 * (default)  upload. Needs ARWEAVE_KEY_FILE: the path to an Arweave wallet keyfile (JWK JSON) that holds
 *            Turbo credits. The key is read from that file, used to sign, and never printed or stored.
 *
 * Arweave storage is permanent and public: once this runs the file cannot be removed or replaced. After
 * uploading, the script fetches the file back from the gateway and checks it byte for byte, then writes
 * deployments/artwork.json, which deploy-quai.ts reads.
 */
import * as fs from "fs";
import * as path from "path";
import { TurboFactory } from "@ardrive/turbo-sdk";
import { sha256Hex, verifyArtwork } from "./lib/artwork";

const ROOT = path.resolve(__dirname, "..");
/** True once this run has paid for an upload and written its id down. */
let uploadRecorded = false;
const DEFAULT_FILE = path.resolve(ROOT, "../../apps/stats-app/public/QgoGIF.gif");
const CONTENT_TYPES: Record<string, string> = { ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

async function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const fileIdx = argv.indexOf("--file");
    const file = fileIdx >= 0 ? path.resolve(argv[fileIdx + 1]) : DEFAULT_FILE;

    if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
    const bytes = fs.readFileSync(file);
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (!contentType) throw new Error(`Unsupported artwork type ${path.extname(file)}; expected one of ${Object.keys(CONTENT_TYPES).join(", ")}`);
    const sha256 = sha256Hex(bytes);

    console.log(`File:         ${file}`);
    console.log(`Size:         ${bytes.length} bytes`);
    console.log(`Content-Type: ${contentType}`);
    console.log(`SHA-256:      ${sha256}`);

    const anon = TurboFactory.unauthenticated();
    const [cost] = await anon.getUploadCosts({ bytes: [bytes.length] });
    console.log(`Turbo price:  ${cost.winc} winc (Turbo credits)`);

    if (dryRun) {
        console.log("\nDry run: nothing uploaded.");
        return;
    }

    const keyFile = process.env.ARWEAVE_KEY_FILE;
    if (!keyFile) throw new Error("Set ARWEAVE_KEY_FILE to the path of your Arweave wallet keyfile (JWK JSON), or use --dry-run");
    const jwk = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    const turbo = TurboFactory.authenticated({ privateKey: jwk });

    const { winc: balance } = await turbo.getBalance();
    if (BigInt(balance) < BigInt(cost.winc)) {
        throw new Error(`Turbo balance ${balance} winc is below the ${cost.winc} winc this upload costs. Add credits at https://turbo.ardrive.io, then retry.`);
    }

    console.log("\nUploading (permanent and public)...");
    const receipt = await turbo.uploadFile({
        file: file,
        dataItemOpts: {
            tags: [
                { name: "Content-Type", value: contentType },
                { name: "App-Name", value: "Circleswap" },
                { name: "Title", value: "Circleswap Qrb" }
            ]
        }
    });
    const uri = `https://arweave.net/${receipt.id}`;
    console.log(`Uploaded:     ${uri}`);

    // The upload is paid for and permanent. Record the id now, before the gateway check that can time out,
    // so a slow gateway never leaves you with an upload you cannot find.
    fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
    const out = path.join(ROOT, "deployments", "artwork.json");
    const record = { uri, txid: receipt.id, sha256, bytes: bytes.length, contentType, uploadedAt: new Date().toISOString(), verified: false };
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    uploadRecorded = true;
    console.log(`Recorded the upload in ${out} (not yet verified).`);

    console.log("Checking the gateway serves the exact bytes (may take a minute)...");
    const check = await verifyArtwork(uri, file, undefined, 12, 10_000);
    console.log(`  ok: ${check.bytes} bytes, sha256 ${check.sha256}`);
    fs.writeFileSync(out, JSON.stringify({ ...record, verified: true }, null, 2) + "\n");
    console.log(`\nVerified. deploy-quai.ts will use ${uri}.`);
}

main().catch(e => {
    console.error(`\nFailed: ${e.message}`);
    if (uploadRecorded) {
        console.error("The upload succeeded and is recorded in deployments/artwork.json. Do NOT upload again; re-run the deploy script, which re-checks the gateway itself.");
    }
    process.exit(1);
});
