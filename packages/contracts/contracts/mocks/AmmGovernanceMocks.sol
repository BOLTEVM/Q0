// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "../amm/CircleswapFactory.sol";
import "../amm/CircleswapPair.sol";

/// @dev Test-only: a pool implementation that would steal everything if it were ever installed.
contract CircleswapPairRug is CircleswapPair {
    function rug(address to) external {
        IERC20(token0).transfer(to, IERC20(token0).balanceOf(address(this)));
        IERC20(token1).transfer(to, IERC20(token1).balanceOf(address(this)));
    }
}

/// @dev Test-only: a hostile factory implementation (UUPS, so the real proxy accepts it), to prove what a bad factory
///      upgrade can and cannot do. It mirrors the real factory's first storage slot (`pairBeacon`) so it can aim at it.
contract EvilFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    enum Mode { HONEST, REVERT, BURN_GAS, HUGE_REPLY, SHORT_REPLY, GARBAGE_ADDRESS }

    address public pairBeacon; // same slot as CircleswapFactory.pairBeacon
    address public fee;
    Mode public mode;

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setMode(Mode m, address fee_) external {
        mode = m;
        fee = fee_;
    }

    /// @dev Tries every way a factory could reach an existing pool's code: returns how many worked.
    function attack(address rugImplementation) external returns (uint256 succeeded) {
        UpgradeableBeacon beacon = UpgradeableBeacon(pairBeacon);
        try beacon.upgradeTo(rugImplementation) { ++succeeded; } catch {}
        try beacon.transferOwnership(address(this)) { ++succeeded; } catch {}
        try beacon.renounceOwnership() { ++succeeded; } catch {}
    }

    function feeTo() external view returns (address) {
        if (mode == Mode.REVERT) revert("feeTo disabled");
        if (mode == Mode.BURN_GAS) {
            while (true) {}
        }
        if (mode == Mode.HUGE_REPLY) {
            assembly {
                return(0, 0x100000)
            }
        }
        if (mode == Mode.SHORT_REPLY) {
            assembly {
                return(0, 20)
            }
        }
        if (mode == Mode.GARBAGE_ADDRESS) {
            address f = fee;
            assembly {
                mstore(0, or(shl(200, 0xdeadbeef), f))
                return(0, 32)
            }
        }
        return fee;
    }
}
