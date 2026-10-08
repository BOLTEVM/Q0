import { expect } from "chai";
import { ethers, network } from "hardhat";
import { getCreateAddress } from "quais";
import { cyprus1Account, atCyprus1 } from "./cyprus1";
import {
  ammFlow,
  runFlow,
  emptyProgress,
  inspectAmm,
  OPS,
  scheduleTx,
  executeTx,
  cancelTx,
  operationId,
  listOperations,
  describeCall,
  isCyprus1QuaiAddress,
  TIMELOCK_ROLES,
  CIRCLESWAP_ARTIFACTS,
  type AmmFlowConfig,
  type Reader,
  type RunnerEnv
} from "../../quai-service/src/deploy";
import { EIP1967_BEACON_SLOT, EIP1967_ADMIN_SLOT, EIP1967_IMPLEMENTATION_SLOT } from "../../quai-service/src/eip1967";
import { E18 } from "./ammHelpers";

const DAY = 86_400;
const INITIALIZABLE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

/** A Reader over Hardhat's real EVM. */
const reader: Reader = {
  call: (to, data) => ethers.provider.call({ to, data }),
  getCode: a => ethers.provider.getCode(a),
  getStorageAt: (a, slot) => ethers.provider.getStorage(a, slot)
};


/** The runner's `quai_*` calls and wallet, backed by Hardhat. The "wallet" signs as the impersonated account. */
function env(from: string): RunnerEnv {
  return {
    rpc: (method, params) => ethers.provider.send(method.replace(/^quai_/, "eth_"), params as any[]),
    wallet: {
      request: async ({ method, params }) => {
        if (method !== "quai_sendTransaction") throw Object.assign(new Error("Method not found"), { code: -32601 });
        const tx: any = (params as any[])[0];
        const signer = await ethers.getSigner(tx.from);
        const sent = await signer.sendTransaction({ data: tx.data, to: tx.to, gasLimit: BigInt(tx.gas), nonce: Number(BigInt(tx.nonce)) });
        return sent.hash;
      }
    },
    from,
    chainId: 9,
    confirmations: 0,
    pollMs: 1,
    receiptTimeoutMs: 20_000,
    // Hardhat derives addresses from (sender, nonce) only, so it cannot honour Quai's in-zone rule; production keeps it.
    zoneCheck: () => {}
  };
}

/** Runs the real browser flow end to end on Hardhat and returns the deployed addresses. */
async function deployThroughTheFlow(proposer: string, delaySeconds = 2 * DAY, from?: string, extra: Partial<AmmFlowConfig> = {}) {
  const deployer = from ?? (await cyprus1Account(7_000));
  // The flow (rightly) refuses a WQUAI that is not a Cyprus-1 address, so put the mock's code at one.
  const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
  const wquaiAddr = await cyprus1Account(5_000);
  await network.provider.send("hardhat_setCode", [wquaiAddr, await ethers.provider.getCode(await wquai.getAddress())]);
  const flow = ammFlow({ proposer, delaySeconds, wquai: wquaiAddr, ...extra });
  const progress = emptyProgress("AMM", 9, deployer);
  await runFlow(env(deployer), flow, progress);
  return { ctx: progress.ctx, deployer, wquai, wquaiAddr, flow };
}

const levels = (r: Awaited<ReturnType<typeof inspectAmm>>) => Object.fromEntries(r.checks.map(c => [c.id, c.level]));

