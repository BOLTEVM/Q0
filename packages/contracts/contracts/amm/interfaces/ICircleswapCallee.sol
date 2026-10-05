// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Implemented by a contract that receives a flash swap from a Circleswap pool. The pool has already
///         sent the requested tokens; this call must leave the pool paid back (plus the 0.3% fee) or the whole
///         swap reverts.
interface ICircleswapCallee {
    function circleswapCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
