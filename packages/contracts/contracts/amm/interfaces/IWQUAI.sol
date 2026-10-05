// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Wrapped native QUAI (WQUAI): deposit native QUAI to mint 1:1, withdraw to burn and get it back.
///         The Cyprus-1 deployment is 0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB (18 decimals, no permit).
interface IWQUAI is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
