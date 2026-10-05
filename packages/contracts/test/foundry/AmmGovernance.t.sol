// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AmmBase.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "../../contracts/mocks/AmmGovernanceMocks.sol";
import "../../contracts/mocks/AmmUpgradeMocks.sol";

bytes32 constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

/// @dev A hostile owner: every move the factory owner (the timelock, once its delay has passed) could make, in any
///      order, against pools whose upgrades were frozen. None may change what an existing pool is or what an LP can do.
contract OwnerHandler is Test {
    CircleswapFactory public immutable factory;
    address public immutable rugImpl;
    uint256 public calls;

    /// @dev The handler IS the factory owner (ownership is handed to it in setUp), so its calls are owner calls.
    constructor(CircleswapFactory f, address rug) {
        factory = f;
        rugImpl = rug;
    }

    function upgradeFactoryToHostile() external {
        EvilFactory evil = new EvilFactory();
        try factory.upgradeToAndCall(address(evil), "") {} catch {}
        ++calls;
    }

    function upgradeFactoryBack() external {
        CircleswapFactoryV2 v2 = new CircleswapFactoryV2();
        try factory.upgradeToAndCall(address(v2), "") {} catch {}
        ++calls;
    }

    function hostileFactoryMode(uint8 mode, address fee) external {
        // Only meaningful while the hostile implementation is installed; harmless otherwise.
        try EvilFactory(address(factory)).setMode(EvilFactory.Mode(mode % 6), fee) {} catch {}
        ++calls;
    }

    function hostileFactoryAttack() external {
        try EvilFactory(address(factory)).attack(rugImpl) {} catch {}
        ++calls;
    }

    function setFeeTo(address a) external {
        try factory.setFeeTo(a) {} catch {}
        ++calls;
    }

    function tryUpgradePairs() external {
        try factory.upgradePairImplementation(rugImpl) {} catch {}
        ++calls;
    }

    function tryFreezeAgain() external {
        try factory.freezePairUpgrades() {} catch {}
        ++calls;
    }

    function pointNewPoolsElsewhere() external {
        UpgradeableBeacon b = new UpgradeableBeacon(rugImpl, address(factory));
        try factory.setPairBeacon(address(b)) {} catch {}
        ++calls;
    }
}

contract AmmGovernanceInvariantTest is AmmBase {
    CircleswapPair internal pool;
    UpgradeableBeacon internal beacon;
    OwnerHandler internal handler;
    address internal frozenImpl;
    bytes32 internal frozenCodehash;
    address internal frozenBeacon;

    function setUp() public override {
        super.setUp();
        pool = _seed(tA, tB, 1000e18, 1000e18);
        frozenBeacon = factory.pairBeacon();
        beacon = UpgradeableBeacon(frozenBeacon);
        factory.freezePairUpgrades(); // this test contract is the owner (stand-in for the timelock)
        frozenImpl = beacon.implementation();
        frozenCodehash = frozenImpl.codehash;

        CircleswapPairRug rug = new CircleswapPairRug();
        handler = new OwnerHandler(factory, address(rug));
        // The handler needs to act as owner: hand ownership over (two-step).
        factory.transferOwnership(address(handler));
        vm.prank(address(handler));
        factory.acceptOwnership();
        targetContract(address(handler));
    }

    function _beaconOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, BEACON_SLOT))));
    }

    /// The beacon the pool follows has no owner, so nobody can ever change it.
    function invariant_frozenBeaconHasNoOwner() public view {
        assertEq(beacon.owner(), address(0), "the frozen beacon acquired an owner");
    }

    /// The code every existing pool runs is exactly what it was when frozen.
    function invariant_poolCodeNeverChanges() public view {
        assertEq(_beaconOf(address(pool)), frozenBeacon, "the pool was repointed");
        assertEq(beacon.implementation(), frozenImpl, "the pool implementation changed");
        assertEq(beacon.implementation().codehash, frozenCodehash, "the pool implementation code changed");
    }

    /// Whatever the owner does to the factory, the pool's reserves never fall below what its LP tokens are owed.
    function invariant_poolStaysSolvent() public view {
        (uint112 r0, uint112 r1, ) = pool.getReserves();
        assertGe(MockToken(pool.token0()).balanceOf(address(pool)), r0);
        assertGe(MockToken(pool.token1()).balanceOf(address(pool)), r1);
        assertEq(r0, 1000e18);
        assertEq(r1, 1000e18);
    }

    /// At the end of any campaign the liquidity provider can still walk out with her whole share.
    function afterInvariant() public {
        uint256 lpBal = pool.balanceOf(lp);
        uint256 supply = pool.totalSupply();
        (uint112 r0, uint112 r1, ) = pool.getReserves();
        uint256 before0 = MockToken(pool.token0()).balanceOf(lp);
        uint256 before1 = MockToken(pool.token1()).balanceOf(lp);
        vm.startPrank(lp);
        pool.transfer(address(pool), lpBal);
        pool.burn(lp);
        vm.stopPrank();
        assertEq(MockToken(pool.token0()).balanceOf(lp) - before0, (lpBal * uint256(r0)) / supply, "LP did not get her share of token0");
        assertEq(MockToken(pool.token1()).balanceOf(lp) - before1, (lpBal * uint256(r1)) / supply, "LP did not get her share of token1");
    }
}
