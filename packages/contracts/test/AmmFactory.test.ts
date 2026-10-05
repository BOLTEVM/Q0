import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployAmm } from "./ammHelpers";

describe("Circleswap AMM: factory", function () {
  const fixture = () => deployAmm();

  describe("deployment", function () {
    it("deploys its own pool implementation, locked so nobody can use it", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      const impl = await ethers.getContractAt("CircleswapPair", await factory.pairImplementation());
      expect(await ethers.provider.getCode(await impl.getAddress())).to.not.equal("0x");
      expect(await impl.factory()).to.equal("0x0000000000000000000000000000000000000001");
      await expect(impl.initialize(await A.getAddress(), await B.getAddress())).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("starts with no pools, no protocol fee, and the given owner", async function () {
      const { factory, owner } = await loadFixture(fixture);
      expect(await factory.allPairsLength()).to.equal(0);
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
      expect(await factory.owner()).to.equal(owner.address);
    });

    it("rejects a zero owner", async function () {
      const f = await ethers.getContractFactory("CircleswapFactory");
      const impl = await f.deploy();
      const p = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        p.deploy(await impl.getAddress(), f.interface.encodeFunctionData("initialize", [ethers.ZeroAddress]))
      ).to.be.revertedWithCustomError(f, "OwnableInvalidOwner");
    });

    it("every AMM contract fits well inside the 24,576-byte limit", async function () {
      const { factory, router } = await loadFixture(fixture);
      for (const addr of [await factory.getAddress(), await router.getAddress(), await factory.pairImplementation()]) {
        const bytes = ((await ethers.provider.getCode(addr)).length - 2) / 2;
        expect(bytes).to.be.lt(24_000);
      }
    });
  });

  describe("createPair", function () {
    it("creates a pool, indexes it both ways, and emits PairCreated with sorted tokens", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      const [t0, t1] = a < b ? [a, b] : [b, a];
      const tx = await factory.createPair(a, b);
      const pair = await factory.getPair(a, b);
      await expect(tx).to.emit(factory, "PairCreated").withArgs(t0, t1, pair, 1);
      expect(pair).to.not.equal(ethers.ZeroAddress);
      expect(await factory.getPair(b, a)).to.equal(pair);
      expect(await factory.allPairsLength()).to.equal(1);
      expect(await factory.allPairs(0)).to.equal(pair);
    });

    it("the pool knows its factory and its tokens in sorted order, and cannot be initialised again", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await factory.createPair(b, a); // deliberately reversed
      const pair = await ethers.getContractAt("CircleswapPair", await factory.getPair(a, b));
      expect(await pair.factory()).to.equal(await factory.getAddress());
      expect(await pair.token0()).to.equal(a < b ? a : b);
      expect(await pair.token1()).to.equal(a < b ? b : a);
      await expect(pair.initialize(a, b)).to.be.revertedWithCustomError(pair, "InvalidInitialization");
    });

    it("each pool is a BeaconProxy instance pointing to the factory pairBeacon", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      await factory.createPair(await A.getAddress(), await B.getAddress());
      const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());
      const code = await ethers.provider.getCode(pairAddr);
      expect(code).to.not.equal("0x");
      const beaconSlot = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
      const storedBeacon = await ethers.provider.getStorage(pairAddr, beaconSlot);
      expect(ethers.getAddress(ethers.dataSlice(storedBeacon, 12))).to.equal(await factory.pairBeacon());
    });

    it("refuses identical tokens, the zero address, non-contracts, and duplicates in either order", async function () {
      const { factory, A, B, alice } = await loadFixture(fixture);
      const [a, b] = [await A.getAddress(), await B.getAddress()];
      await expect(factory.createPair(a, a)).to.be.revertedWithCustomError(factory, "IdenticalAddresses");
      await expect(factory.createPair(ethers.ZeroAddress, a)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.createPair(a, ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.createPair(a, alice.address)).to.be.revertedWithCustomError(factory, "InvalidToken");
      await factory.createPair(a, b);
      await expect(factory.createPair(a, b)).to.be.revertedWithCustomError(factory, "PairExists");
      await expect(factory.createPair(b, a)).to.be.revertedWithCustomError(factory, "PairExists");
    });

    it("is permissionless: anyone can create a pool", async function () {
      const { factory, A, B, alice } = await loadFixture(fixture);
      await factory.connect(alice).createPair(await A.getAddress(), await B.getAddress());
      expect(await factory.allPairsLength()).to.equal(1);
    });

    it("indexes many pools contiguously, each at its own address", async function () {
      const { factory, A, B, C, D } = await loadFixture(fixture);
      const tokens = [A, B, C, D];
      const seen = new Set<string>();
      let n = 0;
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          await factory.createPair(await tokens[i].getAddress(), await tokens[j].getAddress());
          n++;
          expect(await factory.allPairsLength()).to.equal(n);
          const addr = await factory.allPairs(n - 1);
          expect(seen.has(addr)).to.equal(false);
          seen.add(addr);
        }
      }
      expect(seen.size).to.equal(6);
    });
  });

  describe("the pool as an LP token", function () {
    it("has a fixed name and symbol even though it is a clone, and 18 decimals", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      await factory.createPair(await A.getAddress(), await B.getAddress());
      const pair = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await B.getAddress()));
      expect(await pair.name()).to.equal("Circleswap LP");
      expect(await pair.symbol()).to.equal("CSLP");
      expect(await pair.decimals()).to.equal(18);
      expect(await pair.totalSupply()).to.equal(0);
    });

    it("each pool has its own EIP-712 domain, bound to its own address", async function () {
      const { factory, A, B, C } = await loadFixture(fixture);
      await factory.createPair(await A.getAddress(), await B.getAddress());
      await factory.createPair(await A.getAddress(), await C.getAddress());
      const p1 = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await B.getAddress()));
      const p2 = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await C.getAddress()));
      expect(await p1.DOMAIN_SEPARATOR()).to.not.equal(await p2.DOMAIN_SEPARATOR());
      const d1 = await p1.eip712Domain();
      expect(d1.verifyingContract).to.equal(await p1.getAddress());
      expect(d1.name).to.equal("Circleswap LP");
    });
  });

  describe("protocol fee switch", function () {
    it("only the owner can set it, and it emits", async function () {
      const { factory, alice, bob } = await loadFixture(fixture);
      await expect(factory.connect(alice).setFeeTo(bob.address)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.setFeeTo(bob.address)).to.emit(factory, "FeeToUpdated").withArgs(ethers.ZeroAddress, bob.address);
      expect(await factory.feeTo()).to.equal(bob.address);
      await expect(factory.setFeeTo(ethers.ZeroAddress)).to.emit(factory, "FeeToUpdated").withArgs(bob.address, ethers.ZeroAddress);
    });

    it("ownership moves in two steps", async function () {
      const { factory, owner, alice, bob } = await loadFixture(fixture);
      await factory.transferOwnership(alice.address);
      expect(await factory.owner()).to.equal(owner.address);
      await expect(factory.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await factory.connect(alice).acceptOwnership();
      expect(await factory.owner()).to.equal(alice.address);
      await expect(factory.setFeeTo(bob.address)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("the owner has no power over pools: the factory exposes no way to touch reserves, fees or code", async function () {
      const { factory } = await loadFixture(fixture);
      const writers = factory.interface.fragments
        .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f: any) => f.name)
        .sort();
      expect(writers).to.deep.equal(["acceptOwnership", "createPair", "freezePairUpgrades", "initialize", "renounceOwnership", "setFeeTo", "setPairBeacon", "transferOwnership", "upgradePairImplementation", "upgradeToAndCall"]);
    });
  });

  describe("ABI compatibility with the standard constant-product interface (the app's encoders depend on it)", function () {
    it("factory, pool and router selectors match the well-known ones", async function () {
      const { factory, router } = await loadFixture(fixture);
      const pair = await ethers.getContractAt("CircleswapPair", await factory.pairImplementation());
      const sel = (c: any, name: string) => c.interface.getFunction(name)!.selector;
      expect(sel(factory, "getPair")).to.equal("0xe6a43905");
      expect(sel(factory, "createPair")).to.equal("0xc9c65396");
      expect(sel(factory, "allPairs")).to.equal("0x1e3dd18b");
      expect(sel(factory, "allPairsLength")).to.equal("0x574f2ba3");
      expect(sel(factory, "feeTo")).to.equal("0x017e7e58");
      expect(sel(pair, "getReserves")).to.equal("0x0902f1ac");
      expect(sel(pair, "token0")).to.equal("0x0dfe1681");
      expect(sel(pair, "token1")).to.equal("0xd21220a7");
      expect(sel(pair, "swap")).to.equal("0x022c0d9f");
      expect(sel(pair, "mint")).to.equal("0x6a627842");
      expect(sel(pair, "burn")).to.equal("0x89afcb44");
      expect(sel(pair, "factory")).to.equal("0xc45a0155");
      expect(sel(router, "factory")).to.equal("0xc45a0155");
      expect(sel(router, "WETH")).to.equal("0xad5c4648");
      expect(sel(router, "addLiquidity")).to.equal("0xe8e33700");
      expect(router.interface.getFunction("removeLiquidity")!.selector).to.equal("0xbaa2abde");
      expect(sel(router, "swapExactTokensForTokens")).to.equal("0x38ed1739");
      expect(sel(router, "swapTokensForExactTokens")).to.equal("0x8803dbee");
      expect(sel(router, "swapExactETHForTokens")).to.equal("0x7ff36ab5");
      expect(sel(router, "getAmountsOut")).to.equal("0xd06ca61f");
      expect(sel(router, "getAmountsIn")).to.equal("0x1f00ca74");
    });
  });
});
