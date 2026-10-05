import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, BOOST_BPS, BOOST_THRESHOLD, BOOST_MATURITY, ARWEAVE_URI, AR_SCHEME_URI, TXID, decodeDataUri, deployQrb, stamp } from "./helpers";

describe("Qrb (ERC-20)", function () {
  async function fixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const qrb = await deployQrb(owner.address);
    return { qrb, owner, alice, bob, carol };
  }

  async function minted() {
    const f = await fixture();
    await f.qrb.mintGenesis(f.alice.address);
    return f;
  }

  describe("deployment", function () {
    it("has the expected identity and constants", async function () {
      const { qrb, owner } = await loadFixture(fixture);
      expect(await qrb.name()).to.equal("Circleswap Qrb");
      expect(await qrb.symbol()).to.equal("QRB");
      expect(await qrb.decimals()).to.equal(18);
      expect(await qrb.totalSupply()).to.equal(0);
      expect(await qrb.MAX_SUPPLY()).to.equal(E18);
      expect(await qrb.BOOST_BPS()).to.equal(BOOST_BPS);
      expect(await qrb.BOOST_THRESHOLD()).to.equal(BOOST_THRESHOLD);
      expect(await qrb.BOOST_MATURITY()).to.equal(BOOST_MATURITY);
      expect(await qrb.genesisMinted()).to.equal(false);
      expect(await qrb.owner()).to.equal(owner.address);
      expect(await qrb.artworkURI()).to.equal(ARWEAVE_URI);
    });

    it("threshold is 0.0001 QRB, so at most 10,000 accounts can hold it at once", async function () {
      const { qrb } = await loadFixture(fixture);
      expect(await qrb.BOOST_THRESHOLD()).to.equal(ethers.parseEther("0.0001"));
      expect((await qrb.MAX_SUPPLY()) / (await qrb.BOOST_THRESHOLD())).to.equal(10_000n);
    });

    it("accepts both ar:// and https://arweave.net/ artwork URIs", async function () {
      const [owner] = await ethers.getSigners();
      expect(await (await deployQrb(owner.address, AR_SCHEME_URI)).artworkURI()).to.equal(AR_SCHEME_URI);
      expect(await (await deployQrb(owner.address, ARWEAVE_URI)).artworkURI()).to.equal(ARWEAVE_URI);
    });

    for (const [name, uri] of [
      ["empty", ""],
      ["GitHub raw", "https://raw.githubusercontent.com/BOLTEVM/Q0/main/QgoGIF.gif"],
      ["IPFS", `ipfs://${TXID}`],
      ["short txid", `ar://${TXID.slice(1)}`],
      ["JSON-injecting", `ar://${"A".repeat(42)}"`]
    ] as const) {
      it(`rejects a non-Arweave artwork URI: ${name}`, async function () {
        const [owner] = await ethers.getSigners();
        const factory = await ethers.getContractFactory("Qrb");
        await expect(factory.deploy(owner.address, uri)).to.be.revertedWithCustomError(factory, "InvalidArtworkURI");
      });
    }

    it("rejects a zero owner", async function () {
      const factory = await ethers.getContractFactory("Qrb");
      await expect(factory.deploy(ethers.ZeroAddress, ARWEAVE_URI)).to.be.revertedWithCustomError(factory, "OwnableInvalidOwner");
    });

    it("has no way to change the artwork or contract URI after deployment", async function () {
      const { qrb } = await loadFixture(fixture);
      const writers = qrb.interface.fragments
        .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f: any) => f.name);
      expect(writers).to.not.include.members(["setContractURI", "setArtworkURI"]);
      expect(writers.filter((n: string) => /uri|artwork|metadata/i.test(n))).to.deep.equal([]);
    });
  });

  describe("mintGenesis", function () {
    it("mints exactly 1.0 QRB to the recipient and emits the events", async function () {
      const { qrb, alice } = await loadFixture(fixture);
      await expect(qrb.mintGenesis(alice.address))
        .to.emit(qrb, "QrbGenesisForged")
        .withArgs(alice.address, E18, ARWEAVE_URI)
        .and.to.emit(qrb, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, E18);
      expect(await qrb.totalSupply()).to.equal(E18);
      expect(await qrb.balanceOf(alice.address)).to.equal(E18);
      expect(await qrb.genesisMinted()).to.equal(true);
    });

    it("can be minted to the owner itself", async function () {
      const { qrb, owner } = await loadFixture(fixture);
      await qrb.mintGenesis(owner.address);
      expect(await qrb.balanceOf(owner.address)).to.equal(E18);
    });

    it("only the owner can mint", async function () {
      const { qrb, alice } = await loadFixture(fixture);
      await expect(qrb.connect(alice).mintGenesis(alice.address)).to.be.revertedWithCustomError(qrb, "OwnableUnauthorizedAccount");
      expect(await qrb.totalSupply()).to.equal(0);
    });

    it("rejects the zero address and leaves the mint available", async function () {
      const { qrb, alice } = await loadFixture(fixture);
      await expect(qrb.mintGenesis(ethers.ZeroAddress)).to.be.revertedWithCustomError(qrb, "InvalidRecipient");
      expect(await qrb.genesisMinted()).to.equal(false);
      await qrb.mintGenesis(alice.address);
      expect(await qrb.totalSupply()).to.equal(E18);
    });

    it("can never be minted twice", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await expect(qrb.mintGenesis(bob.address)).to.be.revertedWithCustomError(qrb, "MaxSupplyReached");
      await expect(qrb.mintGenesis(alice.address)).to.be.revertedWithCustomError(qrb, "MaxSupplyReached");
      expect(await qrb.totalSupply()).to.equal(E18);
    });

    it("stays minted after the whole supply is burned: no second genesis", async function () {
      const { qrb, alice, owner } = await loadFixture(minted);
      await qrb.connect(alice).burn(E18);
      expect(await qrb.totalSupply()).to.equal(0);
      expect(await qrb.genesisMinted()).to.equal(true);
      await expect(qrb.mintGenesis(owner.address)).to.be.revertedWithCustomError(qrb, "MaxSupplyReached");
    });

    it("total supply can never exceed MAX_SUPPLY", async function () {
      const { qrb } = await loadFixture(minted);
      expect(await qrb.totalSupply()).to.be.lte(await qrb.MAX_SUPPLY());
    });
  });

  describe("ERC-20 behaviour", function () {
    it("transfers and moves balances", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await expect(qrb.connect(alice).transfer(bob.address, E18 / 4n))
        .to.emit(qrb, "Transfer")
        .withArgs(alice.address, bob.address, E18 / 4n);
      expect(await qrb.balanceOf(alice.address)).to.equal((E18 * 3n) / 4n);
      expect(await qrb.balanceOf(bob.address)).to.equal(E18 / 4n);
    });

    it("reverts on insufficient balance", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await expect(qrb.connect(bob).transfer(alice.address, 1)).to.be.revertedWithCustomError(qrb, "ERC20InsufficientBalance");
      await expect(qrb.connect(alice).transfer(bob.address, E18 + 1n)).to.be.revertedWithCustomError(qrb, "ERC20InsufficientBalance");
    });

    it("reverts on a transfer to the zero address", async function () {
      const { qrb, alice } = await loadFixture(minted);
      await expect(qrb.connect(alice).transfer(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(qrb, "ERC20InvalidReceiver");
    });

    it("approve / transferFrom respect the allowance", async function () {
      const { qrb, alice, bob, carol } = await loadFixture(minted);
      await expect(qrb.connect(bob).transferFrom(alice.address, carol.address, 1)).to.be.revertedWithCustomError(
        qrb,
        "ERC20InsufficientAllowance"
      );
      await qrb.connect(alice).approve(bob.address, 1000);
      await qrb.connect(bob).transferFrom(alice.address, carol.address, 600);
      expect(await qrb.allowance(alice.address, bob.address)).to.equal(400);
      await expect(qrb.connect(bob).transferFrom(alice.address, carol.address, 401)).to.be.revertedWithCustomError(
        qrb,
        "ERC20InsufficientAllowance"
      );
    });

    it("an unlimited allowance is not decremented", async function () {
      const { qrb, alice, bob, carol } = await loadFixture(minted);
      await qrb.connect(alice).approve(bob.address, ethers.MaxUint256);
      await qrb.connect(bob).transferFrom(alice.address, carol.address, 5);
      expect(await qrb.allowance(alice.address, bob.address)).to.equal(ethers.MaxUint256);
    });
  });

  describe("burning", function () {
    it("burn reduces balance and supply", async function () {
      const { qrb, alice } = await loadFixture(minted);
      await qrb.connect(alice).burn(E18 / 2n);
      expect(await qrb.totalSupply()).to.equal(E18 / 2n);
      expect(await qrb.balanceOf(alice.address)).to.equal(E18 / 2n);
    });

    it("burnFrom needs an allowance and spends it", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await expect(qrb.connect(bob).burnFrom(alice.address, 10)).to.be.revertedWithCustomError(qrb, "ERC20InsufficientAllowance");
      await qrb.connect(alice).approve(bob.address, 10);
      await qrb.connect(bob).burnFrom(alice.address, 10);
      expect(await qrb.allowance(alice.address, bob.address)).to.equal(0);
      expect(await qrb.totalSupply()).to.equal(E18 - 10n);
    });

    it("cannot burn more than the balance", async function () {
      const { qrb, alice } = await loadFixture(minted);
      await expect(qrb.connect(alice).burn(E18 + 1n)).to.be.revertedWithCustomError(qrb, "ERC20InsufficientBalance");
    });
  });

  describe("EIP-2612 permit", function () {
    async function sign(qrb: any, owner: any, spender: string, value: bigint, deadline: bigint, nonce?: bigint) {
      const domain = {
        name: "Circleswap Qrb",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await qrb.getAddress()
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
      const n = nonce ?? (await qrb.nonces(owner.address));
      const sig = ethers.Signature.from(
        await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce: n, deadline })
      );
      return sig;
    }

    it("a valid signature sets the allowance and bumps the nonce", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      const deadline = BigInt((await time.latest()) + 3600);
      const sig = await sign(qrb, alice, bob.address, 777n, deadline);
      await qrb.permit(alice.address, bob.address, 777n, deadline, sig.v, sig.r, sig.s);
      expect(await qrb.allowance(alice.address, bob.address)).to.equal(777n);
      expect(await qrb.nonces(alice.address)).to.equal(1n);
    });

    it("rejects an expired signature", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      const deadline = BigInt((await time.latest()) + 10);
      const sig = await sign(qrb, alice, bob.address, 1n, deadline);
      await time.increase(100);
      await expect(qrb.permit(alice.address, bob.address, 1n, deadline, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(
        qrb,
        "ERC2612ExpiredSignature"
      );
    });

    it("rejects a replayed signature", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      const deadline = BigInt((await time.latest()) + 3600);
      const sig = await sign(qrb, alice, bob.address, 5n, deadline);
      await qrb.permit(alice.address, bob.address, 5n, deadline, sig.v, sig.r, sig.s);
      await expect(qrb.permit(alice.address, bob.address, 5n, deadline, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(
        qrb,
        "ERC2612InvalidSigner"
      );
    });

    it("rejects a signature by someone other than the owner", async function () {
      const { qrb, alice, bob, carol } = await loadFixture(minted);
      const deadline = BigInt((await time.latest()) + 3600);
      const sig = await sign(qrb, carol, bob.address, 5n, deadline);
      await expect(qrb.permit(alice.address, bob.address, 5n, deadline, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(
        qrb,
        "ERC2612InvalidSigner"
      );
    });

    it("rejects a signature whose amount was altered", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      const deadline = BigInt((await time.latest()) + 3600);
      const sig = await sign(qrb, alice, bob.address, 5n, deadline);
      await expect(qrb.permit(alice.address, bob.address, 6n, deadline, sig.v, sig.r, sig.s)).to.be.revertedWithCustomError(
        qrb,
        "ERC2612InvalidSigner"
      );
    });
  });

  describe("boost (IQrbBoost): threshold AND holding time", function () {
    const DAY = Number(BOOST_MATURITY);
    const at = async (tx: any) => Number(await stamp(tx));

    it("nobody is boosted at first: not the fresh recipient, not an account with no QRB, not the zero address", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(0); // holds the whole supply, but only just
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0);
      expect(await qrb.boostBpsOf(ethers.ZeroAddress)).to.equal(0);
    });

    it("is BOOST_BPS once the balance has been held for BOOST_MATURITY", async function () {
      const { qrb, alice } = await loadFixture(minted);
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(BOOST_BPS);
    });

    it("flips exactly at maturity: not boosted just before, boosted just after", async function () {
      const { qrb, alice } = await loadFixture(minted);
      const eligibleAt = Number(await qrb.boostEligibleAt(alice.address));
      await time.increaseTo(eligibleAt - 20);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(0);
      await time.increaseTo(eligibleAt + 20);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(BOOST_BPS);
    });

    it("boostEligibleAt is the moment the balance reached the threshold plus BOOST_MATURITY, and 0 below it", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(0);
      const t = await at(await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD));
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(t + DAY);
    });

    it("the clock starts when the balance reaches the threshold, not when it first receives dust", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD - 1n);
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(0);
      await time.increase(DAY * 3);
      const t = await at(await qrb.connect(alice).transfer(bob.address, 1));
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(t + DAY);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0); // three idle days on dust earned nothing
    });

    it("exactly the threshold qualifies once matured; one wei below never does, however long it is held", async function () {
      const { qrb, alice, bob, carol } = await loadFixture(minted);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD - 1n);
      await qrb.connect(alice).transfer(carol.address, BOOST_THRESHOLD);
      await time.increase(DAY * 30);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0);
      expect(await qrb.boostBpsOf(carol.address)).to.equal(BOOST_BPS);
    });

    it("more QRB than the threshold gives the same boost, not more", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD);
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(await qrb.boostBpsOf(bob.address));
    });

    it("topping up an account already at the threshold does not restart its clock", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      const t = await at(await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD));
      await time.increase(DAY / 2);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD);
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(t + DAY);
    });

    it("sending some away while staying at the threshold does not restart the clock", async function () {
      const { qrb, alice, bob, carol } = await loadFixture(minted);
      const t = await at(await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD * 3n));
      await time.increase(DAY / 2);
      await qrb.connect(bob).transfer(carol.address, BOOST_THRESHOLD); // still holds 2x threshold
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(t + DAY);
    });

    it("falling below the threshold resets the clock, and coming back starts a fresh one", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await qrb.connect(alice).transfer(bob.address, BOOST_THRESHOLD);
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(BOOST_BPS);

      await qrb.connect(bob).transfer(alice.address, 1); // one wei below
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(0);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0);

      const back = await at(await qrb.connect(alice).transfer(bob.address, 1));
      expect(await qrb.boostEligibleAt(bob.address)).to.equal(back + DAY);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0); // the old day does not count
    });

    it("moving QRB moves the boost only after the receiver has held it for the full period", async function () {
      const { qrb, alice, bob } = await loadFixture(minted);
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(BOOST_BPS);
      await qrb.connect(alice).transfer(bob.address, E18); // the whole supply
      expect(await qrb.boostBpsOf(alice.address)).to.equal(0); // gone at once from the sender
      expect(await qrb.boostBpsOf(bob.address)).to.equal(0); // not yet earned by the receiver
      await time.increase(DAY + 10);
      expect(await qrb.boostBpsOf(bob.address)).to.equal(BOOST_BPS);
    });

    it("a self-transfer changes nothing", async function () {
      const { qrb, alice } = await loadFixture(minted);
      const before = await qrb.boostEligibleAt(alice.address);
      await time.increase(1000);
      await qrb.connect(alice).transfer(alice.address, E18 / 2n);
      expect(await qrb.boostEligibleAt(alice.address)).to.equal(before);
    });

    it("burning below the threshold resets the clock", async function () {
      const { qrb, alice } = await loadFixture(minted);
      await time.increase(DAY + 10);
      await qrb.connect(alice).burn(E18 - BOOST_THRESHOLD + 1n);
      expect(await qrb.boostEligibleAt(alice.address)).to.equal(0);
      expect(await qrb.boostBpsOf(alice.address)).to.equal(0);
    });

    it("the genesis mint starts the recipient's clock", async function () {
      const { qrb, owner, alice } = await loadFixture(fixture);
      const t = await at(await qrb.connect(owner).mintGenesis(alice.address));
      expect(await qrb.boostEligibleAt(alice.address)).to.equal(t + DAY);
    });

    it("each threshold-sized unit boosts one wallet at a time; the supply holds at most 10,000 units", async function () {
      const { qrb, alice } = await loadFixture(minted);
      const wallets = [1, 2, 3].map(() => ethers.Wallet.createRandom());
      for (const w of wallets) await qrb.connect(alice).transfer(w.address, BOOST_THRESHOLD);
      await time.increase(DAY + 10);
      for (const w of wallets) expect(await qrb.boostBpsOf(w.address)).to.equal(BOOST_BPS);
      expect((await qrb.MAX_SUPPLY()) / (await qrb.BOOST_THRESHOLD())).to.equal(10_000n);
    });
  });

  describe("contractURI", function () {
    it("is valid JSON generated from the constants and the Arweave image", async function () {
      const { qrb } = await loadFixture(fixture);
      const meta = decodeDataUri(await qrb.contractURI());
      expect(meta.name).to.equal("Circleswap Qrb");
      expect(meta.symbol).to.equal("QRB");
      expect(meta.image).to.equal(ARWEAVE_URI);
      expect(meta.description).to.contain("+50%");
      expect(meta.description).to.contain("0.0001 QRB for 1 day");
      expect(meta.properties.max_supply).to.equal(1);
      expect(meta.properties.decimals).to.equal(18);
      expect(meta.properties.boost_bps).to.equal(Number(BOOST_BPS));
      expect(meta.properties.boost_threshold).to.equal("0.0001");
      expect(meta.properties.boost_maturity_seconds).to.equal(Number(BOOST_MATURITY));
    });

    it("points at Arweave only, never at a mutable host", async function () {
      const { qrb } = await loadFixture(fixture);
      const raw = Buffer.from((await qrb.contractURI()).split(",")[1], "base64").toString("utf8");
      expect(raw).to.not.match(/github|githubusercontent|ipfs|http:\/\//i);
      expect(raw).to.match(/https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}/);
    });

    it("works before and after the genesis mint", async function () {
      const { qrb, alice } = await loadFixture(fixture);
      const before = await qrb.contractURI();
      await qrb.mintGenesis(alice.address);
      expect(await qrb.contractURI()).to.equal(before);
    });
  });

  describe("ownership (two-step)", function () {
    it("transfer requires acceptance, and only the pending owner can accept", async function () {
      const { qrb, owner, alice, bob } = await loadFixture(fixture);
      await qrb.transferOwnership(alice.address);
      expect(await qrb.owner()).to.equal(owner.address);
      expect(await qrb.pendingOwner()).to.equal(alice.address);
      await expect(qrb.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(qrb, "OwnableUnauthorizedAccount");
      await qrb.connect(alice).acceptOwnership();
      expect(await qrb.owner()).to.equal(alice.address);
      expect(await qrb.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("the previous owner loses the mint right after handover", async function () {
      const { qrb, owner, alice, bob } = await loadFixture(fixture);
      await qrb.transferOwnership(alice.address);
      await qrb.connect(alice).acceptOwnership();
      await expect(qrb.connect(owner).mintGenesis(bob.address)).to.be.revertedWithCustomError(qrb, "OwnableUnauthorizedAccount");
      await qrb.connect(alice).mintGenesis(bob.address);
      expect(await qrb.balanceOf(bob.address)).to.equal(E18);
    });

    it("renouncing ownership after the mint leaves no admin at all", async function () {
      const { qrb, owner, alice } = await loadFixture(minted);
      await qrb.renounceOwnership();
      expect(await qrb.owner()).to.equal(ethers.ZeroAddress);
      await expect(qrb.connect(owner).mintGenesis(alice.address)).to.be.revertedWithCustomError(qrb, "OwnableUnauthorizedAccount");
      // The token keeps working without an owner.
      await qrb.connect(alice).transfer(owner.address, 1);
    });
  });
});
