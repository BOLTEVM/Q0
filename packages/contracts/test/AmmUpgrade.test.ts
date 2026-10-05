import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployAmm, deadline, E18, poolWith, reservesOf, pairOf } from "./ammHelpers";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

describe("Circleswap AMM: UUPS & Beacon upgradeability", function () {
  const fixture = () => deployAmm();

  describe("Factory UUPS Upgradeability", function () {
    it("initializes through ERC1967Proxy with designated owner and beacon", async function () {
      const { factory, owner } = await loadFixture(fixture);
      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
      expect(await factory.allPairsLength()).to.equal(0);
      const beacon = await factory.pairBeacon();
      expect(beacon).to.not.equal(ethers.ZeroAddress);
      expect(await factory.pairImplementation()).to.not.equal(ethers.ZeroAddress);
    });

    it("implementation contract cannot be directly initialized (_disableInitializers)", async function () {
      const { alice } = await loadFixture(fixture);
      const FactoryFactory = await ethers.getContractFactory("CircleswapFactory");
      const factoryImpl = await FactoryFactory.deploy();
      await expect(factoryImpl.initialize(alice.address)).to.be.revertedWithCustomError(
        factoryImpl,
        "InvalidInitialization"
      );
    });

    it("proxy contract cannot be re-initialized", async function () {
      const { factory, alice } = await loadFixture(fixture);
      await expect(factory.initialize(alice.address)).to.be.revertedWithCustomError(
        factory,
        "InvalidInitialization"
      );
    });

    it("unauthorized upgradeToAndCall reverts with OwnableUnauthorizedAccount", async function () {
      const { factory, alice } = await loadFixture(fixture);
      const FactoryV2 = await ethers.getContractFactory("CircleswapFactoryV2");
      const factoryV2Impl = await FactoryV2.deploy();

      await expect(
        factory.connect(alice).upgradeToAndCall(await factoryV2Impl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(alice.address);
    });

    it("authorized upgradeToAndCall succeeds for owner and preserves state", async function () {
      const { factory, owner, A, B } = await loadFixture(fixture);
      await factory.createPair(await A.getAddress(), await B.getAddress());
      const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());
      const beaconAddr = await factory.pairBeacon();

      const FactoryV2 = await ethers.getContractFactory("CircleswapFactoryV2");
      const factoryV2Impl = await FactoryV2.deploy();
      const newImplAddr = await factoryV2Impl.getAddress();

      const tx = await factory.connect(owner).upgradeToAndCall(newImplAddr, "0x");
      await expect(tx).to.emit(factory, "Upgraded").withArgs(newImplAddr);

      // Verify EIP-1967 implementation slot was updated
      const rawSlot = await ethers.provider.getStorage(await factory.getAddress(), EIP1967_IMPLEMENTATION_SLOT);
      const recordedImpl = ethers.getAddress(ethers.dataSlice(rawSlot, 12));
      expect(recordedImpl).to.equal(newImplAddr);

      // Check V2 interface on the proxy
      const upgradedFactory = FactoryV2.attach(await factory.getAddress()) as any;
      expect(await upgradedFactory.version()).to.equal("FactoryV2");
      expect(await upgradedFactory.isV2()).to.equal(true);

      // State preserved
      expect(await upgradedFactory.owner()).to.equal(owner.address);
      expect(await upgradedFactory.allPairsLength()).to.equal(1);
      expect(await upgradedFactory.allPairs(0)).to.equal(pairAddr);
      expect(await upgradedFactory.pairBeacon()).to.equal(beaconAddr);
    });

    it("enforces two-step ownership transfer before allowing new owner to upgrade", async function () {
      const { factory, owner, alice, bob } = await loadFixture(fixture);
      const FactoryV2 = await ethers.getContractFactory("CircleswapFactoryV2");
      const factoryV2Impl = await FactoryV2.deploy();

      // Step 1: Transfer ownership
      await factory.connect(owner).transferOwnership(alice.address);
      expect(await factory.owner()).to.equal(owner.address);

      // Alice is not yet the owner; upgrade reverts
      await expect(
        factory.connect(alice).upgradeToAndCall(await factoryV2Impl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      // Non-nominated bob cannot accept
      await expect(
        factory.connect(bob).acceptOwnership()
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      // Step 2: Accept ownership
      await factory.connect(alice).acceptOwnership();
      expect(await factory.owner()).to.equal(alice.address);

      // Old owner can no longer upgrade
      await expect(
        factory.connect(owner).upgradeToAndCall(await factoryV2Impl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      // New owner upgrades successfully
      await factory.connect(alice).upgradeToAndCall(await factoryV2Impl.getAddress(), "0x");
      const upgradedFactory = FactoryV2.attach(await factory.getAddress()) as any;
      expect(await upgradedFactory.version()).to.equal("FactoryV2");
    });
  });

  describe("Router UUPS Upgradeability", function () {
    it("initializes through ERC1967Proxy with factory, WETH and owner", async function () {
      const { router, factory, wquai, owner } = await loadFixture(fixture);
      expect(await router.factory()).to.equal(await factory.getAddress());
      expect(await router.WETH()).to.equal(await wquai.getAddress());
      expect(await router.owner()).to.equal(owner.address);
    });

    it("implementation contract cannot be directly initialized (_disableInitializers)", async function () {
      const { factory, wquai, alice } = await loadFixture(fixture);
      const RouterFactory = await ethers.getContractFactory("CircleswapRouter");
      const routerImpl = await RouterFactory.deploy();
      await expect(
        routerImpl.initialize(await factory.getAddress(), await wquai.getAddress(), alice.address)
      ).to.be.revertedWithCustomError(routerImpl, "InvalidInitialization");
    });

    it("proxy contract cannot be re-initialized", async function () {
      const { router, factory, wquai, alice } = await loadFixture(fixture);
      await expect(
        router.initialize(await factory.getAddress(), await wquai.getAddress(), alice.address)
      ).to.be.revertedWithCustomError(router, "InvalidInitialization");
    });

    it("unauthorized upgradeToAndCall reverts with OwnableUnauthorizedAccount", async function () {
      const { router, alice } = await loadFixture(fixture);
      const RouterV2 = await ethers.getContractFactory("CircleswapRouterV2");
      const routerV2Impl = await RouterV2.deploy();

      await expect(
        router.connect(alice).upgradeToAndCall(await routerV2Impl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount").withArgs(alice.address);
    });

    it("authorized upgradeToAndCall succeeds for owner and preserves routing state", async function () {
      const { router, factory, wquai, owner } = await loadFixture(fixture);
      const RouterV2 = await ethers.getContractFactory("CircleswapRouterV2");
      const routerV2Impl = await RouterV2.deploy();
      const newImplAddr = await routerV2Impl.getAddress();

      const tx = await router.connect(owner).upgradeToAndCall(newImplAddr, "0x");
      await expect(tx).to.emit(router, "Upgraded").withArgs(newImplAddr);

      // Verify EIP-1967 implementation slot was updated
      const rawSlot = await ethers.provider.getStorage(await router.getAddress(), EIP1967_IMPLEMENTATION_SLOT);
      const recordedImpl = ethers.getAddress(ethers.dataSlice(rawSlot, 12));
      expect(recordedImpl).to.equal(newImplAddr);

      // Check V2 interface on the proxy
      const upgradedRouter = RouterV2.attach(await router.getAddress()) as any;
      expect(await upgradedRouter.version()).to.equal("RouterV2");
      expect(await upgradedRouter.isV2()).to.equal(true);

      // State preserved
      expect(await upgradedRouter.factory()).to.equal(await factory.getAddress());
      expect(await upgradedRouter.WETH()).to.equal(await wquai.getAddress());
      expect(await upgradedRouter.owner()).to.equal(owner.address);
    });
  });

  describe("Liquidity Pools UpgradeableBeacon & BeaconProxy Lifecycle", function () {
    it("pool implementation contract cannot be directly initialized", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      const implAddr = await factory.pairImplementation();
      const impl = await ethers.getContractAt("CircleswapPair", implAddr);
      await expect(
        impl.initialize(await A.getAddress(), await B.getAddress())
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("pools deploy as BeaconProxy instances pointing to factory pairBeacon", async function () {
      const { factory, A, B } = await loadFixture(fixture);
      await factory.createPair(await A.getAddress(), await B.getAddress());
      const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());

      const code = await ethers.provider.getCode(pairAddr);
      expect(code).to.not.equal("0x");

      // Verify EIP-1967 Beacon slot
      const rawBeaconSlot = await ethers.provider.getStorage(pairAddr, EIP1967_BEACON_SLOT);
      const recordedBeacon = ethers.getAddress(ethers.dataSlice(rawBeaconSlot, 12));
      expect(recordedBeacon).to.equal(await factory.pairBeacon());
    });

    it("unauthorized caller cannot upgrade pairBeacon", async function () {
      const { factory, alice } = await loadFixture(fixture);
      const beaconAddr = await factory.pairBeacon();
      const beacon = await ethers.getContractAt("UpgradeableBeacon", beaconAddr);

      const PairV2 = await ethers.getContractFactory("CircleswapPairV2");
      const pairV2Impl = await PairV2.deploy();

      await expect(
        beacon.connect(alice).upgradeTo(await pairV2Impl.getAddress())
      ).to.be.revertedWithCustomError(beacon, "OwnableUnauthorizedAccount").withArgs(alice.address);
    });

    it("upgrading pairBeacon atomically upgrades pool logic while preserving reserves, LP balances and trading functionality", async function () {
      const amm = await loadFixture(fixture);
      const { factory, router, owner, alice, bob, A, B, C } = amm;

      // Create and fund two pools
      const pairAB = await poolWith(amm, A, B, 10_000n * E18, 20_000n * E18);
      const pairBC = await poolWith(amm, B, C, 30_000n * E18, 40_000n * E18);

      const [resAB_A_before, resAB_B_before] = await reservesOf(pairAB, A);
      const [resBC_B_before, resBC_C_before] = await reservesOf(pairBC, B);
      const lpAB_alice_before = await pairAB.balanceOf(alice.address);
      const lpBC_alice_before = await pairBC.balanceOf(alice.address);
      const supplyAB_before = await pairAB.totalSupply();
      const supplyBC_before = await pairBC.totalSupply();

      // Alice swaps 500 A for B on pairAB
      await router.connect(alice).swapExactTokensForTokens(
        500n * E18,
        1n,
        [await A.getAddress(), await B.getAddress()],
        alice.address,
        await deadline()
      );

      const [resAB_A_mid, resAB_B_mid] = await reservesOf(pairAB, A);
      expect(resAB_A_mid).to.be.gt(resAB_A_before);
      expect(resAB_B_mid).to.be.lt(resAB_B_before);

      // Deploy PairV2 implementation
      const PairV2 = await ethers.getContractFactory("CircleswapPairV2");
      const pairV2Impl = await PairV2.deploy();
      const newPairImplAddr = await pairV2Impl.getAddress();

      // Beacon owner upgrades the beacon
      const beaconAddr = await factory.pairBeacon();
      const beacon = await ethers.getContractAt("UpgradeableBeacon", beaconAddr);
      const tx = await factory.connect(owner).upgradePairImplementation(newPairImplAddr);
      await expect(tx).to.emit(beacon, "Upgraded").withArgs(newPairImplAddr);

      // Verify implementation updated on factory
      expect(await factory.pairImplementation()).to.equal(newPairImplAddr);

      // Inspect upgraded pairs
      const pairAB_v2 = PairV2.attach(await pairAB.getAddress()) as any;
      const pairBC_v2 = PairV2.attach(await pairBC.getAddress()) as any;

      // Both pools instantly acquired V2 functions
      expect(await pairAB_v2.version()).to.equal("PairV2");
      expect(await pairBC_v2.version()).to.equal("PairV2");
      expect(await pairAB_v2.poolFeeBps()).to.equal(30n);
      expect(await pairBC_v2.poolFeeBps()).to.equal(30n);

      // Verify 100% preservation of reserves
      const [resAB_A_after, resAB_B_after] = await reservesOf(pairAB_v2, A);
      const [resBC_B_after, resBC_C_after] = await reservesOf(pairBC_v2, B);
      expect(resAB_A_after).to.equal(resAB_A_mid);
      expect(resAB_B_after).to.equal(resAB_B_mid);
      expect(resBC_B_after).to.equal(resBC_B_before);
      expect(resBC_C_after).to.equal(resBC_C_before);

      // Verify 100% preservation of LP balances and total supplies
      expect(await pairAB_v2.balanceOf(alice.address)).to.equal(lpAB_alice_before);
      expect(await pairBC_v2.balanceOf(alice.address)).to.equal(lpBC_alice_before);
      expect(await pairAB_v2.totalSupply()).to.equal(supplyAB_before);
      expect(await pairBC_v2.totalSupply()).to.equal(supplyBC_before);

      // Subsequent actions work cleanly on upgraded pools
      // Bob adds liquidity to pairAB
      await router.connect(bob).addLiquidity(
        await A.getAddress(),
        await B.getAddress(),
        1000n * E18,
        2000n * E18,
        0,
        0,
        bob.address,
        await deadline()
      );
      expect(await pairAB_v2.balanceOf(bob.address)).to.be.gt(0n);

      // Bob swaps on pairBC
      const bBalanceBefore = await B.balanceOf(bob.address);
      await router.connect(bob).swapExactTokensForTokens(
        100n * E18,
        1n,
        [await B.getAddress(), await C.getAddress()],
        bob.address,
        await deadline()
      );
      expect(await B.balanceOf(bob.address)).to.be.lt(bBalanceBefore);

      // Alice burns some LP tokens from pairAB
      const lpToBurn = (await pairAB_v2.balanceOf(alice.address)) / 4n;
      await pairAB_v2.connect(alice).approve(await router.getAddress(), lpToBurn);
      await router.connect(alice).removeLiquidity(
        await A.getAddress(),
        await B.getAddress(),
        lpToBurn,
        0,
        0,
        alice.address,
        await deadline()
      );
      expect(await pairAB_v2.balanceOf(alice.address)).to.be.lt(lpAB_alice_before);
    });

    it("stress-tests multi-pool beacon upgrade across 4 pools with multiple LP providers and multi-hop swaps", async function () {
      const amm = await loadFixture(fixture);
      const { factory, router, owner, alice, bob, carol, A, B, C, D } = amm;

      // Seed 4 pools: A/B, B/C, C/D, A/D with different sizes and providers
      const pairAB = await poolWith(amm, A, B, 50_000n * E18, 100_000n * E18);
      const pairBC = await poolWith(amm, B, C, 80_000n * E18, 40_000n * E18);

      // Bob funds C/D and A/D
      await router.connect(bob).addLiquidity(
        await C.getAddress(),
        await D.getAddress(),
        60_000n * E18,
        60_000n * E18,
        0,
        0,
        bob.address,
        await deadline()
      );
      const pairCD = await pairOf(factory, C, D);

      await router.connect(bob).addLiquidity(
        await A.getAddress(),
        await D.getAddress(),
        30_000n * E18,
        90_000n * E18,
        0,
        0,
        bob.address,
        await deadline()
      );
      const pairAD = await pairOf(factory, A, D);

      // Carol also deposits into A/B and C/D (multi-LP per pool)
      await router.connect(carol).addLiquidity(
        await A.getAddress(),
        await B.getAddress(),
        5_000n * E18,
        10_000n * E18,
        0,
        0,
        carol.address,
        await deadline()
      );
      await router.connect(carol).addLiquidity(
        await C.getAddress(),
        await D.getAddress(),
        6_000n * E18,
        6_000n * E18,
        0,
        0,
        carol.address,
        await deadline()
      );

      // Execute several swaps across the pools prior to upgrade
      await router.connect(alice).swapExactTokensForTokens(
        1000n * E18,
        1n,
        [await A.getAddress(), await B.getAddress()],
        alice.address,
        await deadline()
      );

      await router.connect(bob).swapExactTokensForTokens(
        500n * E18,
        1n,
        [await B.getAddress(), await C.getAddress(), await D.getAddress()],
        bob.address,
        await deadline()
      );

      await router.connect(carol).swapExactTokensForTokens(
        300n * E18,
        1n,
        [await A.getAddress(), await D.getAddress()],
        carol.address,
        await deadline()
      );

      // Snapshot reserves, LP balances, total supplies across all 4 pools
      const pairs = [pairAB, pairBC, pairCD, pairAD];
      const reservesBefore = await Promise.all(pairs.map(p => p.getReserves()));
      const supplyBefore = await Promise.all(pairs.map(p => p.totalSupply()));
      const aliceLpBefore = await Promise.all(pairs.map(p => p.balanceOf(alice.address)));
      const bobLpBefore = await Promise.all(pairs.map(p => p.balanceOf(bob.address)));
      const carolLpBefore = await Promise.all(pairs.map(p => p.balanceOf(carol.address)));

      // Upgrade beacon to CircleswapPairV2
      const PairV2 = await ethers.getContractFactory("CircleswapPairV2");
      const pairV2Impl = await PairV2.deploy();
      const newPairImplAddr = await pairV2Impl.getAddress();

      const beaconAddr = await factory.pairBeacon();
      const beacon = await ethers.getContractAt("UpgradeableBeacon", beaconAddr);
      await factory.connect(owner).upgradePairImplementation(newPairImplAddr);

      // Verify all 4 pools upgrade simultaneously
      for (let i = 0; i < pairs.length; i++) {
        const pV2 = PairV2.attach(await pairs[i].getAddress()) as any;
        expect(await pV2.version()).to.equal("PairV2");
        expect(await pV2.poolFeeBps()).to.equal(30n);

        // Verify strictly equal reserves
        const reservesAfter = await pV2.getReserves();
        expect(reservesAfter[0]).to.equal(reservesBefore[i][0]);
        expect(reservesAfter[1]).to.equal(reservesBefore[i][1]);
        expect(reservesAfter[2]).to.equal(reservesBefore[i][2]);

        // Verify strictly equal supplies
        expect(await pV2.totalSupply()).to.equal(supplyBefore[i]);

        // Verify strictly equal LP balances
        expect(await pV2.balanceOf(alice.address)).to.equal(aliceLpBefore[i]);
        expect(await pV2.balanceOf(bob.address)).to.equal(bobLpBefore[i]);
        expect(await pV2.balanceOf(carol.address)).to.equal(carolLpBefore[i]);
      }

      // Verify subsequent liquidity operations and swaps work cleanly on upgraded pools
      const carolLpAB = await pairAB.balanceOf(carol.address);
      expect(carolLpAB).to.be.gt(0n);
      await pairAB.connect(carol).approve(await router.getAddress(), carolLpAB);
      await router.connect(carol).removeLiquidity(
        await A.getAddress(),
        await B.getAddress(),
        carolLpAB,
        0,
        0,
        carol.address,
        await deadline()
      );
      expect(await pairAB.balanceOf(carol.address)).to.equal(0n);

      await router.connect(alice).addLiquidity(
        await C.getAddress(),
        await D.getAddress(),
        1000n * E18,
        1000n * E18,
        0,
        0,
        alice.address,
        await deadline()
      );
      expect(await pairCD.balanceOf(alice.address)).to.be.gt(0n);

      const aBalanceBefore = await A.balanceOf(bob.address);
      await router.connect(bob).swapExactTokensForTokens(
        200n * E18,
        1n,
        [await D.getAddress(), await C.getAddress(), await B.getAddress(), await A.getAddress()],
        bob.address,
        await deadline()
      );
      expect((await A.balanceOf(bob.address)) - aBalanceBefore).to.be.gt(0n);
    });

    it("enforces ReentrancyGuardUpgradeable across BeaconProxy pairs before and after upgrade", async function () {
      const amm = await loadFixture(fixture);
      const { factory, owner, A, B } = amm;

      const pair = await poolWith(amm, A, B, 10_000n * E18, 20_000n * E18);
      const pairAddr = await pair.getAddress();

      const FlashCalleeFactory = await ethers.getContractFactory("FlashCallee");
      const callee = await FlashCalleeFactory.deploy();

      // Fund callee with tokens to repay fees
      await A.mint(await callee.getAddress(), 100n * E18);
      await B.mint(await callee.getAddress(), 100n * E18);

      // Verify reentrancy blocked on un-upgraded BeaconProxy
      for (const [mode, name] of [[3, "swap"], [4, "mint"], [5, "burn"], [6, "sync"], [7, "skim"]] as const) {
        await callee.run(pairAddr, 10n * E18, 0, mode);
        expect(await callee.reentryFailed(), `reentrancy was not prevented on ${name} before upgrade`).to.equal(true);
      }

      // Upgrade beacon to V2
      const PairV2 = await ethers.getContractFactory("CircleswapPairV2");
      const pairV2Impl = await PairV2.deploy();
      const beaconAddr = await factory.pairBeacon();
      const beacon = await ethers.getContractAt("UpgradeableBeacon", beaconAddr);
      await factory.connect(owner).upgradePairImplementation(await pairV2Impl.getAddress());

      // Verify reentrancy blocked on upgraded BeaconProxy
      for (const [mode, name] of [[3, "swap"], [4, "mint"], [5, "burn"], [6, "sync"], [7, "skim"]] as const) {
        await callee.run(pairAddr, 10n * E18, 0, mode);
        expect(await callee.reentryFailed(), `reentrancy was not prevented on ${name} after upgrade`).to.equal(true);
      }
    });
  });
});
