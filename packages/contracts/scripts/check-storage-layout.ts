/**
 * Storage-layout guard for the upgradable contracts (factory, router, pool).
 *
 * An upgrade keeps the proxy's storage and swaps the code, so a new version that moves, retypes or removes a
 * variable silently reads the old data as something else: balances become addresses, reserves become zero. The
 * compiler does not warn about it. This script records each contract's layout in storage-layouts/<Name>.json and
 * fails when the current layout is not the recorded one.
 *
 *   pnpm --filter contracts check:layout            compare (CI); exits 1 on any difference
 *   pnpm --filter contracts check:layout -- --update   re-record, after a deliberate and reviewed change
 *
 * A re-record is a reviewable diff of the JSON files. Only appending variables (consuming `__gap` slots) is a safe
 * upgrade; `isAppendOnly` encodes that rule and is what tests/StorageLayout.test.ts applies between versions.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export const UPGRADABLE = [
    { name: "CircleswapFactory", source: "contracts/amm/CircleswapFactory.sol" },
    { name: "CircleswapRouter", source: "contracts/amm/CircleswapRouter.sol" },
    { name: "CircleswapPair", source: "contracts/amm/CircleswapPair.sol" }
] as const;

export interface LayoutEntry {
    label: string;
    slot: string;
    offset: number;
    type: string;
    bytes: number;
}

const ROOT = path.resolve(__dirname, "..");
const SNAP_DIR = path.join(ROOT, "storage-layouts");

/** The layout of `source:name` as the compiler reports it (forge inspect), reduced to what compatibility depends on. */
export function readLayout(source: string, name: string): LayoutEntry[] {
    const out = execFileSync("forge", ["inspect", `${source}:${name}`, "storage-layout", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const json = JSON.parse(out.slice(out.indexOf("{")));
    return (json.storage as any[]).map(s => ({
        label: s.label,
        slot: String(s.slot),
        offset: Number(s.offset),
        type: String(json.types[s.type]?.label ?? s.type),
        bytes: Number(json.types[s.type]?.numberOfBytes ?? 0)
    }));
}

const same = (a: LayoutEntry, b: LayoutEntry) => a.label === b.label && a.slot === b.slot && a.offset === b.offset && a.type === b.type && a.bytes === b.bytes;

/**
 * True if `next` can replace `prev` behind a live proxy: every old variable is still there, in the same slot, at
 * the same offset, with the same type, and anything new comes after. Reducing a `__gap` array by the size of
 * what was added in front of it is the one allowed way to add state, and shows up as a changed gap entry.
 */
export function isAppendOnly(prev: LayoutEntry[], next: LayoutEntry[]): { ok: boolean; reason?: string } {
    const gapOf = (l: LayoutEntry[]) => l.find(e => e.label === "__gap");
    const prevNoGap = prev.filter(e => e.label !== "__gap");
    const nextNoGap = next.filter(e => e.label !== "__gap");
    for (let i = 0; i < prevNoGap.length; i++) {
        if (!nextNoGap[i] || !same(prevNoGap[i], nextNoGap[i])) {
            return { ok: false, reason: `variable #${i} (${prevNoGap[i].label} @ slot ${prevNoGap[i].slot}) moved, changed type, or was removed` };
        }
    }
    const pg = gapOf(prev);
    const ng = gapOf(next);
    if (pg) {
        // New state must end exactly where the old gap ended: gap shrank by what was added, and nothing sits past it.
        if (!ng) return { ok: false, reason: "the __gap array was removed" };
        const prevEnd = Number(pg.slot) + pg.bytes / 32;
        const nextEnd = Number(ng.slot) + ng.bytes / 32;
        if (nextEnd !== prevEnd) return { ok: false, reason: `the end of the reserved region moved (slot ${prevEnd} -> ${nextEnd}): later variables would shift` };
    } else if (next.length < prev.length) {
        return { ok: false, reason: "variables were removed" };
    }
    return { ok: true };
}

const snapPath = (name: string) => path.join(SNAP_DIR, `${name}.json`);

function main() {
    const update = process.argv.includes("--update");
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    let failed = false;
    for (const c of UPGRADABLE) {
        const current = readLayout(c.source, c.name);
        const file = snapPath(c.name);
        if (update || !fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
            console.log(`${update ? "Updated" : "Recorded"} ${path.relative(ROOT, file)} (${current.length} entries)`);
            continue;
        }
        const recorded: LayoutEntry[] = JSON.parse(fs.readFileSync(file, "utf8"));
        const identical = recorded.length === current.length && recorded.every((e, i) => same(e, current[i]));
        if (identical) {
            console.log(`ok   ${c.name}: ${current.length} storage entries unchanged`);
            continue;
        }
        failed = true;
        const verdict = isAppendOnly(recorded, current);
        console.error(`FAIL ${c.name}: storage layout differs from storage-layouts/${c.name}.json`);
        console.error(`     ${verdict.ok ? "The change is append-only (safe for an upgrade); re-record it with --update after review." : "NOT upgrade-safe: " + verdict.reason}`);
    }
    if (failed) process.exit(1);
}

if (require.main === module) main();
