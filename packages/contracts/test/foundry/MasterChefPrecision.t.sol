// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MasterChefBase.sol";

/// @notice How much of the configured emission actually reaches stakers. The per-share accumulator is an
///         integer, so it floors on every pool update; how much that costs depends on the size of the staked
///         supply relative to the emission earned between updates.
contract MasterChefPrecisionTest is MasterChefBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// One staker holds the whole pool and someone touches the pool every `step` seconds (any deposit,
    /// withdraw or harvest by anyone does). The staker must end up with essentially the full emission.
    function _lossBps(uint256 ratePerSec, uint256 staked, uint256 step, uint256 duration) internal returns (uint256) {
        _deployFarm(ratePerSec, ratePerSec, false);
        farm.addPool(1, IERC20(address(stake)));
        _stake(alice, IERC20(address(stake)), 0, staked);
        uint256 t0 = vm.getBlockTimestamp(); // not block.timestamp: via_ir may re-read it after each warp
        for (uint256 t = step; t <= duration; t += step) {
            vm.warp(t0 + t);
            farm.updatePool(0);
        }
        uint256 ideal = ratePerSec * ((duration / step) * step);
        (uint256 got, ) = _pending(0, alice);
        return ((ideal - got) * 10_000) / ideal;
    }

    /// Plenty of emission for the supply: the loss is invisible.
    function test_precision_typical_lossIsNegligible() public {
        // 1 token per second, 1,000,000 tokens staked, touched every 5 seconds for a day.
        assertLe(_lossBps(1e18, 1e24, 5, 1 days), 1, "typical farm loses more than 0.01% of emission");
    }

    /// A large staked supply with a small emission: the accumulator floors away a large share of what was
    /// emitted, and it never reaches anyone. 3 billion tokens staked (a common meme-token supply), 0.001 token
    /// per second, one touch every 5 seconds.
    function test_precision_largeSupplySmallEmission() public {
        uint256 lossBps = _lossBps(1e15, 3e27, 5, 1 days);
        emit log_named_uint("emission lost to rounding (bps of 10000)", lossBps);
        assertLe(lossBps, 10, "more than 0.1% of the emission is lost to rounding");
    }

    /// Fuzzed: whatever the supply and rate, the staker is never short by more than 0.1% unless the emission
    /// itself is dust. `step` models how often the pool is touched.
    function testFuzz_precision_boundedLoss(uint256 rate, uint256 staked, uint256 step) public {
        rate = bound(rate, 1e12, 1e21); // 1e-6 .. 1000 tokens per second
        staked = bound(staked, 1e18, 1e30); // 1 .. 1e12 tokens
        step = bound(step, 1, 600);
        uint256 lossBps = _lossBps(rate, staked, step, 2 hours);
        assertLe(lossBps, 10, "more than 0.1% of the emission is lost to rounding");
    }
}
