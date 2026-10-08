import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "hardhat";
import { buildBundle, writeBundle } from "../scripts/verification-bundle";
import { loadArtifact } from "../scripts/lib/artifacts";
import { deployAmm, fingerprintOf, assertGeneratedMatchesCompiled, readerOf, type AmmConfig, type AmmProgress } from "../scripts/lib/amm";
import { assessAmmSettings, gatherAmmFacts, RECOMMENDED_MIN_DELAY, type AmmFacts, type AmmSettings } from "../../quai-service/src/deploy/policy";
import { ammRecord, renderDeployedTs } from "../scripts/lib/record";
import type { ChainClient } from "../scripts/lib/chain";
import { E18, deadline } from "./ammHelpers";
import { cyprus1Account, atCyprus1 } from "./cyprus1";
import { hardhatClient, flaky, FAST } from "./chainClient";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
const STEPS = ["timelock", "factoryImpl", "factoryProxy", "routerImpl", "routerProxy"];

/**
 * A deployer, a proposer and a guardian that are valid Cyprus-1 accounts, a WQUAI at a Cyprus-1 address, and two probe tokens
 * likewise. (The plan refuses any other address. Hardhat cannot grind in-zone contract addresses, so the pool-placement rule
 * is relaxed here; production keeps it, and the integrity suite pins that.)
 */
async function setup() {
  const deployer = await cyprus1Account(100_000);
  const proposer = await cyprus1Account(110_000);
  const guardian = await cyprus1Account(120_000);
  const [, alice, bob] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const A = await Token.deploy("Token A", "AAA", 18);
  const B = await Token.deploy("Token B", "BBB", 18);
  const wquai = await atCyprus1(await (await ethers.getContractFactory("MockWQUAI")).deploy());
  const probeA = await atCyprus1(await Token.deploy("Probe A", "PA", 18));
  const probeB = await atCyprus1(await Token.deploy("Probe B", "PB", 18));
  const signer = await ethers.getSigner(deployer);
  const cfg = (over: Partial<AmmConfig> = {}): AmmConfig => ({
    proposer,
    delaySeconds: 2 * DAY,
    wquai,
    probe: { tokens: [probeA, probeB], checkPoolAddress: () => {} },
    deploy: { ...FAST, broadcast: true },
    ...over
  });
  return { deployer, proposer, guardian, alice, bob, signer, A, B, wquai, probeA, probeB, cfg, client: () => hardhatClient(signer) };
}

/** A client that mines the Nth creation but then loses the connection while waiting for its receipt. */
function dropsReceiptAfterCreate(base: ChainClient, n: number): ChainClient {
  let creates = 0;
  let armed = false;
  return {
    ...base,
    sendCreate: async (d, g) => {
      creates++;
      const hash = await base.sendCreate(d, g);
      if (creates === n) armed = true;
      return hash;
    },
    getReceipt: async h => {
      if (armed) {
        armed = false;
        throw new Error("simulated connection drop while waiting for the receipt");
      }
      return base.getReceipt(h);
    }
  };
}

