// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AmmBase.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "../../contracts/mocks/AmmUpgradeMocks.sol";

/// @dev Callee contract attempting reentrancy attacks through BeaconProxy
contract ReentrantPairCaller is ICircleswapCallee {
    address public immutable pair;
    bool public reentryFailed;
    uint8 public mode; // 1: swap, 2: mint, 3: burn, 4: sync, 5: skim

    constructor(address _pair) {
        pair = _pair;
    }

    function testFlash(uint8 _mode, uint256 borrow0, uint256 borrow1) external {
        mode = _mode;
        reentryFailed = false;
        CircleswapPair(pair).swap(borrow0, borrow1, address(this), hex"1337");
    }

    function circleswapCall(address, uint256 amount0, uint256 amount1, bytes calldata) external override {
        require(msg.sender == pair, "not pair");

        // Attempt reentrancy through BeaconProxy
        if (mode == 1) {
            (bool ok, ) = pair.call(abi.encodeCall(CircleswapPair.swap, (1, 0, address(this), "")));
            reentryFailed = !ok;
        } else if (mode == 2) {
            (bool ok, ) = pair.call(abi.encodeCall(CircleswapPair.mint, (address(this))));
            reentryFailed = !ok;
        } else if (mode == 3) {
            (bool ok, ) = pair.call(abi.encodeCall(CircleswapPair.burn, (address(this))));
            reentryFailed = !ok;
        } else if (mode == 4) {
            (bool ok, ) = pair.call(abi.encodeCall(CircleswapPair.sync, ()));
            reentryFailed = !ok;
        } else if (mode == 5) {
            (bool ok, ) = pair.call(abi.encodeCall(CircleswapPair.skim, (address(this))));
            reentryFailed = !ok;
        }

        // Repay flash swap with fee so outer swap succeeds
        address t0 = CircleswapPair(pair).token0();
        address t1 = CircleswapPair(pair).token1();
        if (amount0 > 0) {
            uint256 fee0 = (amount0 * 3) / 997 + 1;
            MockToken(t0).mint(pair, amount0 + fee0);
        }
        if (amount1 > 0) {
            uint256 fee1 = (amount1 * 3) / 997 + 1;
            MockToken(t1).mint(pair, amount1 + fee1);
        }
    }
}

