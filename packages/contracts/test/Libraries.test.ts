import { expect } from "chai";
import { ethers } from "hardhat";
import { TXID, ARWEAVE_URI, AR_SCHEME_URI } from "./helpers";

describe("ArweaveURI and QrbFormat libraries", function () {
  let h: any;

  before(async function () {
    h = await (await ethers.getContractFactory("FormatHarness")).deploy();
    await h.waitForDeployment();
  });

  describe("ArweaveURI.isValid", function () {
    it("accepts both canonical forms", async function () {
      expect(await h.isValidArweave(ARWEAVE_URI)).to.equal(true);
      expect(await h.isValidArweave(AR_SCHEME_URI)).to.equal(true);
    });

    it("accepts every base64url character, including - and _", async function () {
      const all = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const id = all.slice(0, 43);
      expect(await h.isValidArweave(`https://arweave.net/${id}`)).to.equal(true);
      expect(await h.isValidArweave(`ar://${all.slice(21, 64)}`)).to.equal(true);
    });

    const bad: [string, string][] = [
      ["empty", ""],
      ["scheme only", "ar://"],
      ["GitHub raw (the old, 404 URL)", "https://raw.githubusercontent.com/BOLTEVM/Q0/main/QgoGIF.gif"],
      ["IPFS", `ipfs://${TXID}`],
      ["http, not https", `http://arweave.net/${TXID}`],
      ["other gateway", `https://ar-io.net/${TXID}`],
      ["uppercase scheme", `AR://${TXID}`],
      ["txid one char short", `ar://${TXID.slice(0, 42)}`],
      ["txid one char long", `ar://${TXID}A`],
      ["trailing slash", `${ARWEAVE_URI}/`],
      ["query string", `${ARWEAVE_URI}?x=1`],
      ["path after txid", `${ARWEAVE_URI}/index.html`],
      ["standard base64 plus", `ar://${"A".repeat(42)}+`],
      ["standard base64 slash", `ar://${"A".repeat(42)}/`],
      ["padding", `ar://${"A".repeat(42)}=`],
      ["dot", `ar://${"A".repeat(42)}.`],
      ["space", `ar://${"A".repeat(42)} `],
      ["quote (JSON injection)", `ar://${"A".repeat(42)}"`],
      ["backslash", `ar://${"A".repeat(42)}\\`]
    ];
    for (const [name, uri] of bad) {
      it(`rejects: ${name}`, async function () {
        expect(await h.isValidArweave(uri)).to.equal(false);
      });
    }
  });

  describe("QrbFormat.pct", function () {
    const cases: [number, string][] = [
      [0, "0%"],
      [1, "0.01%"],
      [5, "0.05%"],
      [10, "0.1%"],
      [100, "1%"],
      [1250, "12.5%"],
      [5000, "50%"],
      [5005, "50.05%"],
      [10000, "100%"],
      [12345, "123.45%"]
    ];
    for (const [bps, want] of cases) {
      it(`${bps} bps -> ${want}`, async function () {
        expect(await h.pct(bps)).to.equal(want);
      });
    }
  });

  describe("QrbFormat.amount18", function () {
    const E = 10n ** 18n;
    const cases: [bigint, string][] = [
      [0n, "0"],
      [1n, "0.000000000000000001"],
      [10n ** 14n, "0.0001"],
      [10n ** 17n, "0.1"],
      [E, "1"],
      [(3n * E) / 2n, "1.5"],
      [E + 1n, "1.000000000000000001"],
      [123456789012345678n, "0.123456789012345678"],
      [12n * E + 34n * 10n ** 15n, "12.034"],
      [10n ** 30n, "1000000000000"]
    ];
    for (const [v, want] of cases) {
      it(`${v} wei -> ${want}`, async function () {
        expect(await h.amount18(v)).to.equal(want);
      });
    }
  });

  describe("QrbFormat.duration", function () {
    const cases: [number, string][] = [
      [0, "0 seconds"],
      [1, "1 second"],
      [45, "45 seconds"],
      [60, "1 minute"],
      [90, "90 seconds"],
      [120, "2 minutes"],
      [3600, "1 hour"],
      [5400, "90 minutes"],
      [7200, "2 hours"],
      [86400, "1 day"],
      [90000, "25 hours"],
      [172800, "2 days"],
      [604800, "7 days"]
    ];
    for (const [secs, want] of cases) {
      it(`${secs}s -> ${want}`, async function () {
        expect(await h.duration(secs)).to.equal(want);
      });
    }
  });
});
