// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Creates and indexes Circleswap pools. Anyone can create a pool; only the owner can turn on the
///         protocol fee or update the pool beacon.
interface ICircleswapFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);
    event FeeToUpdated(address indexed previousFeeTo, address indexed newFeeTo);
    event PairBeaconUpdated(address indexed previousBeacon, address indexed newBeacon);

    /// @notice Where the protocol's share of trading fees is minted as LP tokens; address(0) means fee off.
    function feeTo() external view returns (address);

    /// @notice The pool implementation every pool is a beacon-proxy clone of.
    function pairImplementation() external view returns (address);

    /// @notice The UpgradeableBeacon contract managing pool implementation upgrades.
    function pairBeacon() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function allPairs(uint256 index) external view returns (address pair);

    function allPairsLength() external view returns (uint256);

    /// @notice Creates the pool for two tokens. Reverts if it already exists.
    function createPair(address tokenA, address tokenB) external returns (address pair);
}