describe("deploy tooling: Circleswap AMM (timelock + factory + router)", function () {
  this.timeout(600_000);

  describe("a broadcast deployment", function () {
    it("runs the shared plan: five transactions, every address read off its receipt, everything owned by the timelock", async function () {
      const { client, deployer, proposer, cfg } = await setup();
      const c = client();
      const out = await deployAmm(c, cfg());

      expect(out.dryRun).to.equal(false);
      expect(out.steps.map(s => s.stepId)).to.deep.equal(STEPS);
      for (const s of out.steps) {
        expect(s.address).to.match(ADDR);
        expect((await c.getReceipt(s.txHash!))!.contractAddress).to.equal(s.address);
        expect(await c.getCode(s.address!)).to.not.equal("0x");
      }
      const { ctx } = out;
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const router = await ethers.getContractAt("CircleswapRouter", ctx.AMM_ROUTER);
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      expect(await factory.owner()).to.equal(ctx.AMM_TIMELOCK);
      expect(await router.owner()).to.equal(ctx.AMM_TIMELOCK);
      expect(await router.factory()).to.equal(ctx.AMM_FACTORY);
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress); // protocol fee off until the timelock turns it on
      expect(await timelock.getMinDelay()).to.equal(2n * BigInt(DAY));

      // The deploying key ends with no power at all.
      for (const role of [await timelock.DEFAULT_ADMIN_ROLE(), await timelock.PROPOSER_ROLE(), await timelock.CANCELLER_ROLE()]) {
        expect(await timelock.hasRole(role, deployer)).to.equal(false);
      }
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), proposer)).to.equal(true);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(true); // open execution

      // The finished system was judged from the chain alone, and passed.
      expect(out.integrity!.verdict).to.equal("GOVERNED");
      expect(out.integrity!.checks.filter(x => x.level === "fail")).to.deep.equal([]);
    });

    it("what it deploys works end to end: a pool made through the router, then a trade", async function () {
      const { client, A, B, alice, bob, cfg } = await setup();
      const out = await deployAmm(client(), cfg());
      const factory = await ethers.getContractAt("CircleswapFactory", out.ctx.AMM_FACTORY);
      const router = await ethers.getContractAt("CircleswapRouter", out.ctx.AMM_ROUTER);

      for (const u of [alice, bob]) {
        await A.mint(u.address, 1_000_000n * E18);
        await B.mint(u.address, 1_000_000n * E18);
        await A.connect(u).approve(router.target, ethers.MaxUint256);
        await B.connect(u).approve(router.target, ethers.MaxUint256);
      }
      await router.connect(alice).addLiquidity(A.target, B.target, 1000n * E18, 4000n * E18, 0, 0, alice.address, await deadline());
      const pair = await ethers.getContractAt("CircleswapPair", await factory.getPair(A.target, B.target));
      expect(await pair.balanceOf(alice.address)).to.be.gt(0n);
      await router.connect(bob).swapExactTokensForTokens(10n * E18, 1n, [A.target, B.target], bob.address, await deadline());
      expect(await B.balanceOf(bob.address)).to.be.gt(1_000_000n * E18);
    });

    it("the implementations are locked and the proxies cannot be initialised again, by anyone", async function () {
      const { client, alice, cfg } = await setup();
      const { ctx } = await deployAmm(client(), cfg());
      const factory = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY);
      const router = await ethers.getContractAt("CircleswapRouter", ctx.AMM_ROUTER);
      const factoryImpl = await ethers.getContractAt("CircleswapFactory", ctx.AMM_FACTORY_IMPL);
      await expect(factory.connect(alice).initialize(alice.address)).to.be.revertedWithCustomError(factory, "InvalidInitialization");
      await expect(router.connect(alice).initialize(ctx.AMM_FACTORY, ctx.AMM_FACTORY, alice.address)).to.be.revertedWithCustomError(router, "InvalidInitialization");
      await expect(factoryImpl.connect(alice).initialize(alice.address)).to.be.revertedWithCustomError(factoryImpl, "InvalidInitialization");
    });

    it("guardians, when named, can veto and nothing else", async function () {
      const { client, guardian, cfg } = await setup();
      const { ctx } = await deployAmm(client(), cfg({ guardians: [guardian] }));
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), guardian)).to.equal(true);
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), guardian)).to.equal(false);
    });

    it("closed execution leaves only the proposer able to run an operation", async function () {
      const { client, proposer, cfg } = await setup();
      const { ctx } = await deployAmm(client(), cfg({ openExecution: false }));
      const timelock = await ethers.getContractAt("CircleswapTimelock", ctx.AMM_TIMELOCK);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(false);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), proposer)).to.equal(true);
    });

    it("the pool address it reports is exactly where the next pool lands, and probing creates nothing", async function () {
      const { client, signer, probeA, probeB, cfg } = await setup();
      const out = await deployAmm(client(), cfg());
      expect(out.probePoolAddress).to.match(ADDR);
      const factory = await ethers.getContractAt("CircleswapFactory", out.ctx.AMM_FACTORY);
      expect(await factory.allPairsLength()).to.equal(0n);
      await factory.connect(signer).createPair(probeA, probeB);
      expect(await factory.getPair(probeA, probeB)).to.equal(out.probePoolAddress);
    });

    it("stops, keeping everything it deployed, if the pool the factory would make is not acceptable", async function () {
      const { client, probeA, probeB, cfg } = await setup();
      let seen: AmmProgress | undefined;
      await expect(
        deployAmm(client(), cfg({
          probe: { tokens: [probeA, probeB], checkPoolAddress: a => { throw new Error(`${a} is outside Cyprus-1`); } },
          onProgress: p => (seen = p)
        }))
      ).to.be.rejectedWith("a pool made by this factory would land at");
      // Nothing is forgotten: the contracts exist, and the failed step is recorded as not done.
      expect(seen!.ctx.AMM_FACTORY).to.match(ADDR);
      expect(seen!.ctx.AMM_ROUTER).to.match(ADDR);
      expect(seen!.steps.routerProxy.done).to.equal(false);
      expect(seen!.steps.routerProxy.address).to.match(ADDR);
    });
  });

  describe("progress is written before it is needed", function () {
    it("records each transaction hash the moment it is sent, before the step is marked done", async function () {
      const { client, cfg } = await setup();
      const seen: AmmProgress[] = [];
      await deployAmm(client(), cfg({ onProgress: p => seen.push(p) }));
      for (const id of STEPS) {
        const sent = seen.findIndex(p => p.steps[id]?.txHash && !p.steps[id].done);
        const done = seen.findIndex(p => p.steps[id]?.done);
        expect(sent, `${id}: a snapshot with the hash and no 'done'`).to.be.gte(0);
        expect(done, `${id}: a snapshot that is done`).to.be.gt(sent);
      }
      const last = seen[seen.length - 1];
      for (const id of STEPS) {
        expect(last.steps[id].done).to.equal(true);
        expect(last.steps[id].constructorArgs).to.match(/^0x/);
      }
    });
  });

  describe("an interrupted deployment can be finished without repeating or re-paying for anything", function () {
    it("a failure creating the factory proxy keeps the timelock and implementation: resuming deploys only the rest", async function () {
      const { client, signer, cfg } = await setup();
      let saved: AmmProgress | undefined;
      const first = flaky(hardhatClient(signer), { failCreate: 3 }); // timelock #1, factoryImpl #2, factoryProxy #3 fails
      await expect(deployAmm(first.client, cfg({ onProgress: p => (saved = p) }))).to.be.rejectedWith("simulated network failure");
      expect(saved!.steps.timelock.done).to.equal(true);
      expect(saved!.steps.factoryImpl.done).to.equal(true);
      expect(saved!.steps.factoryProxy?.done ?? false).to.equal(false);

      const second = flaky(client());
      const out = await deployAmm(second.client, cfg({ resume: saved }));
      expect(second.counters.creates).to.equal(3); // factory proxy, router implementation, router proxy
      expect(out.ctx.AMM_TIMELOCK).to.equal(saved!.ctx.AMM_TIMELOCK);
      expect(out.ctx.AMM_FACTORY_IMPL).to.equal(saved!.ctx.AMM_FACTORY_IMPL);
      expect(out.steps.filter(s => s.resumed).map(s => s.stepId)).to.deep.equal(["timelock", "factoryImpl"]);
      expect(out.integrity!.verdict).to.equal("GOVERNED");
    });

    it("a run that died while WAITING for a sent transaction settles that transaction instead of sending a second copy", async function () {
      const { client, signer, cfg } = await setup();
      let saved: AmmProgress | undefined;
      // The factory implementation (create #2) is mined, then the connection drops before its receipt is read.
      await expect(
        deployAmm(dropsReceiptAfterCreate(hardhatClient(signer), 2), cfg({ onProgress: p => (saved = p) }))
      ).to.be.rejectedWith("simulated connection drop");
      expect(saved!.steps.factoryImpl.txHash).to.match(/^0x[0-9a-f]{64}$/); // written down at send time
      expect(saved!.steps.factoryImpl.done).to.equal(false);
      const sentBefore = await ethers.provider.getTransactionCount(saved!.deployer);

      const second = flaky(client());
      const out = await deployAmm(second.client, cfg({ resume: saved }));
      expect(second.counters.creates).to.equal(3); // NOT 4: the implementation was settled, not redeployed
      expect(await ethers.provider.getTransactionCount(saved!.deployer)).to.equal(sentBefore + 3);
      // The settled address is the one the first run's transaction produced.
      const receipt = await ethers.provider.getTransactionReceipt(saved!.steps.factoryImpl.txHash!);
      expect(out.ctx.AMM_FACTORY_IMPL).to.equal(receipt!.contractAddress);
      expect(out.integrity!.verdict).to.equal("GOVERNED");
    });

    it("resuming a run that already finished changes nothing and does not error", async function () {
      const { client, cfg } = await setup();
      let saved: AmmProgress | undefined;
      await deployAmm(client(), cfg({ onProgress: p => (saved = p) }));
      const again = flaky(client());
      const out = await deployAmm(again.client, cfg({ resume: saved }));
      expect(again.counters).to.deep.equal({ creates: 0, calls: 0 });
      expect(out.steps.every(s => s.resumed)).to.equal(true);
    });

    it("refuses to resume under different settings, or with a different key", async function () {
      const { client, guardian, cfg } = await setup();
      let saved: AmmProgress | undefined;
      await expect(deployAmm(flaky(client(), { failCreate: 2 }).client, cfg({ onProgress: p => (saved = p) }))).to.be.rejected;
      await expect(deployAmm(client(), cfg({ delaySeconds: 3 * DAY, resume: saved }))).to.be.rejectedWith("different settings");
      await expect(deployAmm(client(), cfg({ guardians: [guardian], resume: saved }))).to.be.rejectedWith("different settings");
      const [other] = await ethers.getSigners();
      await expect(deployAmm(hardhatClient(other), cfg({ resume: saved }))).to.be.rejectedWith("Use the same key");
    });

    it("re-verifies what a saved file calls done: a step whose chain state is wrong is refused, not trusted", async function () {
      const { client, deployer, cfg } = await setup();
      // A timelock of the right code but the wrong delay, standing in for 'someone swapped the saved address'.
      const T = await ethers.getContractFactory("CircleswapTimelock");
      const foreign = await T.deploy(5 * DAY, [deployer], [ethers.ZeroAddress], []);
      const config = cfg();
      const forged: AmmProgress = {
        fingerprint: fingerprintOf(config),
        deployer,
        ctx: {},
        steps: { timelock: { done: true, address: await foreign.getAddress() } },
        updatedAt: new Date().toISOString()
      };
      await expect(deployAmm(client(), { ...config, resume: forged })).to.be.rejectedWith("Post-deploy check failed: Timelock.getMinDelay");
    });
  });

  describe("before anything is sent", function () {
    it("a dry run prices what it can simulate, projects the two proxies and says so, and sends nothing", async function () {
      const { client, signer, deployer, cfg } = await setup();
      const f = flaky(hardhatClient(signer));
      const before = await ethers.provider.getTransactionCount(deployer);
      const out = await deployAmm(f.client, cfg({ deploy: { ...FAST, broadcast: false } }));
      expect(out.dryRun).to.equal(true);
      expect(out.steps.map(s => s.stepId)).to.deep.equal(STEPS);
      expect(out.steps.filter(s => s.projected).map(s => s.stepId)).to.deep.equal(["factoryProxy", "routerProxy"]);
      for (const s of out.steps) {
        expect(s.estimatedGas).to.be.gt(0n);
        expect(s.gasLimit).to.be.gte((s.estimatedGas * 300n) / 100n); // 3x the simulator's figure, or the floor from the code deposited
        expect(s.address).to.equal(undefined);
      }
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
      expect(await ethers.provider.getTransactionCount(deployer)).to.equal(before);
      void client;
    });

    it("a dry run ignores a resume request: nothing is adopted or sent", async function () {
      const { signer, cfg } = await setup();
      const f = flaky(hardhatClient(signer));
      const bogus: AmmProgress = { fingerprint: "x", deployer: ethers.Wallet.createRandom().address, ctx: {}, steps: {}, updatedAt: "" };
      const out = await deployAmm(f.client, cfg({ resume: bogus, deploy: { ...FAST, broadcast: false } }));
      expect(out.dryRun).to.equal(true);
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("refuses a stale generated artifact, which would spend gas on code the verification then rejects", async function () {
      const { signer, cfg } = await setup();
      const f = flaky(hardhatClient(signer));
      const stale = (name: string) => {
        const a = loadArtifact(name);
        return name === "CircleswapRouter" ? { ...a, bytecode: a.bytecode.slice(0, -2) + "00" } : a;
      };
      await expect(deployAmm(f.client, cfg({ artifact: stale }))).to.be.rejectedWith("generated artifact for CircleswapRouter is stale");
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
      expect(() => assertGeneratedMatchesCompiled(["CircleswapFactory", "CircleswapRouter", "CircleswapTimelock", "ERC1967Proxy"])).to.not.throw();
    });

    it("refuses to start when the deployer cannot cover the whole deployment, rather than stopping half-way", async function () {
      const { signer, cfg } = await setup();
      const f = flaky({ ...hardhatClient(signer), getBalance: async () => 1_000n });
      await expect(deployAmm(f.client, cfg())).to.be.rejectedWith("Nothing was sent");
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("starts an under-funded run only when told to, and then each step still checks its own funds", async function () {
      const { signer, cfg } = await setup();
      const poor = flaky({ ...hardhatClient(signer), getBalance: async () => 1_000n });
      await expect(deployAmm(poor.client, cfg({ allowUnderfunded: true }))).to.be.rejectedWith("deployer holds 1000 wei"); // the per-step check still stops it
      expect(poor.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("the factory proxy's limit has a floor from the pool code its initialize creates, whatever the simulator says", async function () {
      const { signer, cfg } = await setup();
      const out = await deployAmm(hardhatClient(signer), cfg({ deploy: { ...FAST, broadcast: false } }));
      const proxy = out.steps.find(s => s.stepId === "factoryProxy")!;
      const nested = 10_864 + 619 + 130; // pool implementation + beacon + proxy runtime bytes
      expect(proxy.gasLimit).to.be.gte(2n * (53_000n + 200n * BigInt(nested)) + 500_000n);
    });

    it("refuses a gas limit the node would reject outright (above the block gas limit)", async function () {
      const { signer, cfg } = await setup();
      const f = flaky({ ...hardhatClient(signer), getBlockGasLimit: async () => 1_000_000n });
      await expect(deployAmm(f.client, cfg())).to.be.rejectedWith("above the block gas limit");
      await expect(deployAmm(f.client, cfg({ deploy: { ...FAST, broadcast: false } }))).to.be.rejectedWith("above the block gas limit");
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });

    it("refuses bad settings before simulating anything: delay range, non-Cyprus-1 accounts, a guardian that is the proposer", async function () {
      const { signer, proposer, cfg } = await setup();
      const f = flaky(hardhatClient(signer));
      await expect(deployAmm(f.client, cfg({ delaySeconds: DAY - 1 }))).to.be.rejectedWith("between 1 day and 30 days");
      await expect(deployAmm(f.client, cfg({ delaySeconds: 31 * DAY }))).to.be.rejectedWith("between 1 day and 30 days");
      await expect(deployAmm(f.client, cfg({ proposer: "0x1111111111111111111111111111111111111111" }))).to.be.rejectedWith("Cyprus-1");
      await expect(deployAmm(f.client, cfg({ guardians: [proposer] }))).to.be.rejectedWith("different account from the proposer");
      expect(f.counters).to.deep.equal({ creates: 0, calls: 0 });
    });
  });

  describe("the settings policy", function () {
    const good: AmmSettings = {
      deployer: "0x0099999999999999999999999999999999999999",
      proposer: "0x0011111111111111111111111111111111111111",
      delaySeconds: 3 * DAY,
      openExecution: true,
      guardians: ["0x0022222222222222222222222222222222222222"],
      wquai: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
      probeTokens: ["0x00325150094E51107a931980Fdfc3bB1a4C48379", "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB"]
    };
    const facts: AmmFacts = {
      proposerIsContract: true,
      wquai: { hasCode: true, decimals: 18, symbol: "WQUAI" },
      probeTokensHaveCode: [true, true]
    };
    const text = (r: { errors: { message: string }[] }) => r.errors.map(e => e.message).join(" ");

    it("accepts a multisig proposer, a several-day delay, a guardian and the registry's WQUAI", function () {
      const r = assessAmmSettings(true, good, facts);
      expect(r.errors).to.deep.equal([]);
      expect(r.warnings).to.deep.equal([]);
    });

    it("on mainnet refuses an account as proposer, the deploying key as proposer, a short delay, and a custom WQUAI, each unless acknowledged", function () {
      const account = assessAmmSettings(true, good, { ...facts, proposerIsContract: false });
      expect(account.errors.map(e => e.ack)).to.deep.equal(["allowAccountProposer"]);
      const self = assessAmmSettings(true, { ...good, proposer: good.deployer }, facts);
      expect(text(self)).to.contain("deploying account");
      const quick = assessAmmSettings(true, { ...good, delaySeconds: DAY }, facts);
      expect(quick.errors.map(e => e.ack)).to.deep.equal(["allowShortDelay"]);
      const custom = assessAmmSettings(true, { ...good, wquai: "0x0033333333333333333333333333333333333333" }, facts);
      expect(custom.errors.map(e => e.ack)).to.deep.equal(["allowCustomWquai"]);

      expect(assessAmmSettings(true, good, { ...facts, proposerIsContract: false }, { allowAccountProposer: true }).errors).to.deep.equal([]);
      expect(assessAmmSettings(true, { ...good, delaySeconds: DAY }, facts, { allowShortDelay: true }).errors).to.deep.equal([]);
      expect(assessAmmSettings(true, { ...good, wquai: "0x0033333333333333333333333333333333333333" }, facts, { allowCustomWquai: true }).errors).to.deep.equal([]);
      expect(RECOMMENDED_MIN_DELAY).to.equal(2 * DAY);
    });

    it("when not about to send to mainnet the same things are warnings, not errors", function () {
      const r = assessAmmSettings(false, { ...good, delaySeconds: DAY }, { ...facts, proposerIsContract: false });
      expect(r.errors).to.deep.equal([]);
      expect(r.warnings.length).to.be.gte(2);
    });

    it("always refuses what can never work: a delay out of range, a WQUAI with no code or the wrong decimals, a token with no code", function () {
      expect(text(assessAmmSettings(false, { ...good, delaySeconds: 60 }, facts))).to.contain("between 1 and 30 days");
      expect(text(assessAmmSettings(false, good, { ...facts, wquai: { hasCode: false } }))).to.contain("no code");
      expect(text(assessAmmSettings(false, good, { ...facts, wquai: { hasCode: true, decimals: 6 } }))).to.contain("6 decimals");
      expect(text(assessAmmSettings(false, good, { ...facts, probeTokensHaveCode: [true, false] }))).to.contain("Probe token");
    });

    it("warns about no guardian, a guardian that is the deploying key, and closed execution", function () {
      const w = assessAmmSettings(false, { ...good, guardians: [], openExecution: false }, facts).warnings.join(" ");
      expect(w).to.contain("No guardian");
      expect(w).to.contain("Execution is closed");
      expect(assessAmmSettings(false, { ...good, guardians: [good.deployer] }, facts).warnings.join(" ")).to.contain("is the deploying account");
    });

    it("reads its facts from the chain: contract or account, WQUAI decimals and symbol, token code", async function () {
      const { signer, proposer, wquai, probeA, probeB } = await setup();
      const reader = readerOf(hardhatClient(signer));
      const f = await gatherAmmFacts(reader, { proposer, wquai, probeTokens: [probeA, probeB] });
      expect(f.proposerIsContract).to.equal(false); // an ordinary (impersonated) account
      expect(f.wquai).to.deep.include({ hasCode: true, decimals: 18 });
      expect(f.probeTokensHaveCode).to.deep.equal([true, true]);
      const asContract = await gatherAmmFacts(reader, { proposer: wquai, wquai, probeTokens: [probeA, probeB] });
      expect(asContract.proposerIsContract).to.equal(true);
      const missing = await gatherAmmFacts(reader, { proposer, wquai: proposer, probeTokens: [probeA, proposer] });
      expect(missing.wquai.hasCode).to.equal(false);
      expect(missing.probeTokensHaveCode).to.deep.equal([true, false]);
    });
  });

  describe("the source-verification bundle", function () {
    it("lists every contract the deployment made, with the arguments an explorer needs, and the compiler's standard-JSON input", async function () {
      const { client, deployer, cfg } = await setup();
      const config = cfg();
      const out = await deployAmm(client(), config);
      const record = JSON.parse(JSON.stringify(ammRecord("cyprus1", 9n, deployer, config, out, out.progress!)));
      const bundle = buildBundle(record);
      expect(bundle.items.map(i => i.contract)).to.deep.equal([
        "contracts/amm/governance/CircleswapTimelock.sol:CircleswapTimelock",
        "contracts/amm/CircleswapFactory.sol:CircleswapFactory",
        "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
        "contracts/amm/CircleswapRouter.sol:CircleswapRouter",
        "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
        "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
        "contracts/amm/CircleswapPair.sol:CircleswapPair"
      ]);
      expect(bundle.items.map(i => i.address)).to.deep.equal([
        out.ctx.AMM_TIMELOCK, out.ctx.AMM_FACTORY_IMPL, out.ctx.AMM_FACTORY, out.ctx.AMM_ROUTER_IMPL, out.ctx.AMM_ROUTER,
        out.integrity!.facts.pairBeacon, out.integrity!.facts.pairImpl
      ]);
      // the timelock's arguments are the ones it was deployed with; the beacon's are (pool implementation, factory)
      expect(bundle.items[0].constructorArgs).to.equal(out.progress!.steps.timelock.constructorArgs);
      expect(bundle.items[5].constructorArgs).to.equal(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [out.integrity!.facts.pairImpl, out.ctx.AMM_FACTORY])
      );
      expect(bundle.compiler).to.match(/^v0\.8\.24\+commit\./);
      expect((bundle.settings as any).viaIR).to.equal(true);
      expect((bundle.settings as any).evmVersion).to.equal("cancun");

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amm-bundle-"));
      writeBundle(bundle, dir);
      const files = fs.readdirSync(dir);
      expect(files).to.include.members(["manifest.json", "README.md"]);
      const inputFile = files.find(f => f.endsWith(".standard-input.json"))!;
      const input = JSON.parse(fs.readFileSync(path.join(dir, inputFile), "utf8"));
      expect(Object.keys(input.sources)).to.include("contracts/amm/CircleswapFactory.sol");
      expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).to.contain("4-byte salt");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("settings fingerprint", function () {
    it("changes with every setting that decides what is deployed, and not otherwise", async function () {
      const { proposer, guardian, wquai } = await setup();
      const base = { proposer, delaySeconds: 2 * DAY, wquai };
      const fp = fingerprintOf(base);
      expect(fingerprintOf({ ...base })).to.equal(fp);
      expect(fingerprintOf({ ...base, proposer: guardian })).to.not.equal(fp);
      expect(fingerprintOf({ ...base, delaySeconds: 3 * DAY })).to.not.equal(fp);
      expect(fingerprintOf({ ...base, wquai: guardian })).to.not.equal(fp);
      expect(fingerprintOf({ ...base, openExecution: false })).to.not.equal(fp);
      expect(fingerprintOf({ ...base, guardians: [guardian] })).to.not.equal(fp);
      expect(fingerprintOf({ ...base, openExecution: true })).to.equal(fp); // the default, spelled out
    });
  });

  describe("the AMM record and deployed.ts", function () {
    it("the record is JSON-safe (no bigint) and carries the governance settings, every contract and the constructor arguments", async function () {
      const { client, deployer, proposer, guardian, cfg } = await setup();
      const config = cfg({ guardians: [guardian] });
      const out = await deployAmm(client(), config);
      const round = JSON.parse(JSON.stringify(ammRecord("cyprus1", 9n, deployer, config, out, out.progress!)));
      expect(round.chainId).to.equal("9");
      expect(round.governance).to.deep.include({ proposer, delaySeconds: 2 * DAY, delayDays: 2, openExecution: true });
      expect(round.governance.guardians).to.deep.equal([guardian]);
      expect(round.contracts.timelock).to.equal(out.ctx.AMM_TIMELOCK);
      expect(round.contracts.factory).to.equal(out.ctx.AMM_FACTORY);
      expect(round.contracts.router).to.equal(out.ctx.AMM_ROUTER);
      expect(round.contracts.pairBeacon).to.match(ADDR);
      expect(round.contracts.pairImplementation).to.match(ADDR);
      expect(round.transactions.timelock.constructorArgs).to.match(/^0x/);
      expect(round.transactions.routerProxy.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(round.integrity.verdict).to.equal("GOVERNED");
      expect(round.probePoolAddress).to.equal(out.probePoolAddress);
    });

    it("the generated file carries the proxies' addresses as read from the receipts", async function () {
      const { client, cfg } = await setup();
      const out = await deployAmm(client(), cfg());
      const src = renderDeployedTs({ QRB: null, QRB_NFT: null, MASTERCHEF: null, AMM_FACTORY: out.ctx.AMM_FACTORY, AMM_ROUTER: out.ctx.AMM_ROUTER, ARTWORK_URI: null });
      expect(src).to.contain(`AMM_FACTORY: '${out.ctx.AMM_FACTORY}'`);
      expect(src).to.contain(`AMM_ROUTER: '${out.ctx.AMM_ROUTER}'`);
    });
  });
});
