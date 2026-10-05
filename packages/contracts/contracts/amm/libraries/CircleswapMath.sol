// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Constant-product (x * y = k) pricing with a 0.3% fee, used by the router and mirrored exactly by the
///         app's quote code (`quai-service` simulateSwap): out = in*997*rOut / (rIn*1000 + in*997).
library CircleswapMath {
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InsufficientAmount();

    uint256 internal constant FEE_NUMERATOR = 997;
    uint256 internal constant FEE_DENOMINATOR = 1000;

    /// @notice Given some of one token, the equivalent amount of the other at the current ratio (no fee): used
    ///         to size a liquidity deposit.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        amountB = (amountA * reserveB) / reserveA;
    }

    /// @notice The most of the output token that `amountIn` buys after the fee, rounded down (in the pool's favour).
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    /// @notice The least input that buys exactly `amountOut` after the fee, rounded up (in the pool's favour).
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut == 0 || amountOut >= reserveOut) revert InsufficientLiquidity();
        uint256 numerator = reserveIn * amountOut * FEE_DENOMINATOR;
        uint256 denominator = (reserveOut - amountOut) * FEE_NUMERATOR;
        return numerator / denominator + 1;
    }
}
