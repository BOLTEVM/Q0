// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../amm/CircleswapFactory.sol";
import "../amm/CircleswapRouter.sol";
import "../amm/governance/CircleswapTimelock.sol";

/// @dev Pre-flight probe for the live Quai node. It is only ever run through quai_call / quai_estimateGas (which
///      execute a creation without committing anything), never deployed. Its constructor performs the whole governed
///      deployment (the timelock, the factory and the router, each implementation plus proxy initialised in the same
///      step) and then creates pools, so a simulation shows whether Quai accepts every nested creation and where each
///      contract lands.
///
///      mode 0: deploy the timelock, factory and router and stop.
///      mode 1: as 0, then create one pool.
///      mode 2: as 1, but create two pools and revert with all the addresses, so they can be read back.
///      modes 10..14: calibration, one deployment step each (10 timelock, 11 factory implementation, 12 factory
///      implementation + proxy, 13 router implementation, 14 factory + router, both with proxies).
contract AmmProbe {
    /// timelock, factory implementation, factory proxy, pool beacon, pool implementation, router implementation,
    /// router proxy, pool one, pool two
    error Probe(address[9] addresses);

    constructor(uint256 mode, address tokenA, address tokenB, address tokenC, address wquai) {
        address[9] memory out;

        address[] memory proposers = new address[](1);
        proposers[0] = msg.sender;
        address[] memory executors = new address[](1); // address(0): anyone may run a ready operation

        // Calibration modes: one real deployment step each, so a simulation prices that step alone.
        if (mode >= 10) {
            if (mode == 10) new CircleswapTimelock(1 days, proposers, executors, new address[](0));
            else if (mode == 11) new CircleswapFactory();
            else if (mode == 12) {
                address impl = address(new CircleswapFactory());
                new ERC1967Proxy(impl, abi.encodeCall(CircleswapFactory.initialize, (msg.sender)));
            } else if (mode == 13) new CircleswapRouter();
            else if (mode == 14) {
                address f = address(new ERC1967Proxy(address(new CircleswapFactory()), abi.encodeCall(CircleswapFactory.initialize, (msg.sender))));
                address r = address(new CircleswapRouter());
                new ERC1967Proxy(r, abi.encodeCall(CircleswapRouter.initialize, (f, wquai, msg.sender)));
            }
            return;
        }

        out[0] = address(new CircleswapTimelock(1 days, proposers, executors, new address[](0)));

        out[1] = address(new CircleswapFactory());
        out[2] = address(new ERC1967Proxy(out[1], abi.encodeCall(CircleswapFactory.initialize, (out[0]))));
        CircleswapFactory factory = CircleswapFactory(out[2]);
        out[3] = factory.pairBeacon();
        out[4] = factory.pairImplementation();

        out[5] = address(new CircleswapRouter());
        out[6] = address(new ERC1967Proxy(out[5], abi.encodeCall(CircleswapRouter.initialize, (out[2], wquai, out[0]))));
        if (mode == 0) return;

        out[7] = factory.createPair(tokenA, tokenB);
        if (mode == 1) return;

        out[8] = factory.createPair(tokenA, tokenC);
        revert Probe(out);
    }
}
