// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./interfaces/IQrbBoost.sol";
import "./libraries/ArweaveURI.sol";
import "./libraries/QrbFormat.sol";

/**
 * @title Qrb
 * @author Circleswap DeFi Protocol
 * @notice The 1.0-supply Sovereign Genesis token of Circleswap on Quai Network, and the sole source of the
 *         Circleswap farm boost.
 * @dev Fixed supply: exactly 1.0 QRB (1e18 wei), minted once by the owner. It implements IQrbBoost: an
 *      account that has continuously held at least BOOST_THRESHOLD (0.0001 QRB) for BOOST_MATURITY (1 day)
 *      earns BOOST_BPS (+50%) extra farm rewards. Those three constants are the only place the boost is
 *      defined.
 *
 *      Holding time is tracked per account: the clock starts when a balance rises to the threshold and
 *      resets when it falls below it (topping up an account already at the threshold does not restart it).
 *      Without it the boost would be a bare balance check, and a balance can be borrowed for a single
 *      transaction (a flash swap out of any QRB pool, or a lender contract), so anyone could claim it.
 *      With it, one unit of the threshold can boost only one wallet per BOOST_MATURITY, so at most
 *      10,000 wallets can be boosted at once.
 *
 *      Nothing about the metadata is mutable: the artwork URI is validated as an Arweave URI in the
 *      constructor and has no setter, so the link cannot be repointed or rot.
 */
contract Qrb is ERC20, ERC20Permit, ERC20Burnable, Ownable2Step, IQrbBoost {
    /// @notice Total supply ever mintable: exactly 1 QRB.
    uint256 public constant MAX_SUPPLY = 1e18;

    /// @inheritdoc IQrbBoost
    uint256 public constant override BOOST_BPS = 5000;

    /// @inheritdoc IQrbBoost
    uint256 public constant override BOOST_THRESHOLD = 1e14;

    /// @inheritdoc IQrbBoost
    uint256 public constant override BOOST_MATURITY = 1 days;

    /// @notice True once the genesis supply has been minted. Never resets, even if the supply is burned.
    bool public genesisMinted;

    string private _artworkURI;

    /// @dev Timestamp at which the account's balance last rose to BOOST_THRESHOLD; 0 while it is below it.
    mapping(address => uint256) private _atThresholdSince;

    event QrbGenesisForged(address indexed recipient, uint256 amount, string artworkURI);

    error MaxSupplyReached();
    error InvalidRecipient();
    error InvalidArtworkURI();

    /**
     * @param initialOwner Administrator, and the only account that can mint the genesis supply.
     * @param artworkURI_ Arweave URI of the artwork (`ar://<txid>` or `https://arweave.net/<txid>`).
     */
    constructor(address initialOwner, string memory artworkURI_)
        ERC20("Circleswap Qrb", "QRB")
        ERC20Permit("Circleswap Qrb")
        Ownable(initialOwner)
    {
        if (!ArweaveURI.isValid(artworkURI_)) revert InvalidArtworkURI();
        _artworkURI = artworkURI_;
    }

    /**
     * @notice Mints the entire 1.0 QRB supply to `recipient`. Callable once, ever.
     */
    function mintGenesis(address recipient) external onlyOwner {
        if (genesisMinted) revert MaxSupplyReached();
        if (recipient == address(0)) revert InvalidRecipient();

        genesisMinted = true;
        _mint(recipient, MAX_SUPPLY);

        emit QrbGenesisForged(recipient, MAX_SUPPLY, _artworkURI);
    }

    /// @notice Arweave URI of the artwork this token was deployed with.
    function artworkURI() public view returns (string memory) {
        return _artworkURI;
    }

    /// @inheritdoc IQrbBoost
    function boostBpsOf(address account) external view override returns (uint256) {
        uint256 since = _atThresholdSince[account];
        bool matured = since != 0 && block.timestamp >= since + BOOST_MATURITY;
        return matured && balanceOf(account) >= BOOST_THRESHOLD ? BOOST_BPS : 0;
    }

    /// @notice When `account` becomes (or became) boost-eligible: the moment its balance reached the threshold
    ///         plus BOOST_MATURITY, or 0 if it is below the threshold now.
    function boostEligibleAt(address account) external view returns (uint256) {
        uint256 since = _atThresholdSince[account];
        // slither-disable-next-line incorrect-equality -- 0 is the "below threshold" sentinel, never a balance comparison
        return since == 0 ? 0 : since + BOOST_MATURITY;
    }

    /// @dev Keeps the holding clock in step with every balance change (mint, burn and transfer).
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0)) _track(from);
        if (to != address(0)) _track(to);
    }

    function _track(address account) private {
        if (balanceOf(account) >= BOOST_THRESHOLD) {
            if (_atThresholdSince[account] == 0) _atThresholdSince[account] = block.timestamp;
        } else if (_atThresholdSince[account] != 0) {
            _atThresholdSince[account] = 0;
        }
    }

    /// @notice Contract-level metadata (marketplace / explorer), generated from the constants above.
    function contractURI() external view returns (string memory) {
        string memory json = Base64.encode(
            bytes(
                string.concat(
                    '{"name":"Circleswap Qrb","symbol":"QRB",',
                    '"description":"The 1.0-supply Sovereign Genesis token of Circleswap on Quai Network (Cyprus-1). ',
                    "Holding at least ",
                    QrbFormat.amount18(BOOST_THRESHOLD),
                    " QRB for ",
                    QrbFormat.duration(BOOST_MATURITY),
                    " earns +",
                    QrbFormat.pct(BOOST_BPS),
                    ' extra farm rewards.",',
                    '"image":"',
                    _artworkURI,
                    '","properties":{"max_supply":1,"decimals":18,"shard":"Cyprus-1",',
                    '"boost_bps":',
                    Strings.toString(BOOST_BPS),
                    ',"boost_threshold":"',
                    QrbFormat.amount18(BOOST_THRESHOLD),
                    '","boost_maturity_seconds":',
                    Strings.toString(BOOST_MATURITY),
                    "}}"
                )
            )
        );
        return string.concat("data:application/json;base64,", json);
    }
}
