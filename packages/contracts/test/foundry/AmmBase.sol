// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../../contracts/amm/CircleswapFactory.sol";
import "../../contracts/amm/CircleswapPair.sol";
import "../../contracts/amm/CircleswapRouter.sol";
import "../../contracts/mocks/AmmMocks.sol";

/// @dev Deploys the real factory and router (compiled from contracts/, same settings as Hardhat) with three
///      18-decimal tokens and a WQUAI mock, plus helpers the fuzz and invariant suites share.
abstract contract AmmBase is Test {
    CircleswapFactory internal factory;
    CircleswapRouter internal router;
    MockWQUAI internal wquai;
    MockToken internal tA;
    MockToken internal tB;
    MockToken internal tC;

    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public virtual {
        CircleswapFactory factoryImpl = new CircleswapFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeCall(CircleswapFactory.initialize, (address(this)))
        );
        factory = CircleswapFactory(address(factoryProxy));

        wquai = new MockWQUAI();

        CircleswapRouter routerImpl = new CircleswapRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeCall(CircleswapRouter.initialize, (address(factory), address(wquai), address(this)))
        );
        router = CircleswapRouter(payable(address(routerProxy)));

        tA = new MockToken("A", "A", 18);
        tB = new MockToken("B", "B", 18);
        tC = new MockToken("C", "C", 18);
    }

    function _approveRouter(MockToken t, address who) internal {
        vm.prank(who);
        t.approve(address(router), type(uint256).max);
    }

    /// @dev Adds liquidity as `lp` through the router (creating the pool if needed).
    function _seed(MockToken x, MockToken y, uint256 ax, uint256 ay) internal returns (CircleswapPair pair) {
        x.mint(lp, ax);
        y.mint(lp, ay);
        _approveRouter(x, lp);
        _approveRouter(y, lp);
        vm.prank(lp);
        router.addLiquidity(address(x), address(y), ax, ay, 0, 0, lp, block.timestamp);
        pair = CircleswapPair(factory.getPair(address(x), address(y)));
    }

    function _reserves(MockToken x, MockToken y) internal view returns (uint256 rx, uint256 ry) {
        CircleswapPair pair = CircleswapPair(factory.getPair(address(x), address(y)));
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        (rx, ry) = address(x) < address(y) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _k(CircleswapPair pair) internal view returns (uint256) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        return uint256(r0) * uint256(r1);
    }

    function _path2(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _path3(address a, address b, address c) internal pure returns (address[] memory p) {
        p = new address[](3);
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }
}
