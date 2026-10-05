// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./interfaces/IQrbBoost.sol";
import "./libraries/ArweaveURI.sol";
import "./libraries/QrbFormat.sol";

/**
 * @title QrbArtifactNFT
 * @author Circleswap DeFi Protocol
 * @notice The 1-of-1 Genesis artifact NFT of Circleswap. A collectible: it grants no farm boost.
 * @dev The boost belongs to the Qrb ERC-20. This contract only *reports* it in its metadata, read live
 *      from the Qrb contract's constants so the figure cannot drift from what the farm pays.
 *      Metadata is fully on-chain and immutable; the image is an Arweave URI validated at construction.
 */
contract QrbArtifactNFT is ERC721, ERC2981, Ownable2Step, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 1;
    uint256 public constant TOKEN_ID = 1;
    /// @notice Secondary-sale royalty, in basis points (5%).
    uint96 public constant ROYALTY_BPS = 500;

    /// @notice The Qrb ERC-20 whose boost figures the metadata reports.
    IQrbBoost public immutable qrb;

    /// @notice True once the artifact has been minted.
    bool public minted;

    string private _artworkURI;

    event ArtifactForged(address indexed recipient, uint256 indexed tokenId);

    error MaxSupplyReached();
    error InvalidArtworkURI();
    error InvalidQrb();

    /**
     * @param initialOwner Administrator, and the only account that can mint.
     * @param royaltyReceiver Receives the 5% ERC-2981 royalty. Fixed for the life of the contract.
     * @param artworkURI_ Arweave URI of the artwork.
     * @param qrb_ The deployed Qrb ERC-20. It must be a contract that answers the boost interface: the
     *        metadata reads it forever, so a wrong address would permanently break `tokenURI`.
     */
    constructor(address initialOwner, address royaltyReceiver, string memory artworkURI_, IQrbBoost qrb_)
        ERC721("Circleswap Qrb Artifact", "QRB-NFT")
        Ownable(initialOwner)
    {
        if (!ArweaveURI.isValid(artworkURI_)) revert InvalidArtworkURI();
        if (address(qrb_).code.length == 0) revert InvalidQrb();
        // Everything tokenURI will read must work now, not at the first marketplace fetch.
        // slither-disable-next-line unused-return -- a probe that the source answers the interface
        try qrb_.BOOST_BPS() returns (uint256) {} catch { revert InvalidQrb(); }
        // slither-disable-next-line unused-return -- see BOOST_BPS
        try qrb_.BOOST_THRESHOLD() returns (uint256) {} catch { revert InvalidQrb(); }
        // slither-disable-next-line unused-return -- see BOOST_BPS
        try qrb_.BOOST_MATURITY() returns (uint256) {} catch { revert InvalidQrb(); }
        _artworkURI = artworkURI_;
        qrb = qrb_;
        _setDefaultRoyalty(royaltyReceiver, ROYALTY_BPS);
    }

    /// @notice Mints the one and only artifact to `recipient`. Callable once, ever.
    function mintArtifact(address recipient) external onlyOwner nonReentrant {
        if (minted) revert MaxSupplyReached();
        minted = true;
        _safeMint(recipient, TOKEN_ID);
        emit ArtifactForged(recipient, TOKEN_ID);
    }

    /// @notice Arweave URI of the artwork this token was deployed with.
    function artworkURI() external view returns (string memory) {
        return _artworkURI;
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory json = Base64.encode(
            bytes(
                string.concat(
                    '{"name":"Circleswap Qrb #1 - Genesis Singularity",',
                    '"description":"The 1-of-1 Genesis artifact of Circleswap on Quai Network. ',
                    "It grants no boost itself: the farm boost comes from holding the Qrb ERC-20.",
                    '","image":"',
                    _artworkURI,
                    '","attributes":[',
                    '{"trait_type":"Edition","value":"1 of 1 Genesis"},',
                    '{"trait_type":"Protocol","value":"Circleswap"},',
                    '{"trait_type":"Shard","value":"Cyprus-1"},',
                    '{"trait_type":"Companion Token","value":"',
                    Strings.toHexString(address(qrb)),
                    '"},{"trait_type":"Qrb Farm Boost","value":"+',
                    QrbFormat.pct(qrb.BOOST_BPS()),
                    " for holders of at least ",
                    QrbFormat.amount18(qrb.BOOST_THRESHOLD()),
                    " QRB held for ",
                    QrbFormat.duration(qrb.BOOST_MATURITY()),
                    '"}]}'
                )
            )
        );
        return string.concat("data:application/json;base64,", json);
    }

    /// @inheritdoc ERC721
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
