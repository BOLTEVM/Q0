// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MasterChefBase.sol";

/// @dev Drives the farm with random, always-valid actions and keeps ghost totals the invariants compare against.
///      Reverting here is a handler bug (fail_on_revert), so every action checks its own preconditions.
contract FarmHandler is Test {
    CircleswapMasterChef public immutable farm;
    MockToken public immutable rewardA;
    MockToken public immutable rewardB;
    MockToken public immutable stake;
    MockBoost public immutable boost;
    address public immutable farmOwner;

    address[] public actors;
    MockToken[3] public tokens; // stake candidates: LP, rewardA, rewardB

    // Ghosts.
    mapping(uint256 => mapping(address => uint256)) public netStaked; // pid => actor => deposited - withdrawn
    uint256 public emittedA; // upper bound on what the emission schedule has released
    uint256 public emittedB;
    uint256 public paidA;
    uint256 public paidB;
    uint256 public calls;

    constructor(
        CircleswapMasterChef farm_,
        MockToken rA,
        MockToken rB,
        MockToken stake_,
        MockBoost boost_,
        address farmOwner_
    ) {
        farm = farm_;
        rewardA = rA;
        rewardB = rB;
        stake = stake_;
        boost = boost_;
        farmOwner = farmOwner_;
        tokens[0] = stake_;
        tokens[1] = rA;
        tokens[2] = rB;
        for (uint256 i; i < 3; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            for (uint256 t; t < 3; ++t) {
                vm.prank(a);
                tokens[t].approve(address(farm_), type(uint256).max);
            }
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ---------------------------------------------------------------------------------------------- helpers

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pid(uint256 seed) internal view returns (uint256) {
        return seed % farm.poolLength();
    }

    /// @dev Runs `fn`'s effect and attributes the reward tokens that left the farm to `paid*`.
    ///      Farm balance change = -paid + (principal in - principal out), and principal in/out is exactly the
    ///      change in stakedByToken, so paid = balBefore - balAfter + (stakedAfter - stakedBefore).
    modifier tracksPayouts() {
        uint256 bA = rewardA.balanceOf(address(farm));
        uint256 sA = farm.stakedByToken(rewardA);
        uint256 bB = rewardB.balanceOf(address(farm));
        uint256 sB = farm.stakedByToken(rewardB);
        _;
        paidA += bA + farm.stakedByToken(rewardA) - rewardA.balanceOf(address(farm)) - sA;
        paidB += bB + farm.stakedByToken(rewardB) - rewardB.balanceOf(address(farm)) - sB;
        ++calls;
    }

    // ---------------------------------------------------------------------------------------------- actions

    function deposit(uint256 actorSeed, uint256 pidSeed, uint256 amount) external tracksPayouts {
        if (farm.paused()) return;
        address a = _actor(actorSeed);
        uint256 pid = _pid(pidSeed);
        amount = bound(amount, 0, 1e24);
        (IERC20 lpToken, , , , , ) = farm.poolInfo(pid);
        MockToken(address(lpToken)).mint(a, amount);
        vm.prank(a);
        farm.deposit(pid, amount);
        netStaked[pid][a] += amount;
    }

    function withdraw(uint256 actorSeed, uint256 pidSeed, uint256 amount) external tracksPayouts {
        address a = _actor(actorSeed);
        uint256 pid = _pid(pidSeed);
        (uint256 have, , , , ) = farm.userInfo(pid, a);
        amount = bound(amount, 0, have);
        vm.prank(a);
        farm.withdraw(pid, amount);
        netStaked[pid][a] -= amount;
    }

    function harvest(uint256 actorSeed, uint256 pidSeed) external tracksPayouts {
        if (farm.paused()) return;
        address a = _actor(actorSeed);
        uint256 pid = _pid(pidSeed); // read before pranking: a prank applies to the very next external call
        vm.prank(a);
        farm.harvest(pid);
    }

    function emergencyWithdraw(uint256 actorSeed, uint256 pidSeed) external tracksPayouts {
        address a = _actor(actorSeed);
        uint256 pid = _pid(pidSeed);
        vm.prank(a);
        farm.emergencyWithdraw(pid);
        netStaked[pid][a] = 0;
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 0, 7 days);
        emittedA += farm.rewardAPerSecond() * dt;
        emittedB += farm.rewardBPerSecond() * dt;
        vm.warp(vm.getBlockTimestamp() + dt);
        ++calls;
    }

    function setBoost(uint256 actorSeed, uint256 bps) external {
        boost.set(_actor(actorSeed), bound(bps, 0, 20_000)); // above 10_000 must be capped by the farm
        ++calls;
    }

    function setRates(uint256 a, uint256 b) external {
        vm.prank(farmOwner);
        farm.setEmissionRates(bound(a, 0, 1e19), bound(b, 0, 1e19));
        ++calls;
    }

    function setPool(uint256 pidSeed, uint256 alloc) external {
        uint256 pid = _pid(pidSeed);
        vm.prank(farmOwner);
        farm.setPool(pid, bound(alloc, 0, 1000));
        ++calls;
    }

    function addPool(uint256 tokenSeed, uint256 alloc) external {
        if (farm.poolLength() >= 6) return;
        vm.prank(farmOwner);
        farm.addPool(bound(alloc, 0, 1000), IERC20(address(tokens[tokenSeed % 3])));
        ++calls;
    }

    function togglePause() external {
        bool isPaused = farm.paused();
        vm.prank(farmOwner);
        if (isPaused) farm.unpause();
        else farm.pause();
        ++calls;
    }

    function refill(uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        rewardA.mint(address(farm), amount);
        rewardB.mint(address(farm), amount);
        ++calls;
    }

    /// @dev Tokens sent straight to the farm by mistake must never become claimable principal or break accounting.
    function donate(uint256 tokenSeed, uint256 amount) external {
        tokens[tokenSeed % 3].mint(address(farm), bound(amount, 0, 1e21));
        ++calls;
    }
}

contract MasterChefInvariantTest is MasterChefBase {
    FarmHandler internal handler;

    function setUp() public override {
        super.setUp();
        _deployFarm(1e18, 5e17, true);
        // Three pools: an LP, and each reward token staked on its own. Staking a reward token is the case where
        // principal and rewards share one balance.
        farm.addPool(50, IERC20(address(stake)));
        farm.addPool(30, IERC20(address(rewardA)));
        farm.addPool(20, IERC20(address(rewardB)));
        _fundFarm(1e24, 1e24); // deliberately modest: shortfalls must be handled, not avoided

        handler = new FarmHandler(farm, rewardA, rewardB, stake, boost, address(this));
        targetContract(address(handler));
    }

    function _pools() internal view returns (uint256 n) {
        return farm.poolLength();
    }

    /// Rewards are only ever paid out of the surplus: the farm always holds at least everything staked.
    function invariant_principalAlwaysBacked() public view {
        assertGe(stake.balanceOf(address(farm)), farm.stakedByToken(stake), "LP principal under water");
        assertGe(rewardA.balanceOf(address(farm)), farm.stakedByToken(rewardA), "reward A principal under water");
        assertGe(rewardB.balanceOf(address(farm)), farm.stakedByToken(rewardB), "reward B principal under water");
    }

    /// The books tie out: per-pool totals equal the sum of the stakers, and per-token totals equal the sum of
    /// the pools staking that token.
    function invariant_stakeAccounting() public view {
        uint256 lp;
        uint256 a;
        uint256 b;
        for (uint256 pid; pid < _pools(); ++pid) {
            (IERC20 token, , , , , uint256 total) = farm.poolInfo(pid);
            uint256 sum;
            for (uint256 i; i < handler.actorCount(); ++i) {
                (uint256 amount, , , , ) = farm.userInfo(pid, handler.actors(i));
                assertEq(amount, handler.netStaked(pid, handler.actors(i)), "user stake != deposits - withdrawals");
                sum += amount;
            }
            assertEq(total, sum, "pool total != sum of stakers");
            if (address(token) == address(stake)) lp += total;
            else if (address(token) == address(rewardA)) a += total;
            else b += total;
        }
        assertEq(farm.stakedByToken(stake), lp, "stakedByToken(LP) drifted");
        assertEq(farm.stakedByToken(rewardA), a, "stakedByToken(A) drifted");
        assertEq(farm.stakedByToken(rewardB), b, "stakedByToken(B) drifted");
    }

    /// Nothing can be paid or become claimable beyond the emission schedule plus the (capped, +100%) boost.
    function invariant_neverOverDistributes() public view {
        uint256 claimableA;
        uint256 claimableB;
        for (uint256 pid; pid < _pools(); ++pid) {
            for (uint256 i; i < handler.actorCount(); ++i) {
                (uint256 pa, uint256 pb) = farm.pendingRewards(pid, handler.actors(i));
                claimableA += pa;
                claimableB += pb;
            }
        }
        // 2 wei of slack per pool per actor for accumulator rounding in the user's favour.
        uint256 slack = _pools() * handler.actorCount() * 2;
        assertLe(handler.paidA() + claimableA, 2 * handler.emittedA() + slack, "reward A over-distributed");
        assertLe(handler.paidB() + claimableB, 2 * handler.emittedB() + slack, "reward B over-distributed");
    }

    /// Whatever happened, every staker can walk out with exactly their principal, even paused and even if the
    /// reward inventory is empty.
    function afterInvariant() public {
        for (uint256 pid; pid < _pools(); ++pid) {
            (IERC20 token, , , , , ) = farm.poolInfo(pid);
            for (uint256 i; i < handler.actorCount(); ++i) {
                address who = handler.actors(i);
                (uint256 have, , , , ) = farm.userInfo(pid, who);
                uint256 before = token.balanceOf(who);
                vm.prank(who);
                farm.emergencyWithdraw(pid);
                assertEq(token.balanceOf(who) - before, have, "emergency exit returned the wrong principal");
            }
        }
        assertEq(farm.stakedByToken(stake), 0);
        assertEq(farm.stakedByToken(rewardA), 0);
        assertEq(farm.stakedByToken(rewardB), 0);
    }
}
