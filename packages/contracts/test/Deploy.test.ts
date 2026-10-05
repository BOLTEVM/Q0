import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import * as ts from "typescript";
import { Interface } from "ethers";
import { Wallet, getZoneForAddress, isQiAddress, getCreateAddress, Zone } from "quais";

import type { ChainClient, TxReceipt } from "../scripts/lib/chain";
import { loadArtifact } from "../scripts/lib/artifacts";
import { arweaveTxId, gatewayUrl, sha256Hex, verifyArtwork } from "../scripts/lib/artwork";
import { contractAddressFromReceipt, deployContract, waitForReceipt } from "../scripts/lib/deploy";
import { addPools, deployCircleswap, type CircleswapConfig, type DeployProgress } from "../scripts/lib/circleswap";
import { deploymentRecord, renderDeployedTs } from "../scripts/lib/record";
import { assertCyprus1, grindCreationData, isCyprus1QuaiAddress, QuaiChainClient } from "../scripts/lib/quaiClient";
import { E18, ARWEAVE_URI, TXID, BOOST_BPS } from "./helpers";
import { hardhatClient, flaky, FAST } from "./chainClient";

describe("deploy tooling", function () {
  // -------------------------------------------------------------------------------------------- receipts
  describe("contractAddressFromReceipt: the address comes from the receipt and nowhere else", function () {
    const ok: TxReceipt = { status: 1, contractAddress: "0x00325150094E51107a931980Fdfc3bB1a4C48379", blockNumber: 1, gasUsed: 1n };

    it("returns the receipt's full address unchanged", function () {
      expect(contractAddressFromReceipt(ok, "0xabc")).to.equal(ok.contractAddress);
    });

    it("refuses a missing receipt, a reverted one, and a receipt with no contractAddress", function () {
      expect(() => contractAddressFromReceipt(null, "0xabc")).to.throw("No receipt");
      expect(() => contractAddressFromReceipt({ ...ok, status: 0 }, "0xabc")).to.throw("reverted");
      expect(() => contractAddressFromReceipt({ ...ok, contractAddress: null }, "0xabc")).to.throw("refusing to derive");
    });

    for (const [name, bad] of [
      ["truncated to 39 hex digits", "0x00325150094E51107a931980Fdfc3bB1a4C4837"],
      ["one digit too long", "0x00325150094E51107a931980Fdfc3bB1a4C483790"],
      ["no 0x prefix", "00325150094E51107a931980Fdfc3bB1a4C48379"],
      ["non-hex character", "0x0032515009ZE51107a931980Fdfc3bB1a4C48379"],
      ["elided with an ellipsis", "0x00325150...4C48379"],
      ["empty string", ""]
    ] as const) {
      it(`refuses a malformed address: ${name}`, function () {
        expect(() => contractAddressFromReceipt({ ...ok, contractAddress: bad }, "0xabc")).to.throw(/malformed|refusing/);
      });
    }
  });

  // ---------------------------------------------------------------------------------------- deployContract
  describe("deployContract", function () {
    const artifact = () => loadArtifact("Qrb");

    it("deploys, and the address it returns is the receipt's, with matching on-chain code", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      const res = await deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true });
      const receipt = await client.getReceipt(res.txHash!);
      expect(res.address).to.equal(receipt!.contractAddress);
      expect(await client.getCode(res.address!)).to.not.equal("0x");
      expect(res.gasLimit).to.be.gte(res.estimatedGas * 3n);
      // maxFee is gasLimit x the gas price read at deploy time (the price itself moves block to block).
      expect(res.maxFee % res.gasLimit).to.equal(0n);
      expect(res.maxFee / res.gasLimit).to.be.gt(0n);
    });

    it("a dry run simulates and prices but sends nothing", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      const nonce = await ethers.provider.getTransactionCount(signer.address);
      const res = await deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: false });
      expect(res.dryRun).to.equal(true);
      expect(res.address).to.equal(undefined);
      expect(res.estimatedGas).to.be.gt(0n);
      expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonce);
    });

    it("uses the requested gas multiplier", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      const res = await deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: false, gasMultiplier: 2.5 });
      expect(res.gasLimit).to.equal((res.estimatedGas * 250n) / 100n);
    });

    it("stops before sending when the constructor would revert", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      const nonce = await ethers.provider.getTransactionCount(signer.address);
      await expect(
        deployContract(client, artifact(), [signer.address, "https://raw.githubusercontent.com/x/y/main/a.gif"], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("simulation failed, nothing sent");
      expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonce);
    });

    it("refuses when the deployer cannot cover the maximum gas cost", async function () {
      const [signer] = await ethers.getSigners();
      const client = { ...hardhatClient(signer), getBalance: async () => 1n };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("can cost up to");
    });

    it("refuses a receipt with no contractAddress, without falling back to a computed address", async function () {
      const [signer] = await ethers.getSigners();
      const base = hardhatClient(signer);
      const client = { ...base, getReceipt: async (h: string) => ({ ...(await base.getReceipt(h))!, contractAddress: null }) };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("refusing to derive");
    });

    it("trusts the receipt over the chain's own derivation: a receipt naming an empty address is refused", async function () {
      const [signer] = await ethers.getSigners();
      const base = hardhatClient(signer);
      const decoy = "0x1111111111111111111111111111111111111111";
      const client = { ...base, getReceipt: async (h: string) => ({ ...(await base.getReceipt(h))!, contractAddress: decoy }) };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith(`receipt says ${decoy} but no code is deployed there`);
    });

    it("refuses when the code at the receipt's address is not the compiled contract", async function () {
      const [signer] = await ethers.getSigners();
      const base = hardhatClient(signer);
      // Point the receipt at a real contract of a different size.
      const other = await (await ethers.getContractFactory("MockERC20")).deploy("x", "x");
      const client = { ...base, getReceipt: async (h: string) => ({ ...(await base.getReceipt(h))!, contractAddress: await other.getAddress() }) };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("compiled runtime is");
    });

    it("applies the chain's address rule to the receipt's address", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], {
          ...FAST,
          label: "Qrb",
          broadcast: true,
          checkAddress: a => {
            throw new Error(`wrong zone: ${a}`);
          }
        })
      ).to.be.rejectedWith("wrong zone");
    });

    it("reports a reverted transaction", async function () {
      const [signer] = await ethers.getSigners();
      const base = hardhatClient(signer);
      const client = { ...base, getReceipt: async (h: string) => ({ ...(await base.getReceipt(h))!, status: 0 }) };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { ...FAST, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("reverted on-chain");
    });

    it("times out cleanly when the transaction is never mined", async function () {
      const [signer] = await ethers.getSigners();
      const client = { ...hardhatClient(signer), getReceipt: async () => null };
      await expect(
        deployContract(client, artifact(), [signer.address, ARWEAVE_URI], { pollMs: 5, timeoutMs: 60, label: "Qrb", broadcast: true })
      ).to.be.rejectedWith("was not mined");
    });
  });

  // ---------------------------------------------------------------------------------------- confirmations
  describe("waitForReceipt confirmations", function () {
    it("waits for the requested number of blocks", async function () {
      const [signer] = await ethers.getSigners();
      const client = hardhatClient(signer);
      const tx = await signer.sendTransaction({ to: signer.address, value: 0 });
      const at = (await tx.wait())!.blockNumber;
      const p = waitForReceipt(client, tx.hash, { label: "t", broadcast: true, pollMs: 5, timeoutMs: 3000, confirmations: 3 });
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 15));
        await mine(1);
      }
      const receipt = await p;
      expect(await ethers.provider.getBlockNumber()).to.be.gte(at + 3);
      expect(receipt.blockNumber).to.equal(at);
    });

    it("detects a receipt that moved after the confirmations (a reorg)", async function () {
      const [signer] = await ethers.getSigners();
      const base = hardhatClient(signer);
      const tx = await signer.sendTransaction({ to: signer.address, value: 0 });
      await tx.wait();
      let calls = 0;
      const client = {
        ...base,
        getReceipt: async (h: string) => {
          const r = (await base.getReceipt(h))!;
          return ++calls > 1 ? { ...r, blockNumber: r.blockNumber + 1 } : r;
        }
      };
      await mine(3);
      await expect(
        waitForReceipt(client, tx.hash, { label: "t", broadcast: true, pollMs: 5, timeoutMs: 3000, confirmations: 2 })
      ).to.be.rejectedWith("moved or vanished");
    });
  });

  // ---------------------------------------------------------------------------------------- orchestration
  describe("deployCircleswap", function () {
    async function config(over: Partial<CircleswapConfig> = {}): Promise<CircleswapConfig> {
      const [owner, royalty, recipient] = await ethers.getSigners();
      return {
        owner: owner.address,
        royaltyReceiver: royalty.address,
        artworkURI: ARWEAVE_URI,
        deploy: { ...FAST, broadcast: true },
        ...over
      } as CircleswapConfig & { _r?: string };
    }

    it("deploys Qrb, the NFT and the farm, wired to each other by receipt-read addresses", async function () {
      const [owner, royalty, recipient] = await ethers.getSigners();
      const client = hardhatClient(owner);
      const Mock = await ethers.getContractFactory("MockERC20");
      const bdelta = await Mock.deploy("BoltDelta", "BDELTA");
      const q0 = await Mock.deploy("QBOLT", "Q0");
      const lps = [await Mock.deploy("LP0", "LP0"), await Mock.deploy("LP1", "LP1"), await Mock.deploy("LP2", "LP2")];

      const cfg = await config({
        mintTo: recipient.address,
        farm: {
          rewardTokenA: await bdelta.getAddress(),
          rewardTokenB: await q0.getAddress(),
          rewardAPerSecond: E18,
          rewardBPerSecond: 3n * E18,
          pools: await Promise.all(lps.map(async (l, i) => ({ allocPoint: (i + 1) * 100, lpToken: await l.getAddress() })))
        }
      });
      const out = await deployCircleswap(client, cfg);

      expect(out.dryRun).to.equal(false);
      const qrb = await ethers.getContractAt("Qrb", out.qrb!.address!);
      const nft = await ethers.getContractAt("QrbArtifactNFT", out.nft!.address!);
      const farm = await ethers.getContractAt("CircleswapMasterChef", out.farm!.address!);

      expect(out.qrbAddress).to.equal(out.qrb!.address);
      expect(await qrb.owner()).to.equal(owner.address);
      expect(await qrb.artworkURI()).to.equal(ARWEAVE_URI);
      expect(await nft.qrb()).to.equal(out.qrb!.address);
      expect(await farm.qrb()).to.equal(out.qrb!.address);
      expect(await farm.rewardTokenA()).to.equal(await bdelta.getAddress());

      // Pools were added in order, so pool ids match the app's registry order.
      expect(await farm.poolLength()).to.equal(3);
      for (let i = 0; i < 3; i++) {
        const info = await farm.poolInfo(i);
        expect(info.lpToken).to.equal(await lps[i].getAddress());
        expect(info.allocPoint).to.equal((i + 1) * 100);
      }

      // Minted to the requested recipient.
      expect(await qrb.balanceOf(recipient.address)).to.equal(E18);
      expect(await nft.ownerOf(1)).to.equal(recipient.address);
      expect(out.minted!.recipient).to.equal(recipient.address);
      expect(out.minted!.genesisTx).to.match(/^0x[0-9a-f]{64}$/);

      // Each address matches its own receipt.
      for (const r of [out.qrb!, out.nft!, out.farm!]) {
        expect((await client.getReceipt(r.txHash!))!.contractAddress).to.equal(r.address);
      }
      void royalty;
    });

    it("a dry run against a real boost source simulates every constructor exactly and changes nothing", async function () {
      const [owner] = await ethers.getSigners();
      const client = hardhatClient(owner);
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
      const standIn = await (await ethers.getContractFactory("Qrb")).deploy(owner.address, ARWEAVE_URI); // answers the interface
      const nonce = await ethers.provider.getTransactionCount(owner.address);

      const out = await deployCircleswap(
        client,
        await config({
          deploy: { ...FAST, broadcast: false },
          dryRunQrbStandIn: await standIn.getAddress(),
          farm: { rewardTokenA: await a.getAddress(), rewardTokenB: await b.getAddress(), rewardAPerSecond: 1n, rewardBPerSecond: 1n }
        })
      );
      expect(out.dryRun).to.equal(true);
      expect(out.qrb!.address).to.equal(undefined);
      expect(out.nft!.projected).to.equal(undefined); // simulated, not projected
      expect(out.nft!.estimatedGas).to.be.gt(0n);
      expect(out.farm!.estimatedGas).to.be.gt(0n);
      expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
    });

    it("a dry run with nothing on-chain to boost from simulates Qrb and the farm and projects the NFT, saying so", async function () {
      const [owner] = await ethers.getSigners();
      const client = hardhatClient(owner);
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
      const nonce = await ethers.provider.getTransactionCount(owner.address);

      const out = await deployCircleswap(
        client,
        await config({
          deploy: { ...FAST, broadcast: false },
          farm: { rewardTokenA: await a.getAddress(), rewardTokenB: await b.getAddress(), rewardAPerSecond: 1n, rewardBPerSecond: 1n }
        })
      );
      expect(out.qrb!.projected).to.equal(undefined);
      expect(out.farm!.projected).to.equal(undefined);
      expect(out.farm!.estimatedGas).to.be.gt(0n);
      // The NFT's constructor needs a real Qrb, so its figure is a labelled projection from size.
      expect(out.nft!.projected).to.equal(true);
      const ratio = (loadArtifact("QrbArtifactNFT").bytecode.length - 2) / (loadArtifact("Qrb").bytecode.length - 2);
      expect(Number(out.nft!.estimatedGas)).to.be.closeTo(Number(out.qrb!.estimatedGas) * ratio, 2);
      expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
    });

    it("farm-only mode deploys just the farm against an existing Qrb, and refuses anything that is not a Qrb", async function () {
      const [owner] = await ethers.getSigners();
      const client = hardhatClient(owner);
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
      const qrb = await (await ethers.getContractFactory("Qrb")).deploy(owner.address, ARWEAVE_URI);
      const farm = { rewardTokenA: await a.getAddress(), rewardTokenB: await b.getAddress(), rewardAPerSecond: 1n, rewardBPerSecond: 2n };

      const out = await deployCircleswap(client, await config({ farm, existingQrb: await qrb.getAddress() }));
      expect(out.qrb).to.equal(undefined);
      expect(out.nft).to.equal(undefined);
      const chef = await ethers.getContractAt("CircleswapMasterChef", out.farm!.address!);
      expect(await chef.qrb()).to.equal(await qrb.getAddress());

      // A contract that has no boost interface is refused before anything is sent.
      await expect(deployCircleswap(client, await config({ farm, existingQrb: await a.getAddress() }))).to.be.rejected;
      // An address with no code is refused.
      await expect(deployCircleswap(client, await config({ farm, existingQrb: ethers.Wallet.createRandom().address }))).to.be.rejectedWith("has no code");
      // Farm-only needs a farm.
      await expect(deployCircleswap(client, await config({ existingQrb: await qrb.getAddress() }))).to.be.rejectedWith("farm to deploy");
    });

    it("refuses to mint when the owner is not the deployer (only the owner can)", async function () {
      const [owner, royalty, recipient] = await ethers.getSigners();
      await expect(
        deployCircleswap(hardhatClient(owner), await config({ owner: royalty.address, mintTo: recipient.address }))
      ).to.be.rejectedWith("owner == deployer");
    });

    it("a wrong on-chain owner fails the post-deploy check", async function () {
      const [owner, royalty] = await ethers.getSigners();
      const base = hardhatClient(owner);
      const ownerSel = new Interface(loadArtifact("Qrb").abi).getFunction("owner")!.selector;
      const client = {
        ...base,
        call: async (to: string, data: string) =>
          data.startsWith(ownerSel) ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [royalty.address]) : base.call(to, data)
      };
      await expect(deployCircleswap(client, await config())).to.be.rejectedWith("Post-deploy check failed: Qrb.owner");
    });

    it("a Qrb whose boost differs from the app's constants fails the post-deploy check", async function () {
      const [owner] = await ethers.getSigners();
      const base = hardhatClient(owner);
      const sel = new Interface(loadArtifact("Qrb").abi).getFunction("BOOST_BPS")!.selector;
      const client = {
        ...base,
        call: async (to: string, data: string) =>
          data.startsWith(sel) ? ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1234n]) : base.call(to, data)
      };
      await expect(deployCircleswap(client, await config())).to.be.rejectedWith("Qrb.BOOST_BPS");
    });
  });

  // ---------------------------------------------------------------------------------------- interrupted runs
  describe("an interrupted deployment can be finished without repeating anything", function () {
    async function setup() {
      const [owner, , recipient] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const bdelta = await Mock.deploy("BoltDelta", "BDELTA");
      const q0 = await Mock.deploy("QBOLT", "Q0");
      const lps = [await Mock.deploy("LP0", "LP0"), await Mock.deploy("LP1", "LP1"), await Mock.deploy("LP2", "LP2")];
      const pools = await Promise.all(lps.map(async (l, i) => ({ allocPoint: (i + 1) * 100, lpToken: await l.getAddress() })));
      const cfg = (over: Partial<CircleswapConfig> = {}): CircleswapConfig => ({
        owner: owner.address,
        royaltyReceiver: owner.address,
        artworkURI: ARWEAVE_URI,
        mintTo: recipient.address,
        farm: { rewardTokenA: bdelta.target as string, rewardTokenB: q0.target as string, rewardAPerSecond: 1n, rewardBPerSecond: 2n, pools },
        deploy: { ...FAST, broadcast: true },
        ...over
      });
      return { owner, recipient, cfg, pools };
    }

    it("progress is reported after every step, cumulatively", async function () {
      const { owner, cfg } = await setup();
      const seen: DeployProgress[] = [];
      await deployCircleswap(hardhatClient(owner), cfg({ onProgress: p => seen.push(p) }));
      const last = seen[seen.length - 1];
      expect(seen.length).to.be.gte(8); // qrb, nft, farm, 3 pools (+ final), 2 mints
      expect(seen[0].qrb).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(seen[0].nft).to.equal(undefined); // earlier snapshots do not gain later fields
      expect(last.qrb && last.nft && last.farm).to.be.a("string");
      expect(last.poolsAdded).to.equal(3);
      expect(last.mintedGenesis && last.mintedArtifact).to.equal(true);
      expect(Object.keys(last.txHashes)).to.include.members(["qrb", "nft", "farm", "addPool0", "addPool2", "mintGenesis", "mintArtifact"]);
    });

    it("a failure while adding pools loses nothing: resuming adds only the missing pools and mints", async function () {
      const { owner, recipient, cfg } = await setup();
      let saved: DeployProgress | undefined;
      const first = flaky(hardhatClient(owner), { failCall: 2 }); // dies on addPool(1)
      await expect(deployCircleswap(first.client, cfg({ onProgress: p => (saved = p) }))).to.be.rejectedWith("simulated network failure");

      // The three contracts exist and are on record; one pool went in.
      expect(saved!.qrb && saved!.nft && saved!.farm).to.be.a("string");
      expect(saved!.poolsAdded).to.equal(1);
      expect(first.counters.creates).to.equal(3);

      const second = flaky(hardhatClient(owner));
      const out = await deployCircleswap(
        second.client,
        cfg({ resume: { qrb: saved!.qrb, nft: saved!.nft, farm: saved!.farm } })
      );
      expect(second.counters.creates).to.equal(0); // nothing deployed twice
      expect(second.counters.calls).to.equal(4); // addPool(1), addPool(2), mintGenesis, mintArtifact
      expect(out.qrb!.address).to.equal(saved!.qrb);
      expect(out.farm!.address).to.equal(saved!.farm);

      const farm = await ethers.getContractAt("CircleswapMasterChef", saved!.farm!);
      expect(await farm.poolLength()).to.equal(3);
      const qrb = await ethers.getContractAt("Qrb", saved!.qrb!);
      expect(await qrb.balanceOf(recipient.address)).to.equal(E18);
    });

    it("a failure at the second mint resumes without minting the first token again", async function () {
      const { owner, recipient, cfg } = await setup();
      let saved: DeployProgress | undefined;
      const first = flaky(hardhatClient(owner), { failCall: 5 }); // 3 addPool + mintGenesis, then mintArtifact dies
      await expect(deployCircleswap(first.client, cfg({ onProgress: p => (saved = p) }))).to.be.rejectedWith("simulated network failure");
      expect(saved!.mintedGenesis).to.equal(true);
      expect(saved!.mintedArtifact).to.equal(undefined);

      const second = flaky(hardhatClient(owner));
      const out = await deployCircleswap(second.client, cfg({ resume: { qrb: saved!.qrb, nft: saved!.nft, farm: saved!.farm } }));
      expect(second.counters.creates).to.equal(0);
      expect(second.counters.calls).to.equal(1); // only mintArtifact: mintGenesis and the pools are skipped
      expect(out.minted!.genesisTx).to.equal("already minted");
      const nft = await ethers.getContractAt("QrbArtifactNFT", saved!.nft!);
      expect(await nft.ownerOf(1)).to.equal(recipient.address);
    });

    it("resuming a run that already finished changes nothing and does not error", async function () {
      const { owner, cfg } = await setup();
      let saved: DeployProgress | undefined;
      await deployCircleswap(hardhatClient(owner), cfg({ onProgress: p => (saved = p) }));
      const again = flaky(hardhatClient(owner));
      await deployCircleswap(again.client, cfg({ resume: { qrb: saved!.qrb, nft: saved!.nft, farm: saved!.farm } }));
      expect(again.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("refuses to adopt an address with no code or the wrong contract", async function () {
      const { owner, cfg } = await setup();
      const client = hardhatClient(owner);
      const empty = ethers.Wallet.createRandom().address;
      await expect(deployCircleswap(client, cfg({ resume: { qrb: empty } }))).to.be.rejectedWith("has no code");
      const wrong = await (await ethers.getContractFactory("MockERC20")).deploy("x", "x");
      await expect(deployCircleswap(client, cfg({ resume: { qrb: await wrong.getAddress() } }))).to.be.rejectedWith("compiled runtime is");
    });

    it("refuses to adopt a Qrb configured differently from this run (wrong artwork or owner)", async function () {
      const { owner, cfg } = await setup();
      const other = await (await ethers.getContractFactory("Qrb")).deploy(owner.address, "https://arweave.net/" + "B".repeat(43));
      await expect(
        deployCircleswap(hardhatClient(owner), cfg({ resume: { qrb: await other.getAddress() } }))
      ).to.be.rejectedWith("Post-deploy check failed: Qrb.artworkURI");
    });

    it("resume is ignored in a dry run (nothing is adopted or sent)", async function () {
      const { owner, cfg } = await setup();
      const dry = flaky(hardhatClient(owner));
      const out = await deployCircleswap(
        dry.client,
        cfg({ resume: { qrb: ethers.Wallet.createRandom().address }, mintTo: undefined, deploy: { ...FAST, broadcast: false } })
      );
      expect(out.dryRun).to.equal(true);
      expect(dry.counters).to.deep.equal({ creates: 0, calls: 0 });
    });
  });

  // ---------------------------------------------------------------------------------------- addPools
  describe("addPools", function () {
    async function farmWith(owner: any) {
      const Mock = await ethers.getContractFactory("MockERC20");
      const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
      const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(
        owner.address, await a.getAddress(), await b.getAddress(), ethers.ZeroAddress, 1, 1
      );
      const lps = [await Mock.deploy("l0", "l0"), await Mock.deploy("l1", "l1"), await Mock.deploy("l2", "l2")];
      const pools = await Promise.all(lps.map(async (l, i) => ({ allocPoint: 100 + i, lpToken: await l.getAddress() })));
      return { chef, pools };
    }
    const opts = { ...FAST, broadcast: true };

    it("adds every pool in order, and a second run adds nothing", async function () {
      const [owner] = await ethers.getSigners();
      const { chef, pools } = await farmWith(owner);
      const art = loadArtifact("CircleswapMasterChef");
      const c1 = flaky(hardhatClient(owner));
      await addPools(c1.client, art, await chef.getAddress(), pools, opts);
      expect(c1.counters.calls).to.equal(3);
      const c2 = flaky(hardhatClient(owner));
      await addPools(c2.client, art, await chef.getAddress(), pools, opts);
      expect(c2.counters.calls).to.equal(0);
      expect(await chef.poolLength()).to.equal(3);
    });

    it("refuses a farm that already has more pools than the list, or pools that do not match the list", async function () {
      const [owner] = await ethers.getSigners();
      const { chef, pools } = await farmWith(owner);
      const art = loadArtifact("CircleswapMasterChef");
      const client = hardhatClient(owner);
      await addPools(client, art, await chef.getAddress(), pools, opts);
      await expect(addPools(client, art, await chef.getAddress(), pools.slice(0, 2), opts)).to.be.rejectedWith("more than the 2 to add");

      const { chef: chef2 } = await farmWith(owner);
      await chef2.addPool(999, pools[0].lpToken); // right token, wrong allocation
      await expect(addPools(client, art, await chef2.getAddress(), pools, opts)).to.be.rejectedWith("allocPoint (already added)");
    });
  });

  // ---------------------------------------------------------------------------------------- salted init data
  describe("Quai appends a 4-byte salt to the init data: every contract must still construct correctly", function () {
    const salts = ["00000000", "deadbeef", "ffffffff"];

    async function deployRaw(signer: any, artName: string, args: unknown[], salt: string) {
      const art = loadArtifact(artName);
      const data = art.bytecode + new Interface(art.abi).encodeDeploy(args).slice(2) + salt;
      const tx = await signer.sendTransaction({ data, gasLimit: 12_000_000n });
      const receipt = await tx.wait();
      return ethers.getContractAt(artName, receipt!.contractAddress!);
    }

    for (const salt of salts) {
      it(`Qrb, the NFT and the farm all construct with salt 0x${salt}`, async function () {
        const [owner, royalty] = await ethers.getSigners();
        const qrb: any = await deployRaw(owner, "Qrb", [owner.address, ARWEAVE_URI], salt);
        expect(await qrb.owner()).to.equal(owner.address);
        expect(await qrb.artworkURI()).to.equal(ARWEAVE_URI); // the dynamic string argument survives the trailing bytes
        expect(await qrb.BOOST_BPS()).to.equal(BOOST_BPS);

        const nft: any = await deployRaw(owner, "QrbArtifactNFT", [owner.address, royalty.address, ARWEAVE_URI, await qrb.getAddress()], salt);
        expect(await nft.artworkURI()).to.equal(ARWEAVE_URI);
        expect(await nft.qrb()).to.equal(await qrb.getAddress());
        expect((await nft.royaltyInfo(1, 10_000))[0]).to.equal(royalty.address);

        const Mock = await ethers.getContractFactory("MockERC20");
        const [a, b] = [await Mock.deploy("a", "a"), await Mock.deploy("b", "b")];
        const chef: any = await deployRaw(
          owner,
          "CircleswapMasterChef",
          [owner.address, await a.getAddress(), await b.getAddress(), await qrb.getAddress(), 7n, 9n],
          salt
        );
        expect(await chef.rewardAPerSecond()).to.equal(7n);
        expect(await chef.qrb()).to.equal(await qrb.getAddress());
      });
    }

    it("the salt the grinder picks deploys correctly too, and the receipt address is the one we read", async function () {
      const [owner] = await ethers.getSigners();
      const art = loadArtifact("Qrb");
      const data = art.bytecode + new Interface(art.abi).encodeDeploy([owner.address, ARWEAVE_URI]).slice(2);
      const nonce = await ethers.provider.getTransactionCount(owner.address);
      const ground = grindCreationData(owner.address, nonce, data, () => true); // accept the first salt
      const client = hardhatClient(owner);
      const hash = await client.sendCreate(ground.data, 12_000_000n);
      const receipt = await client.getReceipt(hash);
      const qrb: any = await ethers.getContractAt("Qrb", contractAddressFromReceipt(receipt, hash));
      expect(await qrb.artworkURI()).to.equal(ARWEAVE_URI);
    });
  });

  // ---------------------------------------------------------------------------------------- artifacts
  describe("loadArtifact", function () {
    it("loads compiled contracts and rejects unknown names and interfaces", function () {
      expect(loadArtifact("Qrb").bytecode.length).to.be.gt(1000);
      expect(loadArtifact("CircleswapMasterChef").abi.some((f: any) => f.name === "qrb")).to.equal(true);
      expect(() => loadArtifact("DoesNotExist")).to.throw("No compiled artifact");
      expect(() => loadArtifact("IQrbBoost")).to.throw("no creation bytecode");
    });
  });

  // ---------------------------------------------------------------------------------------- record + generated file
  describe("deployment record and deployed.ts", function () {
    const addrs = {
      QRB: "0x00325150094E51107a931980Fdfc3bB1a4C48379",
      QRB_NFT: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
      MASTERCHEF: "0x004AFDb66677D177B759356D2367AeA3A79Fe58b",
      AMM_FACTORY: "0x0007E61D3C1fa9d3A8dA1e0F9d4E6e56C1a9c8B2",
      AMM_ROUTER: "0x003Ce6685Ff0C6b5F0bd6a0c93e9c2D2f3b7A1C4",
      ARTWORK_URI: ARWEAVE_URI
    };

    function evalDeployed(source: string): any {
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
      const mod: any = { exports: {} };
      new Function("module", "exports", js)(mod, mod.exports);
      return mod.exports.DEPLOYED;
    }

    it("renders a valid TypeScript module holding exactly the given addresses", function () {
      expect(evalDeployed(renderDeployedTs(addrs))).to.deep.equal(addrs);
    });

    it("refuses anything that is not a plain address or Arweave URI, so a bad value can never alter the module", function () {
      const bad = [
        { ...addrs, QRB: "0x00325150094E51107a931980Fdfc3bB1a4C4837" }, // 39 digits
        { ...addrs, QRB_NFT: "0x00325150094E51107a931980Fdfc3bB1a4C48379'; process.exit(1); //" },
        { ...addrs, MASTERCHEF: "not an address" },
        { ...addrs, AMM_FACTORY: "0x0007E61D3C1fa9d3A8dA1e0F9d4E6e56C1a9c8B" }, // 39 digits
        { ...addrs, AMM_ROUTER: "0x003Ce6685Ff0C6b5F0bd6a0c93e9c2D2f3b7A1C4\"; DEPLOYED.QRB = null; //" },
        { ...addrs, ARTWORK_URI: "https://raw.githubusercontent.com/BOLTEVM/Q0/main/QgoGIF.gif" },
        { ...addrs, ARTWORK_URI: ARWEAVE_URI + "'\nDEPLOYED.QRB = null" }
      ];
      for (const b of bad) expect(() => renderDeployedTs(b)).to.throw("Refusing to write");
    });

    it("renders a missing farm as null, not an empty string", function () {
      const d = evalDeployed(renderDeployedTs({ ...addrs, MASTERCHEF: null }));
      expect(d.MASTERCHEF).to.equal(null);
      expect(d.QRB).to.equal(addrs.QRB);
    });

    it("the AMM and Qrb deployments are independent: writing one keeps the other", function () {
      const ammOnly = { QRB: null, QRB_NFT: null, MASTERCHEF: null, AMM_FACTORY: addrs.AMM_FACTORY, AMM_ROUTER: addrs.AMM_ROUTER, ARTWORK_URI: null };
      const d = evalDeployed(renderDeployedTs(ammOnly));
      expect(d.QRB).to.equal(null);
      expect(d.AMM_FACTORY).to.equal(addrs.AMM_FACTORY);
      // deploying Qrb later, with the existing AMM values merged in, keeps the AMM addresses
      const merged = evalDeployed(renderDeployedTs({ ...ammOnly, QRB: addrs.QRB, QRB_NFT: addrs.QRB_NFT, ARTWORK_URI: ARWEAVE_URI }));
      expect(merged.AMM_ROUTER).to.equal(addrs.AMM_ROUTER);
      expect(merged.QRB).to.equal(addrs.QRB);
    });

    it("the record is JSON-safe (no bigint) and carries the receipt data", function () {
      const rec = deploymentRecord("cyprus1", 9n, addrs.QRB, ARWEAVE_URI, {
        dryRun: false,
        qrb: { dryRun: false, label: "Qrb", estimatedGas: 1n, gasLimit: 3n, maxFee: 9n, address: addrs.QRB, txHash: "0xabc", blockNumber: 5, gasUsed: 2n },
        qrbAddress: addrs.QRB
      });
      const round = JSON.parse(JSON.stringify(rec));
      expect(round.chainId).to.equal("9");
      expect(round.qrb.address).to.equal(addrs.QRB);
      expect(round.qrb.gasUsed).to.equal("2");
      expect(round.masterChef).to.equal(undefined);
    });
  });

  // ---------------------------------------------------------------------------------------- artwork
  describe("Arweave artwork", function () {
    it("extracts the txid from either URI form and rejects anything else", function () {
      expect(arweaveTxId(`ar://${TXID}`)).to.equal(TXID);
      expect(arweaveTxId(`https://arweave.net/${TXID}`)).to.equal(TXID);
      expect(gatewayUrl(`ar://${TXID}`)).to.equal(`https://arweave.net/${TXID}`);
      for (const bad of ["", "ar://short", `ipfs://${TXID}`, `https://example.com/${TXID}`, `https://arweave.net/${TXID}/x`, `https://raw.githubusercontent.com/a/b/main/c.gif`]) {
        expect(() => arweaveTxId(bad), bad).to.throw("not an Arweave URI");
      }
    });

    function tmpFile(bytes: Buffer): string {
      const f = path.join(os.tmpdir(), `qrb-art-${crypto.randomBytes(6).toString("hex")}.gif`);
      fs.writeFileSync(f, bytes);
      return f;
    }
    const ok = (bytes: Buffer) => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

    it("accepts a gateway that serves exactly the local file", async function () {
      const bytes = crypto.randomBytes(2048);
      const res = await verifyArtwork(ARWEAVE_URI, tmpFile(bytes), ok(bytes), 1, 1);
      expect(res.bytes).to.equal(2048);
      expect(res.sha256).to.equal(sha256Hex(bytes));
    });

    it("rejects a gateway serving different bytes, immediately (no retry)", async function () {
      const local = crypto.randomBytes(512);
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return ok(crypto.randomBytes(512))();
      };
      await expect(verifyArtwork(ARWEAVE_URI, tmpFile(local), fetchImpl, 3, 1)).to.be.rejectedWith("serves different bytes");
      expect(calls).to.equal(1);
    });

    it("rejects a truncated upload", async function () {
      const local = crypto.randomBytes(1000);
      await expect(verifyArtwork(ARWEAVE_URI, tmpFile(local), ok(local.subarray(0, 900)), 1, 1)).to.be.rejectedWith("different bytes");
    });

    it("rejects a 404, after retrying", async function () {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      };
      await expect(verifyArtwork(ARWEAVE_URI, tmpFile(Buffer.from("x")), fetchImpl, 3, 1)).to.be.rejectedWith("HTTP 404");
      expect(calls).to.equal(3);
    });

    it("succeeds once the gateway catches up, and survives a network error along the way", async function () {
      const bytes = crypto.randomBytes(256);
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        if (calls === 2) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return ok(bytes)();
      };
      const res = await verifyArtwork(ARWEAVE_URI, tmpFile(bytes), fetchImpl, 5, 1);
      expect(res.bytes).to.equal(256);
      expect(calls).to.equal(3);
    });

    it("refuses a non-Arweave URI before fetching anything", async function () {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return ok(Buffer.alloc(1))();
      };
      await expect(verifyArtwork("https://raw.githubusercontent.com/BOLTEVM/Q0/main/QgoGIF.gif", tmpFile(Buffer.alloc(1)), fetchImpl, 1, 1)).to.be.rejectedWith(
        "not an Arweave URI"
      );
      expect(calls).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------- Quai specifics
  describe("Quai client helpers", function () {
    /** A key whose address is a Cyprus-1 Quai address. Never funded. */
    function cyprus1Wallet(): Wallet {
      for (let i = 0; i < 20000; i++) {
        const w = new Wallet("0x" + crypto.randomBytes(32).toString("hex"));
        if (isCyprus1QuaiAddress(w.address)) return w;
      }
      throw new Error("no Cyprus-1 key found");
    }

    it("grinds init data until the derived address is a Cyprus-1 Quai address", function () {
      const w = cyprus1Wallet();
      const data = "0x6080" + crypto.randomBytes(200).toString("hex");
      const g = grindCreationData(w.address, 7, data);
      expect(g.data.startsWith(data)).to.equal(true);
      expect(g.data.length).to.equal(data.length + 8); // a 4-byte salt
      expect(g.predictedAddress).to.equal(getCreateAddress({ from: w.address, nonce: 7, data: g.data }));
      expect(getZoneForAddress(g.predictedAddress)).to.equal(Zone.Cyprus1);
      expect(isQiAddress(g.predictedAddress)).to.equal(false);
    });

    it("is deterministic for a given sender, nonce and data, and differs across nonces", function () {
      const w = cyprus1Wallet();
      const data = "0x6080" + crypto.randomBytes(64).toString("hex");
      expect(grindCreationData(w.address, 3, data)).to.deep.equal(grindCreationData(w.address, 3, data));
      expect(grindCreationData(w.address, 3, data).predictedAddress).to.not.equal(grindCreationData(w.address, 4, data).predictedAddress);
    });

    it("gives up loudly when no salt works", function () {
      const w = cyprus1Wallet();
      expect(() => grindCreationData(w.address, 0, "0x6080", () => false, 5)).to.throw("Could not grind");
    });

    it("assertCyprus1 accepts Cyprus-1 Quai addresses and rejects other zones", function () {
      expect(() => assertCyprus1("0x00325150094E51107a931980Fdfc3bB1a4C48379")).to.not.throw();
      expect(() => assertCyprus1("0x0100000000000000000000000000000000000001")).to.throw("not a Cyprus-1 Quai address");
      expect(() => assertCyprus1("0x2000000000000000000000000000000000000001")).to.throw("not a Cyprus-1 Quai address");
    });

    it("the client needs a key or a from address, and both must be Cyprus-1", function () {
      expect(() => new QuaiChainClient("cyprus1", {})).to.throw("needs a private key");
      expect(() => new QuaiChainClient("cyprus1", { from: "0x0100000000000000000000000000000000000001" })).to.throw("not a Cyprus-1 Quai address");
      const w = cyprus1Wallet();
      expect(new QuaiChainClient("cyprus1", { from: w.address }).deployer).to.equal(w.address);
      expect(new QuaiChainClient("cyprus1", { privateKey: w.privateKey }).deployer).to.equal(w.address);
    });

    it("a client with no key can simulate but refuses to send", async function () {
      const w = cyprus1Wallet();
      const client = new QuaiChainClient("cyprus1", { from: w.address });
      await expect(client.sendCreate("0x6080", 1n)).to.be.rejectedWith("No signer");
      await expect(client.sendCall(w.address, "0x", 1n)).to.be.rejectedWith("No signer");
    });
  });

  it("the boost figure the deploy check enforces is the contract's", function () {
    expect(BOOST_BPS).to.equal(5000n);
  });
});
