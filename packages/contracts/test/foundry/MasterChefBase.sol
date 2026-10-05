// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import "../../contracts/CircleswapMasterChef.sol";
import "../../contracts/mocks/AmmMocks.sol";
import "../../contracts/mocks/MockBoost.sol";

/// @dev A farm with two reward tokens (BoltDelta "A" and Q0 "B", 18 decimals) and a stake token.
abstract contract MasterChefBase is Test {
    CircleswapMasterChef internal farm;
    MockToken internal rewardA;
    MockToken internal rewardB;
    MockToken internal stake;
    MockBoost internal boost;

    function setUp() public virtual {
        rewardA = new MockToken("BoltDelta", "BDELTA", 18);
        rewardB = new MockToken("Q0", "Q0", 18);
        stake = new MockToken("LP", "LP", 18);
        boost = new MockBoost();
    }

    function _deployFarm(uint256 ratePerSecA, uint256 ratePerSecB, bool withBoost) internal {
        farm = new CircleswapMasterChef(
            address(this), rewardA, rewardB, withBoost ? IQrbBoost(address(boost)) : IQrbBoost(address(0)), ratePerSecA, ratePerSecB
        );
    }

    function _fundFarm(uint256 a, uint256 b) internal {
        rewardA.mint(address(farm), a);
        rewardB.mint(address(farm), b);
    }

    function _stake(address who, IERC20 token, uint256 pid, uint256 amount) internal {
        MockToken(address(token)).mint(who, amount);
        vm.startPrank(who);
        token.approve(address(farm), type(uint256).max);
        farm.deposit(pid, amount);
        vm.stopPrank();
    }

    function _pending(uint256 pid, address who) internal view returns (uint256 a, uint256 b) {
        return farm.pendingRewards(pid, who);
    }
}
