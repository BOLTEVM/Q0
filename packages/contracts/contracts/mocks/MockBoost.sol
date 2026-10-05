// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IQrbBoost.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @dev Test-only boost source with a settable per-account boost, to exercise the farm against the
///      interface rather than the Qrb implementation.
contract MockBoost is IQrbBoost {
    uint256 public constant override BOOST_BPS = 0;
    uint256 public constant override BOOST_THRESHOLD = 0;
    uint256 public constant override BOOST_MATURITY = 0;
    mapping(address => uint256) public bpsOf;

    function set(address account, uint256 bps) external {
        bpsOf[account] = bps;
    }

    function boostBpsOf(address account) external view override returns (uint256) {
        return bpsOf[account];
    }
}

/// @dev Test-only boost source whose every call reverts, to prove a broken source cannot brick harvests.
contract RevertingBoost is IQrbBoost {
    uint256 public constant override BOOST_BPS = 0;
    uint256 public constant override BOOST_THRESHOLD = 0;
    uint256 public constant override BOOST_MATURITY = 0;

    function boostBpsOf(address) external pure override returns (uint256) {
        revert("boost source down");
    }
}

/// @dev Test-only ERC-721 receiver that accepts tokens.
contract GoodReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Test-only contract with no onERC721Received, so a safe mint to it must revert.
contract BadReceiver {}

/// @dev Test-only ERC-721 receiver that tries to mint again from inside the callback.
contract ReenteringReceiver is IERC721Receiver {
    address public nft;
    bool public reentryReverted;

    function setNft(address nft_) external {
        nft = nft_;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        (bool ok, ) = nft.call(abi.encodeWithSignature("mintArtifact(address)", address(this)));
        reentryReverted = !ok;
        return IERC721Receiver.onERC721Received.selector;
    }
}