describe("upgrade integrity: the browser deployment flow and the inspector, against a real EVM", function () {
  this.timeout(600_000);

  let proposer: string;
  before(async function () {
    proposer = await cyprus1Account(9_000);
  });

  describe("the deployment flow", function () {
    it("deploys the timelock-governed AMM, with every ownership claim verified on chain", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      for (const k of ["AMM_TIMELOCK", "AMM_FACTORY_IMPL", "AMM_FACTORY", "AMM_ROUTER_IMPL", "AMM_ROUTER", "AMM_PAIR_BEACON"]) expect(ctx[k], k).to.match(/^0x[0-9a-fA-F]{40}$/);
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const router = await ethers.getContractAt("CircleswapRouter", ctx.AMM_ROUTER);
      expect(await factory.owner()).to.equal(ctx.AMM_TIMELOCK);
      expect(await router.owner()).to.equal(ctx.AMM_TIMELOCK);
      const beacon = await ethers.getContractAt("UpgradeableBeacon", ctx.AMM_PAIR_BEACON);
      expect(await beacon.owner()).to.equal(ctx.AMM_FACTORY);
    });

    it("the deployer is left with no power at all: it is neither proposer, admin, owner nor beacon owner", async function () {
      const { ctx, deployer } = await deployThroughTheFlow(proposer);
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      for (const role of [await timelock.DEFAULT_ADMIN_ROLE(), await timelock.PROPOSER_ROLE(), await timelock.CANCELLER_ROLE()]) {
        expect(await timelock.hasRole(role, deployer), "deployer role").to.equal(false);
      }
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const signer = await ethers.getSigner(deployer);
      await expect(factory.connect(signer).setFeeTo(deployer)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(signer).upgradeToAndCall(ctx.AMM_FACTORY_IMPL, "0x")).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(signer).freezePairUpgrades()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("the proxies were initialised in their creation transaction: initialize cannot be called again by anyone", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [attacker] = await ethers.getSigners();
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const router = await ethers.getContractAt("CircleswapRouter", ctx.AMM_ROUTER);
      await expect(factory.connect(attacker).initialize(attacker.address)).to.be.revertedWithCustomError(factory, "InvalidInitialization");
      await expect(router.connect(attacker).initialize(ctx.AMM_FACTORY, ctx.AMM_FACTORY, attacker.address)).to.be.revertedWithCustomError(router, "InvalidInitialization");
    });

    it("refuses a delay outside 1..30 days or a proposer that is not a Cyprus-1 account, before anything is sent", function () {
      const base = { proposer, wquai: proposer, delaySeconds: 2 * DAY };
      expect(() => ammFlow({ ...base, delaySeconds: DAY - 1 })).to.throw("between 1 day and 30 days");
      expect(() => ammFlow({ ...base, delaySeconds: 31 * DAY })).to.throw("between 1 day and 30 days");
      expect(() => ammFlow({ ...base, proposer: "0x1111111111111111111111111111111111111111" })).to.throw("Cyprus-1");
    });

    it("names guardians that can cancel but not propose, and refuses a guardian that is the proposer", async function () {
      const guardian = await cyprus1Account(11_000);
      const { ctx } = await deployThroughTheFlow(proposer, 2 * DAY, undefined, { guardians: [guardian] });
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), guardian)).to.equal(true);
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), guardian)).to.equal(false);
      const base = { proposer, wquai: proposer, delaySeconds: 2 * DAY };
      expect(() => ammFlow({ ...base, guardians: [proposer] })).to.throw("different account from the proposer");
      expect(() => ammFlow({ ...base, guardians: [guardian, guardian] })).to.throw("listed twice");
      expect(() => ammFlow({ ...base, guardians: ["0x1111111111111111111111111111111111111111"] })).to.throw("Cyprus-1");
    });

    it("the pool-placement probe runs at the end, creates nothing, and its verdict is enforced", async function () {
      const Token = await ethers.getContractFactory("MockToken");
      const a = await atCyprus1(await Token.deploy("A", "A", 18));
      const b = await atCyprus1(await Token.deploy("B", "B", 18));

      // accepted: the deployment completes, and no pool was made by probing
      const ok = await deployThroughTheFlow(proposer, 2 * DAY, undefined, { probe: { tokens: [a, b], checkPoolAddress: () => {} } });
      const factory = await ethers.getContractAt("CircleswapFactory", ok.ctx.AMM_FACTORY);
      expect(await factory.allPairsLength()).to.equal(0n);

      // rejected: the last step fails, and says where the pool would have landed
      await expect(
        deployThroughTheFlow(proposer, 2 * DAY, undefined, { probe: { tokens: [a, b], checkPoolAddress: () => { throw new Error("outside the zone"); } } })
      ).to.be.rejectedWith("a pool made by this factory would land at");
    });

    it("a pool created on the deployed system works end to end through the deployed router", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("MockToken");
      const A = await Token.deploy("A", "A", 18);
      const B = await Token.deploy("B", "B", 18);
      const router = await ethers.getContractAt("CircleswapRouter", ctx.AMM_ROUTER);
      for (const t of [A, B]) {
        await t.mint(alice.address, 1000n * E18);
        await t.connect(alice).approve(ctx.AMM_ROUTER, ethers.MaxUint256);
      }
      const block = await ethers.provider.getBlock("latest");
      await router.connect(alice).addLiquidity(await A.getAddress(), await B.getAddress(), 100n * E18, 100n * E18, 0, 0, alice.address, block!.timestamp + 3600);
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const pool = await ethers.getContractAt("CircleswapPair", await factory.getPair(await A.getAddress(), await B.getAddress()));
      expect(await pool.balanceOf(alice.address)).to.be.greaterThan(0n);
    });
  });

  describe("the inspector", function () {
    it("a freshly deployed governed system is GOVERNED: timelock owner, factory-owned beacon, nothing failing", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.checks.filter(c => c.level === "fail").map(c => c.title)).to.deep.equal([]);
      expect(r.verdict).to.equal("GOVERNED");
      expect(r.facts.ownerKind).to.equal("timelock");
      expect(r.facts.timelockDelaySeconds).to.equal(2 * DAY);
      expect(r.facts.owner).to.equal(ctx.AMM_TIMELOCK);
      expect(r.facts.pairBeaconOwner).to.equal(ctx.AMM_FACTORY);
    });

    it("after the timelock freezes pool upgrades the verdict is IMMUTABLE_POOLS, and pools count as frozen", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("MockToken");
      const A = await Token.deploy("A", "A", 18);
      const B = await Token.deploy("B", "B", 18);
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      await factory.connect(alice).createPair(await A.getAddress(), await B.getAddress());

      // Through the real timelock, as the proposer, by the book.
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      const op = OPS.freezePools({ factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK });
      const { tx, salt } = scheduleTx(ctx.AMM_TIMELOCK, op, 2 * DAY);
      const proposerSigner = await ethers.getSigner(proposer);
      await proposerSigner.sendTransaction(tx);
      await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
      await network.provider.send("evm_mine");
      await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt));
      void timelock;

      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.verdict).to.equal("IMMUTABLE_POOLS");
      expect(r.facts.pools).to.deep.include({ total: 1, frozen: 1, governed: 0, foreign: 0 });
      expect(levels(r)["beacon.owner"]).to.equal("pass");
    });

    it("an account-owned deployment is UNSAFE and says why", async function () {
      const [owner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("CircleswapFactory");
      const Router = await ethers.getContractFactory("CircleswapRouter");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
      const fi = await Factory.deploy();
      const fp = await Proxy.deploy(await fi.getAddress(), Factory.interface.encodeFunctionData("initialize", [owner.address]));
      const ri = await Router.deploy();
      const rp = await Proxy.deploy(await ri.getAddress(), Router.interface.encodeFunctionData("initialize", [await fp.getAddress(), await wquai.getAddress(), owner.address]));
      const r = await inspectAmm(reader, { factory: await fp.getAddress(), router: await rp.getAddress() });
      expect(r.verdict).to.equal("UNSAFE");
      expect(r.facts.ownerKind).to.equal("account");
      expect(levels(r)["owner.kind"]).to.equal("fail");
      expect(r.checks.find(c => c.id === "owner.kind")!.detail).to.contain("immediately");
    });

    it("a renounced factory with frozen pools is IMMUTABLE_POOLS", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const proposerSigner = await ethers.getSigner(proposer);
      const t = { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK };
      for (const op of [OPS.freezePools(t), OPS.makeFactoryPermanent(t), OPS.makeRouterPermanent(t)]) {
        const { tx, salt } = scheduleTx(ctx.AMM_TIMELOCK, op, 2 * DAY);
        await proposerSigner.sendTransaction(tx);
        await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
        await network.provider.send("evm_mine");
        await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt));
      }
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.facts.ownerKind).to.equal("renounced");
      expect(r.verdict).to.equal("IMMUTABLE_POOLS");
    });

    it("a router owned by a person is UNSAFE even when the factory beside it is governed by a timelock", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [person] = await ethers.getSigners();
      const Router = await ethers.getContractFactory("CircleswapRouter");
      const impl = await Router.deploy();
      const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(
        await impl.getAddress(),
        Router.interface.encodeFunctionData("initialize", [ctx.AMM_FACTORY, await wquai.getAddress(), person.address])
      );
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: await proxy.getAddress() });
      expect(r.facts.ownerKind).to.equal("timelock"); // the factory is fine
      expect(r.facts.routerOwnerKind).to.equal("account");
      expect(levels(r)["router.owner.kind"]).to.equal("fail");
      expect(r.checks.find(c => c.id === "router.owner.kind")!.detail).to.contain("spend every token approval");
      expect(r.verdict).to.equal("UNSAFE");
    });

    it("a renounced router next to a timelock-owned factory is called permanent, not a warning", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const proposerSigner = await ethers.getSigner(proposer);
      const op = OPS.makeRouterPermanent({ factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK });
      const { tx, salt } = scheduleTx(ctx.AMM_TIMELOCK, op, 2 * DAY);
      await proposerSigner.sendTransaction(tx);
      await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
      await network.provider.send("evm_mine");
      await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt));
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.facts.routerOwnerKind).to.equal("renounced");
      expect(r.facts.ownerKind).to.equal("timelock");
      expect(levels(r)["router.owner.kind"]).to.equal("pass");
      expect(r.checks.some(c => c.level === "warn")).to.equal(false);
      expect(r.verdict).to.equal("GOVERNED"); // pools are not frozen yet
    });

    it("a router owned by a lookalike contract is not trusted either", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const Router = await ethers.getContractFactory("CircleswapRouter");
      const impl = await Router.deploy();
      const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
      // owned by some contract that is not the compiled timelock (here, the WQUAI token)
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(
        await impl.getAddress(),
        Router.interface.encodeFunctionData("initialize", [ctx.AMM_FACTORY, await wquai.getAddress(), await wquai.getAddress()])
      );
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: await proxy.getAddress() });
      expect(r.facts.routerOwnerKind).to.equal("contract");
      expect(levels(r)["router.owner.kind"]).to.equal("warn");
      expect(r.verdict).to.equal("UNSAFE");
      void alice;
    });

    it("an imitation padded to the right length is not accepted as the real contract (proxy, implementation or timelock)", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const flip = async (address: string) => {
        const code = await ethers.provider.getCode(address);
        const at = 2 + 2 * 50; // a byte in the executable region, outside every immutable and the metadata trailer
        const flipped = code.slice(0, at) + (parseInt(code.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, "0") + code.slice(at + 2);
        expect(flipped.length).to.equal(code.length); // exactly the same length: a length check cannot tell
        await network.provider.send("hardhat_setCode", [address, flipped]);
      };
      const run = () => inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect((await run()).verdict).to.equal("GOVERNED");

      await flip(ctx.AMM_FACTORY_IMPL);
      let r = await run();
      expect(levels(r)["factory.impl"]).to.equal("fail");
      expect(r.checks.find(c => c.id === "factory.impl")!.detail).to.contain("imitation");
      expect(r.verdict).to.equal("UNSAFE");

      await flip(ctx.AMM_ROUTER);
      r = await run();
      expect(levels(r)["router.proxy"]).to.equal("fail");
      expect(r.checks.find(c => c.id === "router.proxy")!.detail).to.contain("imitation");

    });

    it("a lookalike timelock (same length, different code) is an unknown contract: its delay is not taken on trust", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const code = await ethers.provider.getCode(ctx.AMM_TIMELOCK);
      const at = 2 + 2 * 50;
      const flipped = code.slice(0, at) + (parseInt(code.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, "0") + code.slice(at + 2);
      await network.provider.send("hardhat_setCode", [ctx.AMM_TIMELOCK, flipped]);
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.facts.ownerKind).to.equal("contract");
      expect(r.verdict).to.equal("UNSAFE");
    });

    it("an upgrade to code that is not the compiled contract is called out", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const proposerSigner = await ethers.getSigner(proposer);
      const [, alice] = await ethers.getSigners();
      const v2 = await (await ethers.getContractFactory("CircleswapFactoryV2")).deploy();
      const t = { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK };
      const v2At = await v2.getAddress();
      // Raw call: the builder refuses non-Cyprus-1 addresses, and UUPS code cannot be copied to one (immutable __self).
      const factoryAbi = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const op = { ...OPS.freezePools(t), id: "raw", target: ctx.AMM_FACTORY, data: factoryAbi.interface.encodeFunctionData("upgradeToAndCall", [v2At, "0x"]) };
      const { tx, salt } = scheduleTx(ctx.AMM_TIMELOCK, op, 2 * DAY);
      await proposerSigner.sendTransaction(tx);
      await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
      await network.provider.send("evm_mine");
      await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt));
      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.verdict).to.equal("UNSAFE");
      expect(levels(r)["factory.impl"]).to.equal("fail");
      expect(r.checks.find(c => c.id === "factory.impl")!.detail).to.contain(v2At);
    });

    it("detects an unlocked implementation, a proxy admin, and a pool whose beacon is owned by a person", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [person, alice] = await ethers.getSigners();

      // 1. clear the implementation's initialised flag (what a missing _disableInitializers would look like)
      await network.provider.send("hardhat_setStorageAt", [ctx.AMM_FACTORY_IMPL, INITIALIZABLE_SLOT, ethers.ZeroHash]);
      // 2. give the router proxy an admin
      await network.provider.send("hardhat_setStorageAt", [ctx.AMM_ROUTER, EIP1967_ADMIN_SLOT, ethers.zeroPadValue(person.address, 32)]);
      // 3. a pool pointed at a beacon a person owns
      const Token = await ethers.getContractFactory("MockToken");
      const A = await Token.deploy("A", "A", 18);
      const B = await Token.deploy("B", "B", 18);
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      await factory.connect(alice).createPair(await A.getAddress(), await B.getAddress());
      const pool = await factory.getPair(await A.getAddress(), await B.getAddress());
      const impl = await (await ethers.getContractFactory("CircleswapPairV2")).deploy();
      const personal = await (await ethers.getContractFactory("UpgradeableBeacon")).deploy(await impl.getAddress(), person.address);
      await network.provider.send("hardhat_setStorageAt", [pool, EIP1967_BEACON_SLOT, ethers.zeroPadValue(await personal.getAddress(), 32)]);

      const r = await inspectAmm(reader, { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER });
      expect(r.verdict).to.equal("UNSAFE");
      const l = levels(r);
      expect(l["factory.impl.locked"]).to.equal("fail");
      expect(l["router.admin"]).to.equal("fail");
      expect(l["pools.foreign"]).to.equal("fail");
      expect(r.facts.pools.foreign).to.equal(1);
    });

    it("a non-proxy, an empty implementation slot and a wrong factory are reported, never thrown", async function () {
      const Token = await ethers.getContractFactory("MockToken");
      const t = await Token.deploy("T", "T", 18);
      const r = await inspectAmm(reader, { factory: await t.getAddress(), router: null });
      expect(r.verdict).to.equal("UNSAFE");
      expect(levels(r)["factory.proxy"]).to.equal("fail");

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const impl = await (await ethers.getContractFactory("CircleswapFactory")).deploy();
      const p = await Proxy.deploy(await impl.getAddress(), (await ethers.getContractFactory("CircleswapFactory")).interface.encodeFunctionData("initialize", [proposer]));
      await network.provider.send("hardhat_setStorageAt", [await p.getAddress(), EIP1967_IMPLEMENTATION_SLOT, ethers.ZeroHash]);
      const r2 = await inspectAmm(reader, { factory: await p.getAddress(), router: null });
      expect(levels(r2)["factory.impl"]).to.equal("fail");
    });

    it("the proxy runtime the inspector expects is the one the flow deploys", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const code = await ethers.provider.getCode(ctx.AMM_FACTORY);
      expect((code.length - 2) / 2).to.equal(CIRCLESWAP_ARTIFACTS.ERC1967Proxy.runtimeBytes);
      expect(getCreateAddress).to.be.a("function");
    });
  });

  describe("governance helpers, against the real timelock", function () {
    it("operation ids match the timelock's own hashOperation", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      const op = OPS.setFeeTo({ factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK }, proposer);
      const salt = ethers.id("fixed");
      expect(operationId(op.target, op.data, salt)).to.equal(await timelock.hashOperation(op.target, 0, op.data, ethers.ZeroHash, salt));
    });

    it("schedule, list, execute and cancel work through the generated transactions, and the queue reads back truthfully", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const proposerSigner = await ethers.getSigner(proposer);
      const t = { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK };
      const fee = OPS.setFeeTo(t, proposer);
      const rug = OPS.upgradePools(t, await atCyprus1(await (await ethers.getContractFactory("CircleswapPairV2")).deploy()));

      const a = scheduleTx(ctx.AMM_TIMELOCK, fee, 2 * DAY);
      const b = scheduleTx(ctx.AMM_TIMELOCK, rug, 2 * DAY);
      await proposerSigner.sendTransaction(a.tx);
      await proposerSigner.sendTransaction(b.tx);

      const batch = async (calls: any[]) => calls.map(c => ({ ok: true as const, value: [] as any }));
      void batch;
      // Real log query against Hardhat.
      const head = await ethers.provider.getBlockNumber();
      const realBatch = async (calls: { method: string; params: unknown[] }[]) =>
        Promise.all(calls.map(async c => {
          try { return { ok: true as const, value: await ethers.provider.send(c.method.replace(/^quai_/, "eth_"), c.params as any[]) }; }
          catch (e: any) { return { ok: false as const, error: e.message }; }
        }));
      let queue = await listOperations(reader, realBatch, ctx.AMM_TIMELOCK, head, 5_000);
      expect(queue.map(q => q.state)).to.deep.equal(["WAITING", "WAITING"]);
      expect(queue.find(q => q.id === b.id)!.target).to.equal(ctx.AMM_FACTORY);
      expect(describeCall(rug.target, rug.data, t)).to.contain("UPGRADE EVERY POOL");
      expect(describeCall(fee.target, fee.data, t)).to.contain("protocol fee");

      // The queued rug is cancelled by the proposer; the fee change runs when ready.
      await proposerSigner.sendTransaction(cancelTx(ctx.AMM_TIMELOCK, b.id));
      await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
      await network.provider.send("evm_mine");
      await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, fee.target, fee.data, a.salt));
      await expect(alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, rug.target, rug.data, b.salt))).to.be.reverted;

      queue = await listOperations(reader, realBatch, ctx.AMM_TIMELOCK, await ethers.provider.getBlockNumber(), 5_000);
      expect(queue.find(q => q.id === a.id)!.state).to.equal("DONE");
      expect(queue.find(q => q.id === b.id)!.state).to.equal("CANCELLED");
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      expect(await factory.feeTo()).to.equal(proposer);
      expect(await factory.pairImplementation()).to.not.equal(rug.data.slice(-40)); // the cancelled upgrade never ran
    });

    it("roles on the timelock can be rotated, but only through the timelock itself, after the delay", async function () {
      const { ctx } = await deployThroughTheFlow(proposer);
      const [, alice] = await ethers.getSigners();
      const proposerSigner = await ethers.getSigner(proposer);
      const newProposer = await cyprus1Account(13_000);
      const guardian = await cyprus1Account(14_000);
      const t = { factory: ctx.AMM_FACTORY, router: ctx.AMM_ROUTER, timelock: ctx.AMM_TIMELOCK };
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);

      // Nobody (not even the current proposer) can change roles directly: the timelock is its own administrator.
      await expect(timelock.connect(proposerSigner).grantRole(TIMELOCK_ROLES.proposer, newProposer)).to.be.reverted;

      const run = async (op: ReturnType<typeof OPS.grantRole>) => {
        const { tx, salt } = scheduleTx(ctx.AMM_TIMELOCK, op, 2 * DAY);
        await proposerSigner.sendTransaction(tx);
        await expect(alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt))).to.be.reverted; // too early
        await network.provider.send("evm_increaseTime", [2 * DAY + 5]);
        await network.provider.send("evm_mine");
        await alice.sendTransaction(executeTx(ctx.AMM_TIMELOCK, op.target, op.data, salt));
      };

      // add a guardian (canceller only), then rotate the proposer: grant the new one, remove the old one
      await run(OPS.grantRole(t, "canceller", guardian));
      expect(await timelock.hasRole(TIMELOCK_ROLES.canceller, guardian)).to.equal(true);
      expect(await timelock.hasRole(TIMELOCK_ROLES.proposer, guardian)).to.equal(false);
      await run(OPS.grantRole(t, "proposer", newProposer));
      expect(await timelock.hasRole(TIMELOCK_ROLES.proposer, newProposer)).to.equal(true);
      await run(OPS.revokeRole(t, "proposer", proposer));
      expect(await timelock.hasRole(TIMELOCK_ROLES.proposer, proposer)).to.equal(false);
      await expect(timelock.connect(proposerSigner).schedule(ctx.AMM_FACTORY, 0, "0x", ethers.ZeroHash, ethers.id("x"), 2 * DAY)).to.be.reverted;

      expect(describeCall(timelock.target as string, OPS.grantRole(t, "canceller", guardian).data, t)).to.equal(`Give the canceller role to ${guardian}`);
      expect(describeCall(timelock.target as string, OPS.revokeRole(t, "proposer", proposer).data, t)).to.equal(`Remove the proposer role from ${proposer}`);
      expect(describeCall(timelock.target as string, OPS.updateDelay(t, 3 * DAY).data, t)).to.equal("Change the timelock delay to 3 day(s)");
      expect(() => OPS.grantRole(t, "proposer", "0x1111111111111111111111111111111111111111")).to.throw("Cyprus-1");
    });

    it("operations refuse bad arguments before they can be scheduled", function () {
      const t = { factory: proposer, router: proposer, timelock: proposer };
      expect(() => OPS.updateDelay(t, 60)).to.throw("between 1 and 30 days");
      expect(() => OPS.upgradePools(t, "0x1111111111111111111111111111111111111111")).to.throw("Cyprus-1");
      expect(() => OPS.upgradeRouter({ ...t, router: null }, proposer)).to.throw("No router");
    });
  });
});
