import { expect } from "chai";
import { ethers } from "hardhat";
import { loadArtifact } from "../scripts/lib/artifacts";
import { deployAmm, verifyFactory, verifyRouter, type AmmConfig, type AmmProgress } from "../scripts/lib/amm";
import { ammRecord, renderDeployedTs } from "../scripts/lib/record";
import { E18, deadline } from "./ammHelpers";
import { hardhatClient, flaky, FAST } from "./chainClient";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

async function setup() {
  const [owner, other, lp, trader] = await ethers.getSigners();
  const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
  const Token = await ethers.getContractFactory("MockToken");
  const A = await Token.deploy("Token A", "AAA", 18);
  const B = await Token.deploy("Token B", "BBB", 18);
  const cfg = (over: Partial<AmmConfig> = {}): AmmConfig => ({
    owner: owner.address,
    wquai: wquai.target as string,
    probeTokens: [A.target as string, B.target as string],
    deploy: { ...FAST, broadcast: true },
    ...over
  });
  return { owner, other, lp, trader, wquai, A, B, cfg };
}

async function deployFactoryProxy(ownerAddr: string) {
  const Factory = await ethers.getContractFactory("CircleswapFactory");
  const impl = await Factory.deploy();
  const initData = Factory.interface.encodeFunctionData("initialize", [ownerAddr]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  return ethers.getContractAt("CircleswapFactory", await proxy.getAddress());
}

async function deployRouterProxy(factoryAddr: string, wquaiAddr: string, ownerAddr: string) {
  const Router = await ethers.getContractFactory("CircleswapRouter");
  const impl = await Router.deploy();
  const initData = Router.interface.encodeFunctionData("initialize", [factoryAddr, wquaiAddr, ownerAddr]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  return ethers.getContractAt("CircleswapRouter", await proxy.getAddress());
}

describe("deploy tooling: Circleswap AMM (factory + router)", function () {
  describe("a broadcast deployment", function () {
    it("reads both addresses off their receipts, and what it deploys works end to end", async function () {
      const { owner, lp, trader, A, B, cfg } = await setup();
      const client = hardhatClient(owner);
      const out = await deployAmm(client, cfg());

      expect(out.dryRun).to.equal(false);
      for (const r of [out.factory, out.router]) {
        expect(r.address).to.match(ADDR);
        expect((await client.getReceipt(r.txHash!))!.contractAddress).to.equal(r.address);
        expect(await client.getCode(r.address!)).to.not.equal("0x");
      }

      const factory = await ethers.getContractAt("CircleswapFactory", out.factory.address!);
      const router = await ethers.getContractAt("CircleswapRouter", out.router.address!);
      expect(await factory.owner()).to.equal(owner.address);
      expect(await router.factory()).to.equal(out.factory.address);
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress); // protocol fee off unless asked for

      // Create a pool through the deployed router, then trade against it.
      await A.mint(lp.address, 1_000_000n * E18);
      await B.mint(lp.address, 1_000_000n * E18);
      await A.connect(lp).approve(router.target, ethers.MaxUint256);
      await B.connect(lp).approve(router.target, ethers.MaxUint256);
      await router.connect(lp).addLiquidity(A.target, B.target, 1000n * E18, 4000n * E18, 0, 0, lp.address, await deadline());
      const pair = await ethers.getContractAt("CircleswapPair", await factory.getPair(A.target, B.target));
      expect(await pair.balanceOf(lp.address)).to.be.gt(0n);

      await A.mint(trader.address, 10n * E18);
      await A.connect(trader).approve(router.target, ethers.MaxUint256);
      await router.connect(trader).swapExactTokensForTokens(10n * E18, 1n, [A.target, B.target], trader.address, await deadline());
      expect(await B.balanceOf(trader.address)).to.be.gt(0n);
    });

    it("the pool implementation the factory owns is locked", async function () {
      const { owner, cfg } = await setup();
      const out = await deployAmm(hardhatClient(owner), cfg());
      const factory = await ethers.getContractAt("CircleswapFactory", out.factory.address!);
      const impl = await ethers.getContractAt("CircleswapPair", await factory.pairImplementation());
      expect(await impl.factory()).to.equal("0x0000000000000000000000000000000000000001");
      await expect(impl.initialize(ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address)).to.be.reverted;
    });

    it("the probe address it reports is exactly where the next pool lands, and nothing is created by probing", async function () {
      const { owner, A, B, cfg } = await setup();
      const out = await deployAmm(hardhatClient(owner), cfg());
      expect(out.probePoolAddress).to.match(ADDR);
      const factory = await ethers.getContractAt("CircleswapFactory", out.factory.address!);
      expect(await factory.allPairsLength()).to.equal(0n); // the static call created nothing
      await factory.createPair(A.target, B.target);
      expect(await factory.getPair(A.target, B.target)).to.equal(out.probePoolAddress);
    });

    it("stops if the pool address the factory would give is not acceptable (checkPoolAddress)", async function () {
      const { owner, cfg } = await setup();
      let seen: AmmProgress | undefined;
      await expect(
        deployAmm(hardhatClient(owner), cfg({
          checkPoolAddress: a => { throw new Error(`pool ${a} is not in the Cyprus-1 zone`); },
          onProgress: p => (seen = p)
        }))
      ).to.be.rejectedWith("is not in the Cyprus-1 zone");
      // Both contracts exist and stay on record even though the run failed afterwards.
      expect(seen!.factory).to.match(ADDR);
      expect(seen!.router).to.match(ADDR);
    });

    it("reports progress after every step, cumulatively", async function () {
      const { owner, other, cfg } = await setup();
      const seen: AmmProgress[] = [];
      await deployAmm(hardhatClient(owner), cfg({ feeTo: other.address, onProgress: p => seen.push(p) }));
      expect(seen.length).to.equal(3); // factory, router, feeTo
      expect(seen[0].factory).to.match(ADDR);
      expect(seen[0].router).to.equal(undefined); // earlier snapshots do not gain later fields
      expect(seen[1].router).to.match(ADDR);
      expect(seen[2].feeToSet).to.equal(true);
      expect(Object.keys(seen[2].txHashes)).to.have.members(["factory", "router", "setFeeTo"]);
    });
  });

  describe("protocol fee", function () {
    it("is off by default and turned on at deploy time only when asked", async function () {
      const { owner, other, cfg } = await setup();
      const on = await deployAmm(hardhatClient(owner), cfg({ feeTo: other.address }));
      const factory = await ethers.getContractAt("CircleswapFactory", on.factory.address!);
      expect(await factory.feeTo()).to.equal(other.address);
    });

    it("refuses before sending anything when the owner is not the deployer (only the owner can set it)", async function () {
      const { owner, other, cfg } = await setup();
      const f = flaky(hardhatClient(owner));
      await expect(deployAmm(f.client, cfg({ owner: other.address, feeTo: other.address }))).to.be.rejectedWith("feeTo needs owner == deployer");
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("a different owner without feeTo is fine: ownership is set at construction", async function () {
      const { owner, other, cfg } = await setup();
      const out = await deployAmm(hardhatClient(owner), cfg({ owner: other.address }));
      const factory = await ethers.getContractAt("CircleswapFactory", out.factory.address!);
      expect(await factory.owner()).to.equal(other.address);
    });
  });

  describe("a dry run", function () {
    it("prices the factory by simulation, projects the router and labels it so, and sends nothing", async function () {
      const { owner, cfg } = await setup();
      const f = flaky(hardhatClient(owner));
      const before = await ethers.provider.getTransactionCount(owner.address);
      const out = await deployAmm(f.client, cfg({ deploy: { ...FAST, broadcast: false } }));
      expect(out.dryRun).to.equal(true);
      expect(out.factory.projected).to.equal(undefined);
      expect(out.factory.address).to.equal(undefined);
      expect(out.factory.estimatedGas).to.be.gt(0n);
      expect(out.router.projected).to.equal(true);
      expect(out.router.estimatedGas).to.be.gt(0n);
      expect(out.router.maxFee).to.equal(out.router.gasLimit * (await f.client.getGasPrice()));
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
      expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(before);
    });

    it("ignores a resume request (nothing is adopted or sent)", async function () {
      const { owner, cfg } = await setup();
      const f = flaky(hardhatClient(owner));
      const out = await deployAmm(f.client, cfg({ resume: { factory: ethers.Wallet.createRandom().address }, deploy: { ...FAST, broadcast: false } }));
      expect(out.dryRun).to.equal(true);
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });
  });

  describe("an interrupted deployment can be finished without repeating anything", function () {
    it("a failure creating the router keeps the factory: resuming deploys only the router", async function () {
      const { owner, cfg } = await setup();
      let saved: AmmProgress | undefined;
      const first = flaky(hardhatClient(owner), { failCreate: 3 }); // factory is create #1 (impl) and #2 (proxy), router fails at #3
      await expect(deployAmm(first.client, cfg({ onProgress: p => (saved = p) }))).to.be.rejectedWith("simulated network failure");
      expect(saved!.factory).to.match(ADDR);
      expect(saved!.router).to.equal(undefined);

      const second = flaky(hardhatClient(owner));
      const out = await deployAmm(second.client, cfg({ resume: { factory: saved!.factory } }));
      expect(second.counters.creates).to.equal(2); // the router only (impl + proxy)
      expect(out.factory.address).to.equal(saved!.factory);
      expect(out.factory.resumed).to.equal(true);
      const router = await ethers.getContractAt("CircleswapRouter", out.router.address!);
      expect(await router.factory()).to.equal(saved!.factory);
    });

    it("a failure setting feeTo keeps both contracts: resuming sends only setFeeTo", async function () {
      const { owner, other, cfg } = await setup();
      let saved: AmmProgress | undefined;
      const first = flaky(hardhatClient(owner), { failCall: 1 });
      await expect(deployAmm(first.client, cfg({ feeTo: other.address, onProgress: p => (saved = p) }))).to.be.rejectedWith("simulated network failure");
      expect(saved!.factory && saved!.router).to.be.a("string");
      expect(saved!.feeToSet).to.equal(undefined);

      const second = flaky(hardhatClient(owner));
      const out = await deployAmm(second.client, cfg({ feeTo: other.address, resume: { factory: saved!.factory, router: saved!.router } }));
      expect(second.counters).to.deep.equal({ creates: 0, calls: 1 });
      const factory = await ethers.getContractAt("CircleswapFactory", out.factory.address!);
      expect(await factory.feeTo()).to.equal(other.address);
    });

    it("resuming a run that already finished changes nothing and does not error", async function () {
      const { owner, other, cfg } = await setup();
      let saved: AmmProgress | undefined;
      await deployAmm(hardhatClient(owner), cfg({ feeTo: other.address, onProgress: p => (saved = p) }));
      const again = flaky(hardhatClient(owner));
      await deployAmm(again.client, cfg({ feeTo: other.address, resume: { factory: saved!.factory, router: saved!.router } }));
      expect(again.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("skips the pool-address probe when that pool already exists", async function () {
      const { owner, A, B, cfg } = await setup();
      let saved: AmmProgress | undefined;
      await deployAmm(hardhatClient(owner), cfg({ onProgress: p => (saved = p) }));
      const factory = await ethers.getContractAt("CircleswapFactory", saved!.factory!);
      await factory.createPair(A.target, B.target);
      const out = await deployAmm(hardhatClient(owner), cfg({ resume: { factory: saved!.factory, router: saved!.router } }));
      expect(out.probePoolAddress).to.equal(undefined);
    });

    it("refuses to adopt an address with no code or the wrong contract", async function () {
      const { owner, A, cfg } = await setup();
      const client = hardhatClient(owner);
      await expect(deployAmm(client, cfg({ resume: { factory: ethers.Wallet.createRandom().address } }))).to.be.rejectedWith("has no code");
      await expect(deployAmm(client, cfg({ resume: { factory: A.target as string } }))).to.be.rejectedWith("compiled runtime is");
    });

    it("refuses to adopt a factory owned by someone else", async function () {
      const { owner, other, cfg } = await setup();
      const foreign = await deployFactoryProxy(other.address);
      await expect(deployAmm(hardhatClient(owner), cfg({ resume: { factory: foreign.target as string } }))).to.be.rejectedWith("Post-deploy check failed: Factory.owner");
    });

    it("refuses to adopt a router wired to a different factory or to a different WQUAI", async function () {
      const { owner, wquai, cfg } = await setup();
      const mine = await deployFactoryProxy(owner.address);
      const stranger = await deployFactoryProxy(owner.address);
      const wrongFactory = await deployRouterProxy(stranger.target as string, wquai.target as string, owner.address);
      await expect(
        deployAmm(hardhatClient(owner), cfg({ resume: { factory: mine.target as string, router: wrongFactory.target as string } }))
      ).to.be.rejectedWith("Post-deploy check failed: Router.factory");

      const otherWquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
      const wrongWeth = await deployRouterProxy(mine.target as string, otherWquai.target as string, owner.address);
      await expect(
        deployAmm(hardhatClient(owner), cfg({ resume: { factory: mine.target as string, router: wrongWeth.target as string } }))
      ).to.be.rejectedWith("Post-deploy check failed: Router.WETH");
    });
  });

  describe("verification helpers", function () {
    it("verifyFactory / verifyRouter accept the real contracts and reject the wrong owner", async function () {
      const { owner, other, wquai } = await setup();
      const client = hardhatClient(owner);
      const factory = await deployFactoryProxy(owner.address);
      const router = await deployRouterProxy(factory.target as string, wquai.target as string, owner.address);
      const [fa, pa, ra] = [loadArtifact("CircleswapFactory"), loadArtifact("CircleswapPair"), loadArtifact("CircleswapRouter")];
      await verifyFactory(client, fa, pa, factory.target as string, owner.address);
      await verifyRouter(client, ra, router.target as string, factory.target as string, wquai.target as string);
      await expect(verifyFactory(client, fa, pa, factory.target as string, other.address)).to.be.rejectedWith("Factory.owner");
    });
  });

  describe("the AMM record and deployed.ts", function () {
    it("the record is JSON-safe (no bigint) and carries the receipt data", async function () {
      const { owner, cfg } = await setup();
      const out = await deployAmm(hardhatClient(owner), cfg());
      const round = JSON.parse(JSON.stringify(ammRecord("cyprus1", 9n, owner.address, owner.address, out)));
      expect(round.chainId).to.equal("9");
      expect(round.factory.address).to.equal(out.factory.address);
      expect(round.router.address).to.equal(out.router.address);
      expect(round.factory.gasUsed).to.match(/^\d+$/);
      expect(round.probePoolAddress).to.equal(out.probePoolAddress);
    });

    it("the generated file carries the AMM addresses as read from the receipts", async function () {
      const { owner, cfg } = await setup();
      const out = await deployAmm(hardhatClient(owner), cfg());
      const src = renderDeployedTs({ QRB: null, QRB_NFT: null, MASTERCHEF: null, AMM_FACTORY: out.factory.address!, AMM_ROUTER: out.router.address!, ARTWORK_URI: null });
      expect(src).to.contain(`AMM_FACTORY: '${out.factory.address}'`);
      expect(src).to.contain(`AMM_ROUTER: '${out.router.address}'`);
    });
  });
});
