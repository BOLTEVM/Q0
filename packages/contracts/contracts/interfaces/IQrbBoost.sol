// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IQrbBoost
 * @notice The one interface anything uses to ask "does this account get the Qrb boost, and how much".
 * @dev Implemented by the Qrb ERC-20 and nothing else. The boost percentage and the holding threshold
 *      are defined once, here in the implementer's constants; the farm, the NFT metadata, the app and
 *      the tests all read them from it (or are checked against it) instead of carrying their own copy.
 */
interface IQrbBoost {
    /// @notice Extra reward, in basis points of the base reward, paid to a qualifying holder (5000 = +50%).
    function BOOST_BPS() external view returns (uint256);

    /// @notice Minimum QRB balance, in wei (18 decimals), that qualifies an account for the boost.
    function BOOST_THRESHOLD() external view returns (uint256);

    /// @notice How long, in seconds, an account must have continuously held at least BOOST_THRESHOLD before
    ///         it is boosted. This is what stops a balance from being borrowed for one transaction (a flash
    ///         swap or a lender contract) to claim the boost without ever really holding the token.
    function BOOST_MATURITY() external view returns (uint256);

    /// @notice Boost in basis points for `account` right now: BOOST_BPS if it has held at least
    ///         BOOST_THRESHOLD continuously for BOOST_MATURITY, otherwise 0.
    function boostBpsOf(address account) external view returns (uint256);
}
