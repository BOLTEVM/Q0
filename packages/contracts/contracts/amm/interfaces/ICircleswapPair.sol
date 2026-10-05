// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A Circleswap constant-product pool. The pool contract is also its own liquidity-provider (LP) token.
/// @dev The read/write surface deliberately matches the widely used constant-product pair ABI
///      (token0/token1/getReserves/mint/burn/swap/skim/sync), so existing wallets, explorers and the app's
///      reserve readers work unchanged.
interface ICircleswapPair {
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    /// @notice LP tokens permanently locked at the first deposit so a pool can never be drained to zero shares.
    function MINIMUM_LIQUIDITY() external pure returns (uint256);

    function factory() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    function price0CumulativeLast() external view returns (uint256);

    function price1CumulativeLast() external view returns (uint256);

    /// @notice reserve0 * reserve1 as of the last liquidity event; only tracked while the protocol fee is on.
    function kLast() external view returns (uint256);

    /// @notice Called once by the factory right after the pool is created.
    function initialize(address token0_, address token1_) external;

    /// @notice Mints LP tokens for tokens already transferred in. Call through the router.
    function mint(address to) external returns (uint256 liquidity);

    /// @notice Burns LP tokens already transferred in and pays out the underlying. Call through the router.
    function burn(address to) external returns (uint256 amount0, uint256 amount1);

    /// @notice Swaps: pays `amount0Out`/`amount1Out` to `to` first, then requires the pool to have been paid
    ///         enough (net of the 0.3% fee) to keep its constant product from falling. Non-empty `data` makes
    ///         it a flash swap: `to` is called back and must repay inside that call.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;

    /// @notice Sends any balance above the recorded reserves to `to`.
    function skim(address to) external;

    /// @notice Sets the recorded reserves to the actual balances.
    function sync() external;
}
