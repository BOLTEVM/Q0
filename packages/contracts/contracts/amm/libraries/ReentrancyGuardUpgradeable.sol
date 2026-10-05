// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @dev OpenZeppelin v5 ReentrancyGuard wrapper for upgradeable contracts.
 *      In OpenZeppelin v5, ReentrancyGuard is stateless and uses ERC-7201 storage namespace
 *      (slot 0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00).
 */
abstract contract ReentrancyGuardUpgradeable is Initializable, ReentrancyGuard {
    function __ReentrancyGuard_init() internal onlyInitializing {}
}
