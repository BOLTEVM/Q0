// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../amm/CircleswapFactory.sol";

/// @dev Pre-flight probe for the live Quai node. It is only ever run through quai_call / quai_estimateGas (which
///      execute a creation without committing anything), never deployed. Its constructor performs the exact
///      nested creations the real factory performs, so a simulation shows whether Quai accepts them and where
///      the contracts land.
///
///      mode 0: deploy a factory (which deploys the pair implementation) and stop.
///      mode 1: as 0, then create one pool.
///      mode 2: as 1, but create two pools and revert with all the addresses, so they can be read back.
contract AmmProbe {
    error Probe(address factory, address implementation, address pairOne, address pairTwo);

    constructor(uint256 mode, address tokenA, address tokenB, address tokenC) {
        CircleswapFactory factoryImpl = new CircleswapFactory();
        ERC1967Proxy proxy = new ERC1967Proxy(address(factoryImpl), abi.encodeCall(CircleswapFactory.initialize, (msg.sender)));
        CircleswapFactory factory = CircleswapFactory(address(proxy));
        if (mode == 0) return;
        address one = factory.createPair(tokenA, tokenB);
        if (mode == 1) return;
        address two = factory.createPair(tokenA, tokenC);
        revert Probe(address(factory), factory.pairImplementation(), one, two);
    }
}
