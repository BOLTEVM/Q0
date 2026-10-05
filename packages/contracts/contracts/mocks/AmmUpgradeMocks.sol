// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../amm/CircleswapFactory.sol";
import "../amm/CircleswapRouter.sol";
import "../amm/CircleswapPair.sol";

/**
 * @notice Mock V2 implementation of CircleswapFactory to verify UUPS upgradeability.
 */
contract CircleswapFactoryV2 is CircleswapFactory {
    function version() external pure returns (string memory) {
        return "FactoryV2";
    }

    function isV2() external pure returns (bool) {
        return true;
    }
}

/**
 * @notice Mock V2 implementation of CircleswapRouter to verify UUPS upgradeability.
 */
contract CircleswapRouterV2 is CircleswapRouter {
    function version() external pure returns (string memory) {
        return "RouterV2";
    }

    function isV2() external pure returns (bool) {
        return true;
    }
}

/**
 * @notice Mock V2 implementation of CircleswapPair to verify UpgradeableBeacon upgradeability.
 */
contract CircleswapPairV2 is CircleswapPair {
    function version() external pure returns (string memory) {
        return "PairV2";
    }

    function poolFeeBps() external pure returns (uint256) {
        return 30;
    }
}
