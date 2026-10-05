import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { UPGRADABLE, readLayout, isAppendOnly, type LayoutEntry } from "../scripts/check-storage-layout";

const hasForge = (() => {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const SNAP = path.resolve(__dirname, "../storage-layouts");
const e = (label: string, slot: number, type = "t_uint256", bytes = 32, offset = 0): LayoutEntry => ({ label, slot: String(slot), offset, type, bytes });

describe("storage layout of the upgradable contracts", function () {
  this.timeout(300_000);

  describe("the compatibility rule", function () {
    const v1 = [e("a", 0), e("b", 1, "t_address", 20), e("__gap", 2, "t_array(t_uint256)50_storage", 50 * 32)];

    it("accepts appending a variable by consuming the gap", function () {
      const v2 = [e("a", 0), e("b", 1, "t_address", 20), e("c", 2), e("__gap", 3, "t_array(t_uint256)49_storage", 49 * 32)];
      expect(isAppendOnly(v1, v2).ok).to.equal(true);
    });
    it("accepts an unchanged layout", function () {
      expect(isAppendOnly(v1, v1).ok).to.equal(true);
    });
    it("rejects reordering, retyping, removing, or inserting before existing variables", function () {
      expect(isAppendOnly(v1, [e("b", 0, "t_address", 20), e("a", 1), v1[2]]).ok).to.equal(false);
      expect(isAppendOnly(v1, [e("a", 0, "t_uint128", 16), v1[1], v1[2]]).ok).to.equal(false);
      expect(isAppendOnly(v1, [e("a", 0), v1[2]]).ok).to.equal(false);
      expect(isAppendOnly(v1, [e("x", 0), e("a", 1), e("b", 2, "t_address", 20), e("__gap", 3, "t_array(t_uint256)50_storage", 50 * 32)]).ok).to.equal(false);
    });
    it("rejects a new variable that does not shrink the gap (it would push everything after it)", function () {
      const bad = [e("a", 0), e("b", 1, "t_address", 20), e("c", 2), e("__gap", 3, "t_array(t_uint256)50_storage", 50 * 32)];
      const verdict = isAppendOnly(v1, bad);
      expect(verdict.ok).to.equal(false);
      expect(verdict.reason).to.contain("reserved region");
    });
    it("rejects removing the gap", function () {
      expect(isAppendOnly(v1, [v1[0], v1[1]]).ok).to.equal(false);
    });
  });

  it("the plain and upgradeable OpenZeppelin packages are the same version (proxy, UUPS and namespaced storage must match)", function () {
    const v = (p: string) => JSON.parse(fs.readFileSync(require.resolve(`@openzeppelin/${p}/package.json`), "utf8")).version;
    expect(v("contracts-upgradeable")).to.equal(v("contracts"));
    const declared = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).dependencies;
    expect(declared["@openzeppelin/contracts"]).to.equal(v("contracts")); // pinned exactly, not a range
    expect(declared["@openzeppelin/contracts-upgradeable"]).to.equal(v("contracts-upgradeable"));
  });

  (hasForge ? describe : describe.skip)("the real contracts", function () {
    for (const c of UPGRADABLE) {
      it(`${c.name} matches its recorded layout (re-record with check:layout -- --update after a reviewed change)`, function () {
        const recorded: LayoutEntry[] = JSON.parse(fs.readFileSync(path.join(SNAP, `${c.name}.json`), "utf8"));
        expect(readLayout(c.source, c.name)).to.deep.equal(recorded);
      });
    }

    it("every mock V2 used in the upgrade tests is a legal upgrade of what it replaces", function () {
      const pairs: [string, string, string][] = [
        ["contracts/amm/CircleswapPair.sol", "CircleswapPair", "CircleswapPairV2"],
        ["contracts/amm/CircleswapFactory.sol", "CircleswapFactory", "CircleswapFactoryV2"],
        ["contracts/amm/CircleswapRouter.sol", "CircleswapRouter", "CircleswapRouterV2"]
      ];
      for (const [src, v1, v2] of pairs) {
        const verdict = isAppendOnly(readLayout(src, v1), readLayout("contracts/mocks/AmmUpgradeMocks.sol", v2));
        expect(verdict.ok, `${v2}: ${verdict.reason}`).to.equal(true);
      }
    });

    it("an incompatible version is detected (a V2 that reorders state)", function () {
      // The hostile factory mirrors only the first slot and then diverges: it must NOT pass as an upgrade.
      const verdict = isAppendOnly(readLayout("contracts/amm/CircleswapFactory.sol", "CircleswapFactory"), readLayout("contracts/mocks/AmmGovernanceMocks.sol", "EvilFactory"));
      expect(verdict.ok).to.equal(false);
    });
  });
});
