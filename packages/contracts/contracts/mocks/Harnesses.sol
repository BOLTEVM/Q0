// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../libraries/ArweaveURI.sol";
import "../libraries/QrbFormat.sol";

/// @dev Test-only: exposes the internal library functions so they can be tested directly.
contract FormatHarness {
    function isValidArweave(string memory uri) external pure returns (bool) {
        return ArweaveURI.isValid(uri);
    }

    function pct(uint256 bps) external pure returns (string memory) {
        return QrbFormat.pct(bps);
    }

    function amount18(uint256 value) external pure returns (string memory) {
        return QrbFormat.amount18(value);
    }

    function duration(uint256 secs) external pure returns (string memory) {
        return QrbFormat.duration(secs);
    }
}

/// @dev Test-only ERC-20 that, while armed, calls back into a target from inside its transfer hook, to prove
///      the farm's reentrancy guard holds against a hostile stake token.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public lastCallSucceeded;
    bool public attempted;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && to == target) {
            armed = false; // one attempt
            attempted = true;
            (bool ok, ) = target.call(payload);
            lastCallSucceeded = ok;
        }
    }
}
