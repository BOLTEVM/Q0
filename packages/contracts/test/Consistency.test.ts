import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";
import {
  QRB_BOOST_BPS,
  QRB_BOOST_MATURITY_SECONDS,
  QRB_BOOST_THRESHOLD_WEI,
  formatBoostDuration,
  formatBoostPct,
  meetsQrbBoostThreshold
} from "../../quai-service/src/registries/qrb";
import { ARWEAVE_URI, BOOST_BPS, BOOST_MATURITY, BOOST_THRESHOLD, decodeDataUri, deployNft, deployQrb } from "./helpers";

const CONTRACTS_DIR = path.resolve(__dirname, "../contracts");
const APP_SRC = path.resolve(__dirname, "../../../apps/stats-app/src");
const SERVICE_SRC = path.resolve(__dirname, "../../quai-service/src");

function walk(dir: string, exts: string[], skip: (p: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (skip(full)) continue;
    if (e.isDirectory()) out.push(...walk(full, exts, skip));
    else if (exts.includes(path.extname(e.name))) out.push(full);
  }
  return out;
}

/** Source with comments removed, so prose about the boost does not count as a second definition. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

describe("the boost is one number, used everywhere", function () {
  describe("off-chain constants match the compiled contract", function () {
    it("BOOST_BPS, BOOST_THRESHOLD and BOOST_MATURITY", async function () {
      const [owner] = await ethers.getSigners();
      const qrb = await deployQrb(owner.address);
      expect(await qrb.BOOST_BPS()).to.equal(BigInt(QRB_BOOST_BPS));
      expect(await qrb.BOOST_THRESHOLD()).to.equal(QRB_BOOST_THRESHOLD_WEI);
      expect(await qrb.BOOST_MATURITY()).to.equal(BigInt(QRB_BOOST_MATURITY_SECONDS));
      // the tests' own copies are pinned too
      expect(BOOST_BPS).to.equal(BigInt(QRB_BOOST_BPS));
      expect(BOOST_THRESHOLD).to.equal(QRB_BOOST_THRESHOLD_WEI);
      expect(BOOST_MATURITY).to.equal(BigInt(QRB_BOOST_MATURITY_SECONDS));
    });

    it("the threshold is 0.0001 QRB", function () {
      expect(QRB_BOOST_THRESHOLD_WEI).to.equal(ethers.parseEther("0.0001"));
    });

    it("meetsQrbBoostThreshold agrees with the contract's own notion of holding the threshold", async function () {
      const [owner] = await ethers.getSigners();
      const qrb = await deployQrb(owner.address);
      await qrb.mintGenesis(owner.address);
      for (const amount of [1n, QRB_BOOST_THRESHOLD_WEI - 1n, QRB_BOOST_THRESHOLD_WEI, QRB_BOOST_THRESHOLD_WEI + 1n]) {
        const w = ethers.Wallet.createRandom();
        await qrb.transfer(w.address, amount);
        // boostEligibleAt is non-zero exactly while the balance is at or above the threshold.
        const holding = (await qrb.boostEligibleAt(w.address)) > 0n;
        expect(meetsQrbBoostThreshold(amount)).to.equal(holding);
      }
    });

    it("the TypeScript percentage formatter matches the Solidity one", async function () {
      const h = await (await ethers.getContractFactory("FormatHarness")).deploy();
      for (const bps of [0, 1, 5, 10, 100, 1250, 2500, 5000, 5005, 10000, 12345]) {
        expect(formatBoostPct(bps)).to.equal(await h.pct(bps));
      }
    });

    it("the TypeScript duration formatter matches the Solidity one", async function () {
      const h = await (await ethers.getContractFactory("FormatHarness")).deploy();
      for (const secs of [0, 1, 45, 60, 90, 120, 3600, 5400, 7200, 86400, 90000, 172800, 604800]) {
        expect(formatBoostDuration(secs)).to.equal(await h.duration(secs));
      }
      expect(formatBoostDuration()).to.equal("1 day");
    });
  });

  describe("every surface reports the contract's figure", function () {
    it("Qrb.contractURI and the NFT tokenURI both render it from the constants", async function () {
      const [owner, royalty, alice] = await ethers.getSigners();
      const qrb = await deployQrb(owner.address);
      const nft = await deployNft(owner.address, royalty.address, await qrb.getAddress());
      await nft.mintArtifact(alice.address);

      const pct = formatBoostPct(); // "50%"
      const threshold = "0.0001";
      const c = decodeDataUri(await qrb.contractURI());
      const held = formatBoostDuration(); // "1 day"
      expect(c.description).to.contain(`+${pct}`).and.to.contain(`${threshold} QRB for ${held}`);
      expect(c.properties.boost_bps).to.equal(QRB_BOOST_BPS);

      const n = decodeDataUri(await nft.tokenURI(1));
      const boost = n.attributes.find((a: any) => a.trait_type === "Qrb Farm Boost").value;
      expect(boost).to.equal(`+${pct} for holders of at least ${threshold} QRB held for ${held}`);
      expect(c.image).to.equal(ARWEAVE_URI);
      expect(n.image).to.equal(ARWEAVE_URI);
    });
  });

  describe("no second copy of the number is written anywhere", function () {
    const solidity = walk(CONTRACTS_DIR, [".sol"], p => p.includes(`${path.sep}mocks`));

    it("the Solidity boost constants are each defined exactly once, in Qrb.sol", function () {
      const bpsHits = solidity.filter(f => /\b5000\b/.test(code(f))).map(f => path.basename(f));
      const thresholdHits = solidity.filter(f => /\b1e14\b|100000000000000\b/.test(code(f))).map(f => path.basename(f));
      // (QrbFormat also writes `1 days`, but only as a unit conversion; what must be single is the value.)
      const maturityHits = solidity.filter(f => /BOOST_MATURITY\s*=/.test(code(f))).map(f => path.basename(f));
      expect(bpsHits).to.deep.equal(["Qrb.sol"]);
      expect(thresholdHits).to.deep.equal(["Qrb.sol"]);
      expect(maturityHits).to.deep.equal(["Qrb.sol"]);
      const inQrb = code(path.join(CONTRACTS_DIR, "Qrb.sol"));
      expect((inQrb.match(/\b5000\b/g) || []).length).to.equal(1);
      expect((inQrb.match(/\b1e14\b/g) || []).length).to.equal(1);
    });

    it("no Solidity code hard-codes a boost percentage or the retired 2.5x", function () {
      for (const f of solidity) {
        const src = code(f);
        expect(src, path.basename(f)).to.not.match(/2\.5x|Acceleration/);
        expect(src, path.basename(f)).to.not.match(/"[^"]*\b50%[^"]*"|'[^']*\b50%[^']*'/);
      }
    });

    it("the farm has no boost figure or boost setter of its own", function () {
      const chef = code(path.join(CONTRACTS_DIR, "CircleswapMasterChef.sol"));
      expect(chef).to.not.match(/qrbBoostBps|setQrbContract|\bBOOST_BPS\s*=/);
      expect(chef).to.match(/qrb\.boostBpsOf\(/);
    });

    it("the app and service never write the percentage or the threshold as a literal", function () {
      const files = [...walk(APP_SRC, [".ts", ".tsx"]), ...walk(SERVICE_SRC, [".ts"])].filter(
        f => !f.endsWith(`${path.sep}registries${path.sep}qrb.ts`) && !f.endsWith(".d.ts")
      );
      expect(files.length).to.be.greaterThan(3);
      for (const f of files) {
        const src = code(f);
        const rel = path.relative(path.resolve(__dirname, "../../.."), f);
        expect(src, rel).to.not.match(/2\.5x|Acceleration/);
        expect(src, rel).to.not.match(/\+\s?50\s?%/);
        expect(src, rel).to.not.match(/\b0\.0001\s*(QRB)?\b/);
      }
    });
  });
});
