// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title QrbFormat
 * @notice Human-readable rendering of the boost figures, so on-chain metadata is generated from the same
 *         constants the farm uses rather than typed in a second time.
 */
library QrbFormat {
    /// @dev 5000 -> "50%", 1250 -> "12.5%", 5 -> "0.05%".
    function pct(uint256 bps) internal pure returns (string memory) {
        uint256 whole = bps / 100;
        uint256 rem = bps % 100;
        if (rem == 0) return string.concat(Strings.toString(whole), "%");
        if (rem % 10 == 0) return string.concat(Strings.toString(whole), ".", Strings.toString(rem / 10), "%");
        return string.concat(Strings.toString(whole), ".", rem < 10 ? "0" : "", Strings.toString(rem), "%");
    }

    /// @dev 18-decimal amount with trailing zeros trimmed: 1e14 -> "0.0001", 1e18 -> "1".
    function amount18(uint256 value) internal pure returns (string memory) {
        uint256 whole = value / 1e18;
        uint256 frac = value % 1e18;
        if (frac == 0) return Strings.toString(whole);

        // Left-pad the fraction to 18 digits, then trim trailing zeros.
        bytes memory digits = bytes(Strings.toString(frac));
        bytes memory padded = new bytes(18);
        uint256 lead = 18 - digits.length;
        for (uint256 i = 0; i < 18; ++i) {
            padded[i] = i < lead ? bytes1("0") : digits[i - lead];
        }
        uint256 end = 18;
        while (end > 0 && padded[end - 1] == "0") --end;
        bytes memory trimmed = new bytes(end);
        for (uint256 i = 0; i < end; ++i) trimmed[i] = padded[i];

        return string.concat(Strings.toString(whole), ".", string(trimmed));
    }

    /// @dev 86400 -> "1 day", 172800 -> "2 days", 3600 -> "1 hour", 90 -> "90 seconds".
    function duration(uint256 secs) internal pure returns (string memory) {
        if (secs != 0 && secs % 1 days == 0) return _unit(secs / 1 days, " day");
        if (secs != 0 && secs % 1 hours == 0) return _unit(secs / 1 hours, " hour");
        if (secs != 0 && secs % 1 minutes == 0) return _unit(secs / 1 minutes, " minute");
        return _unit(secs, " second");
    }

    function _unit(uint256 n, string memory name) private pure returns (string memory) {
        return string.concat(Strings.toString(n), name, n == 1 ? "" : "s");
    }
}
