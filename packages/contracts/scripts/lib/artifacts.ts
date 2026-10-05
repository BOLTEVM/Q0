import * as fs from "fs";
import * as path from "path";

export interface Artifact {
    contractName: string;
    abi: any[];
    /** Creation bytecode, 0x-prefixed. */
    bytecode: string;
    /** Runtime bytecode as compiled (immutables zero-filled), 0x-prefixed. */
    deployedBytecode: string;
}

const ARTIFACTS_ROOT = path.resolve(__dirname, "../../artifacts");

/** Finds and loads the compiled artifact for `name` (run `hardhat compile` first). */
export function loadArtifact(name: string, root: string = ARTIFACTS_ROOT): Artifact {
    const hit = findFile(root, `${name}.json`);
    if (!hit) {
        throw new Error(`No compiled artifact for ${name} under ${root}. Run \`pnpm --filter contracts compile\` first.`);
    }
    const art = JSON.parse(fs.readFileSync(hit, "utf8"));
    if (!art.bytecode || art.bytecode === "0x") {
        throw new Error(`${name} has no creation bytecode (abstract contract or interface?).`);
    }
    return art as Artifact;
}

function findFile(dir: string, fileName: string): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, fileName);
            if (found) return found;
        } else if (entry.name === fileName) {
            return full;
        }
    }
    return null;
}