contract AmmUpgradeStressTest is AmmBase {
    MockToken internal tD;
    CircleswapPair internal pairAB;
    CircleswapPair internal pairBC;
    CircleswapPair internal pairCD;
    CircleswapPair internal pairAC;

    function setUp() public override {
        super.setUp();
        tD = new MockToken("D", "D", 18);

        pairAB = _seed(tA, tB, 100_000e18, 200_000e18);
        pairBC = _seed(tB, tC, 150_000e18, 150_000e18);
        pairCD = _seed(tC, tD, 80_000e18, 240_000e18);
        pairAC = _seed(tA, tC, 50_000e18, 100_000e18);
    }

    /// @notice Multi-pool beacon upgrade invariant test:
    ///         Reserves, LP tokens, and total supplies strictly preserved across 4 pools.
    function test_multiPoolBeaconUpgrade_reservesAndBalancesPreserved() public {
        // Execute swaps before upgrade
        tA.mint(trader, 1_000e18);
        _approveRouter(tA, trader);
        vm.prank(trader);
        router.swapExactTokensForTokens(1_000e18, 0, _path2(address(tA), address(tB)), trader, block.timestamp);

        tB.mint(trader, 500e18);
        _approveRouter(tB, trader);
        vm.prank(trader);
        router.swapExactTokensForTokens(500e18, 0, _path3(address(tB), address(tC), address(tD)), trader, block.timestamp);

        // Snapshot reserves and supplies
        (uint112 rAB_0, uint112 rAB_1, ) = pairAB.getReserves();
        (uint112 rBC_0, uint112 rBC_1, ) = pairBC.getReserves();
        (uint112 rCD_0, uint112 rCD_1, ) = pairCD.getReserves();
        (uint112 rAC_0, uint112 rAC_1, ) = pairAC.getReserves();

        uint256 lpAB = pairAB.balanceOf(lp);
        uint256 lpBC = pairBC.balanceOf(lp);
        uint256 lpCD = pairCD.balanceOf(lp);
        uint256 lpAC = pairAC.balanceOf(lp);

        uint256 supAB = pairAB.totalSupply();
        uint256 supBC = pairBC.totalSupply();
        uint256 supCD = pairCD.totalSupply();
        uint256 supAC = pairAC.totalSupply();

        // Perform UpgradeableBeacon upgrade to CircleswapPairV2
        CircleswapPairV2 newImpl = new CircleswapPairV2();
        address beaconAddr = factory.pairBeacon();
        UpgradeableBeacon beacon = UpgradeableBeacon(beaconAddr);
        factory.upgradePairImplementation(address(newImpl));

        assertEq(factory.pairImplementation(), address(newImpl));

        // Verify state is strictly preserved
        (uint112 rAB_0_after, uint112 rAB_1_after, ) = pairAB.getReserves();
        (uint112 rBC_0_after, uint112 rBC_1_after, ) = pairBC.getReserves();
        (uint112 rCD_0_after, uint112 rCD_1_after, ) = pairCD.getReserves();
        (uint112 rAC_0_after, uint112 rAC_1_after, ) = pairAC.getReserves();

        assertEq(rAB_0, rAB_0_after, "rAB_0 altered");
        assertEq(rAB_1, rAB_1_after, "rAB_1 altered");
        assertEq(rBC_0, rBC_0_after, "rBC_0 altered");
        assertEq(rBC_1, rBC_1_after, "rBC_1 altered");
        assertEq(rCD_0, rCD_0_after, "rCD_0 altered");
        assertEq(rCD_1, rCD_1_after, "rCD_1 altered");
        assertEq(rAC_0, rAC_0_after, "rAC_0 altered");
        assertEq(rAC_1, rAC_1_after, "rAC_1 altered");

        assertEq(pairAB.balanceOf(lp), lpAB, "lpAB altered");
        assertEq(pairBC.balanceOf(lp), lpBC, "lpBC altered");
        assertEq(pairCD.balanceOf(lp), lpCD, "lpCD altered");
        assertEq(pairAC.balanceOf(lp), lpAC, "lpAC altered");

        assertEq(pairAB.totalSupply(), supAB, "supAB altered");
        assertEq(pairBC.totalSupply(), supBC, "supBC altered");
        assertEq(pairCD.totalSupply(), supCD, "supCD altered");
        assertEq(pairAC.totalSupply(), supAC, "supAC altered");

        // Subsequent swap works
        tC.mint(trader, 200e18);
        _approveRouter(tC, trader);
        vm.prank(trader);
        router.swapExactTokensForTokens(200e18, 0, _path2(address(tC), address(tD)), trader, block.timestamp);

        // Subsequent add liquidity works
        tA.mint(trader, 1_000e18);
        tB.mint(trader, 2_000e18);
        _approveRouter(tA, trader);
        _approveRouter(tB, trader);
        vm.prank(trader);
        router.addLiquidity(address(tA), address(tB), 1_000e18, 2_000e18, 0, 0, trader, block.timestamp);
        assertGt(pairAB.balanceOf(trader), 0);
    }

    /// @notice Reentrancy through BeaconProxy is strictly blocked before and after upgrade
    function test_reentrancyThroughProxyBlocked_beforeAndAfterUpgrade() public {
        ReentrantPairCaller caller = new ReentrantPairCaller(address(pairAB));
        tA.mint(address(caller), 10e18);
        tB.mint(address(caller), 10e18);

        // Before upgrade: test modes 1 through 5
        for (uint8 m = 1; m <= 5; m++) {
            caller.testFlash(m, 1e18, 0);
            assertTrue(caller.reentryFailed(), "Reentrancy not blocked before upgrade");
        }

        // Upgrade beacon
        CircleswapPairV2 newImpl = new CircleswapPairV2();
        factory.upgradePairImplementation(address(newImpl));

        // After upgrade: test modes 1 through 5
        for (uint8 m = 1; m <= 5; m++) {
            caller.testFlash(m, 1e18, 0);
            assertTrue(caller.reentryFailed(), "Reentrancy not blocked after upgrade");
        }
    }
}
