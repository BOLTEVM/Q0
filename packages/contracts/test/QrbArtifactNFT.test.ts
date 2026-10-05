import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ARWEAVE_URI, AR_SCHEME_URI, TXID, decodeDataUri, deployQrb, deployNft } from "./helpers";

describe("QrbArtifactNFT (ERC-721)", function () {
  async function fixture() {
    const [owner, royalty, alice, bob, carol] = await ethers.getSigners();
    const qrb = await deployQrb(owner.address);
    const nft = await deployNft(owner.address, royalty.address, await qrb.getAddress());
    return { qrb, nft, owner, royalty, alice, bob, carol };
  }

  async function minted() {
    const f = await fixture();
    await f.nft.mintArtifact(f.alice.address);
    return f;
  }

  describe("deployment", function () {
    it("has the expected identity and wiring", async function () {
      const { nft, qrb, owner } = await loadFixture(fixture);
      expect(await nft.name()).to.equal("Circleswap Qrb Artifact");
      expect(await nft.symbol()).to.equal("QRB-NFT");
      expect(await nft.MAX_SUPPLY()).to.equal(1);
      expect(await nft.TOKEN_ID()).to.equal(1);
      expect(await nft.ROYALTY_BPS()).to.equal(500);
      expect(await nft.qrb()).to.equal(await qrb.getAddress());
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.minted()).to.equal(false);
      expect(await nft.artworkURI()).to.equal(ARWEAVE_URI);
    });

    it("accepts an ar:// artwork URI", async function () {
      const { qrb, owner, royalty } = await loadFixture(fixture);
      const nft = await deployNft(owner.address, royalty.address, await qrb.getAddress(), AR_SCHEME_URI);
      expect(await nft.artworkURI()).to.equal(AR_SCHEME_URI);
    });

    for (const [name, uri] of [
      ["empty", ""],
      ["GitHub raw", "https://raw.githubusercontent.com/BOLTEVM/Q0/main/QgoGIF.gif"],
      ["IPFS", `ipfs://${TXID}`],
      ["short txid", `ar://${TXID.slice(1)}`]
    ] as const) {
      it(`rejects a non-Arweave artwork URI: ${name}`, async function () {
        const { qrb, owner, royalty } = await loadFixture(fixture);
        const factory = await ethers.getContractFactory("QrbArtifactNFT");
        await expect(factory.deploy(owner.address, royalty.address, uri, await qrb.getAddress())).to.be.revertedWithCustomError(
          factory,
          "InvalidArtworkURI"
        );
      });
    }

    it("rejects a contract that does not answer the boost interface: a wrong address would break tokenURI for good", async function () {
      const { owner, royalty } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("QrbArtifactNFT");
      const notQrb = await (await ethers.getContractFactory("MockERC20")).deploy("Not Qrb", "NQ"); // an ERC-20 without the boost view
      await expect(factory.deploy(owner.address, royalty.address, ARWEAVE_URI, await notQrb.getAddress())).to.be.revertedWithCustomError(
        factory,
        "InvalidQrb"
      );
      // A real boost source is accepted, and its tokenURI then works.
      const mock = await (await ethers.getContractFactory("MockBoost")).deploy();
      const nft = await factory.deploy(owner.address, royalty.address, ARWEAVE_URI, await mock.getAddress());
      await nft.mintArtifact(owner.address);
      expect(decodeDataUri(await nft.tokenURI(1)).image).to.equal(ARWEAVE_URI);
    });

    it("rejects a Qrb address that is the zero address or not a contract", async function () {
      const { owner, royalty, alice } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("QrbArtifactNFT");
      await expect(factory.deploy(owner.address, royalty.address, ARWEAVE_URI, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "InvalidQrb"
      );
      await expect(factory.deploy(owner.address, royalty.address, ARWEAVE_URI, alice.address)).to.be.revertedWithCustomError(
        factory,
        "InvalidQrb"
      );
    });

    it("rejects a zero royalty receiver and a zero owner", async function () {
      const { qrb, owner, royalty } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("QrbArtifactNFT");
      const q = await qrb.getAddress();
      await expect(factory.deploy(owner.address, ethers.ZeroAddress, ARWEAVE_URI, q)).to.be.revertedWithCustomError(
        factory,
        "ERC2981InvalidDefaultRoyaltyReceiver"
      );
      await expect(factory.deploy(ethers.ZeroAddress, royalty.address, ARWEAVE_URI, q)).to.be.revertedWithCustomError(
        factory,
        "OwnableInvalidOwner"
      );
    });
  });

  describe("mintArtifact", function () {
    it("mints token 1 to the recipient and emits the events", async function () {
      const { nft, alice } = await loadFixture(fixture);
      await expect(nft.mintArtifact(alice.address))
        .to.emit(nft, "ArtifactForged")
        .withArgs(alice.address, 1)
        .and.to.emit(nft, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, 1);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.balanceOf(alice.address)).to.equal(1);
      expect(await nft.minted()).to.equal(true);
    });

    it("only the owner can mint", async function () {
      const { nft, alice } = await loadFixture(fixture);
      await expect(nft.connect(alice).mintArtifact(alice.address)).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
      expect(await nft.minted()).to.equal(false);
    });

    it("can never be minted twice", async function () {
      const { nft, alice, bob } = await loadFixture(minted);
      await expect(nft.mintArtifact(bob.address)).to.be.revertedWithCustomError(nft, "MaxSupplyReached");
      await expect(nft.mintArtifact(alice.address)).to.be.revertedWithCustomError(nft, "MaxSupplyReached");
    });

    it("rejects the zero address", async function () {
      const { nft } = await loadFixture(fixture);
      await expect(nft.mintArtifact(ethers.ZeroAddress)).to.be.revertedWithCustomError(nft, "ERC721InvalidReceiver");
    });

    it("mints to a contract that implements onERC721Received", async function () {
      const { nft } = await loadFixture(fixture);
      const good = await (await ethers.getContractFactory("GoodReceiver")).deploy();
      await nft.mintArtifact(await good.getAddress());
      expect(await nft.ownerOf(1)).to.equal(await good.getAddress());
    });

    it("refuses a contract that cannot receive NFTs, and the failed mint does not use up the one-of-one", async function () {
      const { nft, alice } = await loadFixture(fixture);
      const bad = await (await ethers.getContractFactory("BadReceiver")).deploy();
      await expect(nft.mintArtifact(await bad.getAddress())).to.be.reverted;
      expect(await nft.minted()).to.equal(false);
      await nft.mintArtifact(alice.address);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it("a receiver that tries to mint again from its callback is refused", async function () {
      const { nft } = await loadFixture(fixture);
      const evil = await (await ethers.getContractFactory("ReenteringReceiver")).deploy();
      await evil.setNft(await nft.getAddress());
      await nft.mintArtifact(await evil.getAddress());
      expect(await evil.reentryReverted()).to.equal(true);
      expect(await nft.balanceOf(await evil.getAddress())).to.equal(1);
    });
  });

  describe("tokenURI", function () {
    it("reverts before the mint and for any other token id", async function () {
      const { nft } = await loadFixture(fixture);
      await expect(nft.tokenURI(1)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
      await nft.mintArtifact((await ethers.getSigners())[2].address);
      await expect(nft.tokenURI(2)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
      await expect(nft.tokenURI(0)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("is valid JSON with the Arweave image and honest attributes", async function () {
      const { nft, qrb } = await loadFixture(minted);
      const meta = decodeDataUri(await nft.tokenURI(1));
      expect(meta.name).to.equal("Circleswap Qrb #1 - Genesis Singularity");
      expect(meta.image).to.equal(ARWEAVE_URI);
      expect(meta).to.not.have.property("animation_url");
      const attr = (t: string) => meta.attributes.find((a: any) => a.trait_type === t)?.value;
      expect(attr("Edition")).to.equal("1 of 1 Genesis");
      expect(attr("Protocol")).to.equal("Circleswap");
      expect(attr("Shard")).to.equal("Cyprus-1");
      expect(attr("Companion Token")).to.equal((await qrb.getAddress()).toLowerCase());
    });

    it("reports the boost read from the Qrb contract, not a typed-in number", async function () {
      const { nft, qrb } = await loadFixture(minted);
      const meta = decodeDataUri(await nft.tokenURI(1));
      const boost = meta.attributes.find((a: any) => a.trait_type === "Qrb Farm Boost").value;
      // Built from qrb.BOOST_BPS() and qrb.BOOST_THRESHOLD().
      expect(await qrb.BOOST_BPS()).to.equal(5000n);
      expect(boost).to.equal("+50% for holders of at least 0.0001 QRB held for 1 day");
    });

    it("says plainly that the NFT itself grants no boost, and never claims the old 2.5x", async function () {
      const { nft } = await loadFixture(minted);
      const raw = Buffer.from((await nft.tokenURI(1)).split(",")[1], "base64").toString("utf8");
      const meta = JSON.parse(raw);
      expect(meta.description).to.contain("grants no boost itself");
      expect(raw).to.not.match(/2\.5x|Acceleration|Multiplier/i);
      expect(raw).to.not.match(/github|githubusercontent|ipfs|http:\/\//i);
    });

    it("cannot be changed by anyone: no metadata setter exists", async function () {
      const { nft } = await loadFixture(fixture);
      const writers = nft.interface.fragments
        .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f: any) => f.name);
      expect(writers.filter((n: string) => /uri|artwork|metadata|royalty/i.test(n))).to.deep.equal([]);
    });
  });

  describe("interfaces (ERC-165)", function () {
    it("supports ERC-165, ERC-721, ERC-721 Metadata and ERC-2981", async function () {
      const { nft } = await loadFixture(fixture);
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true);
      expect(await nft.supportsInterface("0x2a55205a")).to.equal(true);
    });

    it("does not claim ERC-4906 (metadata is immutable) or the invalid 0xffffffff", async function () {
      const { nft } = await loadFixture(fixture);
      expect(await nft.supportsInterface("0x49064906")).to.equal(false);
      expect(await nft.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("exposes no boost or holder hook: only the Qrb ERC-20 can give the boost", async function () {
      const { nft } = await loadFixture(fixture);
      const names = nft.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
      expect(names).to.not.include.members(["boostBpsOf", "isQrbHolder", "isArtifactHolder", "BOOST_BPS", "BOOST_THRESHOLD"]);
    });
  });

  describe("royalty (ERC-2981)", function () {
    it("is 5% to the configured receiver, which is not the owner", async function () {
      const { nft, royalty, owner } = await loadFixture(minted);
      const [receiver, amount] = await nft.royaltyInfo(1, 10_000);
      expect(receiver).to.equal(royalty.address);
      expect(receiver).to.not.equal(owner.address);
      expect(amount).to.equal(500);
    });

    it("scales with the sale price, including zero and very large prices", async function () {
      const { nft } = await loadFixture(minted);
      expect((await nft.royaltyInfo(1, 0))[1]).to.equal(0);
      expect((await nft.royaltyInfo(1, ethers.parseEther("100")))[1]).to.equal(ethers.parseEther("5"));
      expect((await nft.royaltyInfo(1, 19))[1]).to.equal(0); // rounds down: 19 * 5% = 0.95
      expect((await nft.royaltyInfo(1, 20))[1]).to.equal(1);
    });

    it("has no way to redirect the royalty", async function () {
      const { nft } = await loadFixture(fixture);
      expect(nft.interface.getFunction("setDefaultRoyalty")).to.equal(null);
    });
  });

  describe("transfers", function () {
    it("the holder can transfer, approve and operate; others cannot", async function () {
      const { nft, alice, bob, carol } = await loadFixture(minted);
      await expect(nft.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(
        nft,
        "ERC721InsufficientApproval"
      );
      await nft.connect(alice).approve(bob.address, 1);
      await nft.connect(bob).transferFrom(alice.address, carol.address, 1);
      expect(await nft.ownerOf(1)).to.equal(carol.address);
      expect(await nft.getApproved(1)).to.equal(ethers.ZeroAddress);
    });

    it("safeTransferFrom to a non-receiver contract reverts", async function () {
      const { nft, alice } = await loadFixture(minted);
      const bad = await (await ethers.getContractFactory("BadReceiver")).deploy();
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, await bad.getAddress(), 1)
      ).to.be.reverted;
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it("owning the NFT is independent of owning the contract", async function () {
      const { nft, owner, alice } = await loadFixture(minted);
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });
  });

  describe("ownership (two-step)", function () {
    it("transfer requires acceptance by the pending owner", async function () {
      const { nft, owner, alice, bob } = await loadFixture(fixture);
      await nft.transferOwnership(alice.address);
      expect(await nft.owner()).to.equal(owner.address);
      await expect(nft.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
      await nft.connect(alice).acceptOwnership();
      expect(await nft.owner()).to.equal(alice.address);
      await expect(nft.mintArtifact(bob.address)).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
      await nft.connect(alice).mintArtifact(bob.address);
      expect(await nft.ownerOf(1)).to.equal(bob.address);
    });
  });
});
