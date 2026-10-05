// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./CircleswapPair.sol";
import "./interfaces/ICircleswapFactory.sol";

/**
 * @title CircleswapFactory
 * @author Circleswap DeFi Protocol
 * @notice Creates and indexes Circleswap pools, one per token pair, and holds the protocol-fee switch.
 *         Upgraded to OpenZeppelin v5 UUPS upgradeable contract pattern with UpgradeableBeacon for pools.
 *
 * @dev Anyone can create a pool; nothing else here is permissionless. The owner is meant to be a
 *      CircleswapTimelock, so every owner action is public and delayed.
 *
 *      What the owner can and cannot do to liquidity:
 *        - Pools are BeaconProxy instances. The beacon is owned by THIS contract, not by any person, so the pool
 *          implementation can only change through `upgradePairImplementation`, an owner-only call that (behind
 *          the timelock) is announced for at least the delay before it takes effect.
 *        - `freezePairUpgrades()` renounces the beacon's ownership. That cannot be undone by anyone, including a
 *          later upgrade of this factory: from then on the code of every EXISTING pool is fixed forever and the
 *          owner has no power over reserves or LP tokens. A pool's frozen state is checked on chain with
 *          `pairUpgradesFrozen()` (or, for a single pool, by reading its beacon's owner: address(0)).
 *        - New pool versions are opt-in: `setPairBeacon` only affects pools created afterwards; existing pools stay
 *          on the beacon they were created with, and nobody is moved into a new version without choosing to add
 *          liquidity to a new pool.
 *      The factory itself is UUPS upgradeable by the owner (it holds no funds, only the pool registry and the fee
 *      switch). Renouncing ownership makes it permanent.
 *      Pool addresses are ground on Quai: always look a pool up with `getPair`, never compute it.
 */
contract CircleswapFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ICircleswapFactory {
    /// @inheritdoc ICircleswapFactory
    address public override pairBeacon;

    /// @inheritdoc ICircleswapFactory
    address public override feeTo;

    /// @inheritdoc ICircleswapFactory
    mapping(address => mapping(address => address)) public override getPair;

    /// @inheritdoc ICircleswapFactory
    address[] public override allPairs;

    uint256[50] private __gap;

    event PairImplementationUpgraded(address indexed beacon, address indexed implementation);
    event PairUpgradesFrozen(address indexed beacon, address indexed implementation);

    error InvalidImplementation();
    error InvalidBeacon();
    error PairUpgradesAlreadyFrozen();
    error BeaconNotOwnedByFactory();
    error IdenticalAddresses();
    error ZeroAddress();
    error InvalidToken();
    error PairExists();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function __UUPSUpgradeable_init() internal onlyInitializing {}

    /**
     * @notice Initializes the factory as a UUPS upgradeable contract.
     * @param initialOwner Address of the protocol owner with two-step ownership.
     */
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        CircleswapPair pairImpl = new CircleswapPair();
        // The factory, not a person, owns the beacon: the only path to change pool code is the owner-gated
        // `upgradePairImplementation` below, and `freezePairUpgrades` can close it for good.
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(pairImpl), address(this));
        pairBeacon = address(beacon);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @inheritdoc ICircleswapFactory
    function pairImplementation() external view override returns (address) {
        if (pairBeacon == address(0)) return address(0);
        return IBeacon(pairBeacon).implementation();
    }

    /// @inheritdoc ICircleswapFactory
    function allPairsLength() external view override returns (uint256) {
        return allPairs.length;
    }

    /// @inheritdoc ICircleswapFactory
    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        // A pool over a non-contract can never trade; refuse it rather than index a dead pool.
        if (token0.code.length == 0 || token1.code.length == 0) revert InvalidToken();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        pair = address(new BeaconProxy(pairBeacon, ""));

        // Record the pool before calling into it (checks-effects-interactions), so nothing reached through
        // `initialize` can ever observe a factory that does not yet know the pool.
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
        ICircleswapPair(pair).initialize(token0, token1);
    }

    /// @notice Sets where the protocol's share of fees is minted (as LP tokens). address(0) turns it off.
    function setFeeTo(address newFeeTo) external onlyOwner {
        emit FeeToUpdated(feeTo, newFeeTo);
        // slither-disable-next-line missing-zero-check -- address(0) is how the protocol fee is switched off
        feeTo = newFeeTo;
    }

    // ------------------------------------------------------------------------------------- pool versions

    /// @notice True once the current pool beacon has no owner: the code of every pool made from it can never change.
    function pairUpgradesFrozen() public view returns (bool) {
        return Ownable(pairBeacon).owner() == address(0);
    }

    /**
     * @notice Moves every pool made from the current beacon to a new implementation, in one transaction, keeping
     *         every reserve and LP balance. Owner only (the timelock, so announced in advance); impossible once
     *         `freezePairUpgrades` has been called.
     * @dev The new implementation must keep CircleswapPair's storage layout (append-only; checked in CI by the
     *      storage-layout snapshot) and must lock itself with `_disableInitializers`.
     */
    function upgradePairImplementation(address newImplementation) external onlyOwner {
        if (pairUpgradesFrozen()) revert PairUpgradesAlreadyFrozen();
        if (newImplementation.code.length == 0) revert InvalidImplementation();
        // slither-disable-next-line reentrancy-events -- the beacon is this factory's own; the call is owner-only
        UpgradeableBeacon(pairBeacon).upgradeTo(newImplementation);
        emit PairImplementationUpgraded(pairBeacon, newImplementation);
    }

    /**
     * @notice Permanently closes pool upgrades for every pool made from the current beacon by renouncing the
     *         beacon's ownership. Irreversible, and not undoable by upgrading this factory: nobody owns the beacon.
     */
    function freezePairUpgrades() external onlyOwner {
        address beacon = pairBeacon;
        if (Ownable(beacon).owner() == address(0)) revert PairUpgradesAlreadyFrozen();
        if (Ownable(beacon).owner() != address(this)) revert BeaconNotOwnedByFactory();
        // slither-disable-next-line reentrancy-events -- the beacon is this factory's own; the call is owner-only
        Ownable(beacon).renounceOwnership();
        emit PairUpgradesFrozen(beacon, IBeacon(beacon).implementation());
    }

    /**
     * @notice Sets the beacon that pools created FROM NOW ON follow. Pools that already exist keep the beacon they
     *         were created with. Use it to release a new pool version without touching existing liquidity.
     * @dev The beacon must be a contract whose implementation is a contract and whose owner is this factory, so that
     *      `upgradePairImplementation` and `freezePairUpgrades` govern it like the first one.
     */
    function setPairBeacon(address newPairBeacon) external onlyOwner {
        if (newPairBeacon == address(0)) revert ZeroAddress();
        if (newPairBeacon.code.length == 0) revert InvalidBeacon();
        try IBeacon(newPairBeacon).implementation() returns (address impl) {
            if (impl.code.length == 0) revert InvalidBeacon();
        } catch {
            revert InvalidBeacon();
        }
        // Every future pool version stays under the same governance: owned by this factory (so changing it needs the
        // owner, i.e. the timelock) and freezable. A beacon owned by a person would hand that person the code of
        // every pool made from it.
        try Ownable(newPairBeacon).owner() returns (address beaconOwner) {
            if (beaconOwner != address(this)) revert BeaconNotOwnedByFactory();
        } catch {
            revert InvalidBeacon();
        }
        emit PairBeaconUpdated(pairBeacon, newPairBeacon);
        pairBeacon = newPairBeacon;
    }
}
