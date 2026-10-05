// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MasterChefBase.sol";

/// @notice Targeted properties the invariant campaign is too coarse to pin down: the boost cap, shortfall
///         accounting, single-asset pools, and how the emission is shared.
contract MasterChefBehaviorTest is MasterChefBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal constant RATE = 1e18;

    function _lpFarm(bool withBoost) internal {
        _deployFarm(RATE, RATE, withBoost);
        farm.addPool(1, IERC20(address(stake)));
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// Whatever a boost source reports, a staker never earns more than double the base emission.
    function testFuzz_boostIsCappedAtDouble(uint256 reported, uint256 amount, uint256 dt) public {
        reported = bound(reported, 0, type(uint256).max);
        amount = bound(amount, 1e18, 1e27);
        dt = bound(dt, 1, 30 days);
        _lpFarm(true);
        boost.set(alice, reported);
        _stake(alice, IERC20(address(stake)), 0, amount);
        _fundFarm(type(uint128).max, type(uint128).max);

        vm.warp(_now() + dt);
        (uint256 a, ) = _pending(0, alice);
        assertLe(a, 2 * RATE * dt, "boost paid more than +100%");
        vm.prank(alice);
        farm.harvest(0);
        assertLe(rewardA.balanceOf(alice), 2 * RATE * dt, "harvest paid more than +100%");
    }

    /// A boost source that reverts costs the staker the boost, never the harvest.
    function test_revertingBoostSourceDoesNotBlockHarvest() public {
        RevertingBoost bad = new RevertingBoost();
        farm = new CircleswapMasterChef(address(this), rewardA, rewardB, IQrbBoost(address(bad)), RATE, RATE);
        farm.addPool(1, IERC20(address(stake)));
        _stake(alice, IERC20(address(stake)), 0, 1e18);
        _fundFarm(1e30, 1e30);
        vm.warp(_now() + 100);
        vm.prank(alice);
        farm.harvest(0);
        assertEq(rewardA.balanceOf(alice), RATE * 100);
    }

    /// If the inventory is empty, nothing is forfeited: what is owed is recorded, and the next harvest after a
    /// refill pays exactly that.
    function testFuzz_shortfallIsOwedAndPaidAfterRefill(uint256 dt, uint256 amount) public {
        dt = bound(dt, 1, 30 days);
        amount = bound(amount, 1e18, 1e27);
        _lpFarm(false);
        _stake(alice, IERC20(address(stake)), 0, amount);

        vm.warp(_now() + dt);
        vm.prank(alice);
        farm.harvest(0); // nothing in the inventory
        assertEq(rewardA.balanceOf(alice), 0);
        (, , , uint256 unpaidA, uint256 unpaidB) = farm.userInfo(0, alice);
        // The accumulator floors, so a staker can be short by up to stake / 1e24 + 1 wei of what was emitted.
        assertApproxEqAbs(unpaidA, RATE * dt, amount / 1e24 + 2, "owed reward A not recorded");
        assertApproxEqAbs(unpaidB, RATE * dt, amount / 1e24 + 2, "owed reward B not recorded");

        _fundFarm(type(uint128).max, type(uint128).max);
        vm.prank(alice);
        farm.harvest(0); // same block: nothing new has accrued
        assertEq(rewardA.balanceOf(alice), unpaidA, "owed reward A not paid after refill");
        assertEq(rewardB.balanceOf(alice), unpaidB, "owed reward B not paid after refill");
        (, , , uint256 leftA, uint256 leftB) = farm.userInfo(0, alice);
        assertEq(leftA + leftB, 0);
    }

    /// Boost is applied to what was newly earned, once. A shortfall carried forward is not boosted again.
    function testFuzz_unpaidIsNotBoostedTwice(uint256 dt) public {
        dt = bound(dt, 1, 30 days);
        _lpFarm(true);
        boost.set(alice, 5000);
        _stake(alice, IERC20(address(stake)), 0, 1e21);

        vm.warp(_now() + dt);
        vm.prank(alice);
        farm.harvest(0); // empty inventory: the boosted amount is recorded as owed
        (, , , uint256 owed, ) = farm.userInfo(0, alice);
        assertApproxEqAbs(owed, (RATE * dt * 15_000) / 10_000, 2, "owed is not base x 1.5");

        _fundFarm(type(uint128).max, type(uint128).max);
        vm.prank(alice);
        farm.harvest(0);
        assertEq(rewardA.balanceOf(alice), owed, "the carried-forward amount was boosted again");
    }

    /// A pool that stakes a reward token cannot pay rewards out of its own depositors' principal, and the
    /// depositors can always take it back.
    function testFuzz_singleAssetPoolNeverPaysFromPrincipal(uint256 amount, uint256 dt) public {
        amount = bound(amount, 1e18, 1e27);
        dt = bound(dt, 1, 30 days);
        _deployFarm(RATE, RATE, false);
        farm.addPool(1, IERC20(address(rewardA)));
        _stake(alice, IERC20(address(rewardA)), 0, amount); // the farm holds ONLY alice's principal

        vm.warp(_now() + dt);
        vm.prank(alice);
        farm.harvest(0);
        assertEq(rewardA.balanceOf(alice), 0, "principal was paid out as a reward");
        assertEq(rewardA.balanceOf(address(farm)), amount, "principal moved");

        vm.prank(alice);
        farm.withdraw(0, amount);
        assertEq(rewardA.balanceOf(alice), amount, "could not recover the whole principal");
    }

    /// Two stakers share the emission in proportion to their stake, and (up to rounding) all of it is paid.
    function testFuzz_emissionIsSharedProportionallyAndFullyPaid(uint256 x, uint256 y, uint256 dt) public {
        x = bound(x, 1e15, 1e27);
        y = bound(y, 1e15, 1e27);
        dt = bound(dt, 1, 30 days);
        _lpFarm(false);
        _stake(alice, IERC20(address(stake)), 0, x);
        _stake(bob, IERC20(address(stake)), 0, y);
        vm.warp(_now() + dt);

        (uint256 pa, ) = _pending(0, alice);
        (uint256 pb, ) = _pending(0, bob);
        uint256 total = RATE * dt;
        assertLe(pa + pb, total, "paid out more than was emitted");
        // Each staker's floor costs at most stake / 1e24 + 1 wei, so the whole shortfall is bounded by that.
        assertLe(total - (pa + pb), (x + y) / 1e24 + 4, "emission went missing beyond rounding");
        // pa/x == pb/y, up to each side's floor error (delta_a <= x/1e24 + 1, delta_b <= y/1e24 + 1).
        uint256 lhs = pa * y;
        uint256 rhs = pb * x;
        uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        assertLe(diff, (x * y) / 1e24 * 2 + 2 * (x + y) + 2, "split is not proportional");
    }

    /// Adding a pool or changing allocation never rewrites what was already earned.
    function testFuzz_allocationChangeDoesNotRewriteHistory(uint256 dt, uint256 newAlloc) public {
        dt = bound(dt, 1, 30 days);
        newAlloc = bound(newAlloc, 0, 1e6);
        _lpFarm(false);
        _stake(alice, IERC20(address(stake)), 0, 1e21);
        vm.warp(_now() + dt);
        (uint256 before, ) = _pending(0, alice);

        farm.setPool(0, newAlloc);
        farm.addPool(1e3, IERC20(address(rewardB)));
        (uint256 afterChange, ) = _pending(0, alice);
        assertEq(afterChange, before, "a pool change altered rewards already earned");
    }
}
