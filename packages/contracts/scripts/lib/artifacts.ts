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

/**
 * Where the compiler placed each immutable inside `name`'s runtime code: [byte offset, byte length] pairs, sorted.
 * Read from the build-info the artifact points at (Hardhat's artifacts do not carry them).
 */
export function loadImmutableRanges(name: string, root: string = ARTIFACTS_ROOT): [number, number][] {
    const hit = findFile(root, `${name}.json`);
    if (!hit) throw new Error(`No compiled artifact for ${name} under ${root}. Run \`pnpm --filter contracts compile\` first.`);
    const art = JSON.parse(fs.readFileSync(hit, "utf8"));
    const dbgPath = hit.replace(/\.json$/, ".dbg.json");
    if (!fs.existsSync(dbgPath)) throw new Error(`${name}: no ${path.basename(dbgPath)} next to the artifact; recompile.`);
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    // Hardhat writes the relative path with the host's separator.
    const infoPath = path.resolve(path.dirname(dbgPath), String(dbg.buildInfo).split(String.fromCharCode(92)).join("/"));
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    const out = info.output?.contracts?.[art.sourceName]?.[art.contractName]?.evm?.deployedBytecode;
    if (!out) throw new Error(`${name}: not found in build-info ${path.basename(infoPath)}; recompile.`);
    const refs: Record<string, { start: number; length: number }[]> = out.immutableReferences ?? {};
    const ranges: [number, number][] = [];
    for (const list of Object.values(refs)) for (const r of list) ranges.push([r.start, r.length]);
    return ranges.sort((a, b) => a[0] - b[0]);
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
