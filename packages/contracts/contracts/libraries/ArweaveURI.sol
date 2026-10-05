// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArweaveURI
 * @notice On-chain check that an artwork URI points at Arweave, so a contract cannot be deployed with a
 *         mutable or dead link (a GitHub raw URL, an IPFS gateway, a typo).
 * @dev Accepts exactly `ar://<txid>` or `https://arweave.net/<txid>`, where <txid> is a 43-character
 *      base64url string (the encoding of a 32-byte Arweave transaction id). That charset also makes the
 *      URI safe to embed in the JSON the contracts build, with no escaping.
 */
library ArweaveURI {
    uint256 internal constant TXID_LENGTH = 43;

    function isValid(string memory uri) internal pure returns (bool) {
        bytes memory b = bytes(uri);
        uint256 prefix;
        if (_startsWith(b, "ar://")) {
            prefix = 5;
        } else if (_startsWith(b, "https://arweave.net/")) {
            prefix = 20;
        } else {
            return false;
        }
        if (b.length != prefix + TXID_LENGTH) return false;

        for (uint256 i = prefix; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || // 0-9
                (c >= 0x41 && c <= 0x5a) || // A-Z
                (c >= 0x61 && c <= 0x7a) || // a-z
                c == 0x2d || // -
                c == 0x5f; //   _
            if (!ok) return false;
        }
        return true;
    }

    function _startsWith(bytes memory b, bytes memory p) private pure returns (bool) {
        if (b.length < p.length) return false;
        for (uint256 i = 0; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }
}
