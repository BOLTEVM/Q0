// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title CircleswapTimelock
 * @author Circleswap DeFi Protocol
 * @notice The owner of the factory and router proxies. Every owner action (an upgrade, a fee switch, freezing
 *         pool upgrades, a new pool version) must be scheduled here and can only run after `getMinDelay()`
 *         seconds, in public, with the exact call data on chain. Liquidity providers and traders therefore always
 *         have at least that long to see an upgrade coming and leave before it takes effect.
 *
 * @dev This is OpenZeppelin's audited TimelockController with three restrictions:
 *        - no admin: the role administrator is the timelock itself, so adding or removing a proposer or executor
 *          is itself a delayed operation, and nobody (including the deployer) keeps a back door;
 *        - the delay can never be set below MIN_DELAY_FLOOR (1 day) or above MAX_DELAY (30 days), not even by
 *          an operation scheduled through the timelock, so a delay of zero is unreachable;
 *        - proposers are also cancellers (OpenZeppelin's default), so a proposal that turns out to be wrong can
 *          be withdrawn before it runs.
 *      Pass address(0) as the only executor to let anyone execute a ready operation (recommended: execution is
 *      then not a privilege).
 */
contract CircleswapTimelock is TimelockController {
    uint256 public constant MIN_DELAY_FLOOR = 1 days;
    uint256 public constant MAX_DELAY = 30 days;

    error DelayOutOfRange(uint256 delay);

    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0))
    {
        _checkDelay(minDelay);
    }

    /// @dev Same as the parent (callable only by the timelock itself), with the floor and ceiling enforced.
    function updateDelay(uint256 newDelay) public virtual override {
        _checkDelay(newDelay);
        super.updateDelay(newDelay);
    }

    function _checkDelay(uint256 delay) private pure {
        if (delay < MIN_DELAY_FLOOR || delay > MAX_DELAY) revert DelayOutOfRange(delay);
    }
}
