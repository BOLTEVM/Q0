// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../amm/interfaces/ICircleswapCallee.sol";
import "../amm/interfaces/ICircleswapPair.sol";
import "../amm/CircleswapRouter.sol";

/// @dev Test-only wrapped native token, WETH9-style: deposit native to mint 1:1, withdraw to burn and get it back.
contract MockWQUAI is ERC20 {
    constructor() ERC20("Wrapped Quai", "WQUAI") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @dev Test-only token with a settable decimals value and free minting.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test-only token that keeps 1% of every transfer: an unsupported "fee-on-transfer" token, to prove the
///      pool refuses to let it break the accounting.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("FeeToken", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Test-only token that reports success (returns true) without moving anything once "broken": exercises the
///      pool's handling of a token that misbehaves at the worst moment.
contract RevertingToken is ERC20 {
    bool public broken;

    constructor() ERC20("Broken", "BRK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function breakIt() external {
        broken = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!broken || from == address(0), "token frozen");
        super._update(from, to, value);
    }
}

/// @dev Test-only flash-swap receiver. Modes: repay properly, repay too little, or do not repay at all.
contract FlashCallee is ICircleswapCallee {
    enum Mode {
        REPAY_WITH_FEE,
        REPAY_TOO_LITTLE,
        NO_REPAY,
        REENTER_SWAP,
        REENTER_MINT,
        REENTER_BURN,
        REENTER_SYNC,
        REENTER_SKIM
    }

    Mode public mode;
    address public pair;
    address public lastSender;
    uint256 public lastAmount0;
    uint256 public lastAmount1;
    bool public reentryFailed;

    function run(address pair_, uint256 amount0Out, uint256 amount1Out, Mode mode_) external {
        pair = pair_;
        mode = mode_;
        ICircleswapPair(pair_).swap(amount0Out, amount1Out, address(this), hex"01");
    }

    function circleswapCall(address sender, uint256 amount0, uint256 amount1, bytes calldata) external override {
        require(msg.sender == pair, "not the pair");
        lastSender = sender;
        lastAmount0 = amount0;
        lastAmount1 = amount1;

        address t0 = ICircleswapPair(pair).token0();
        address t1 = ICircleswapPair(pair).token1();

        // Each re-entry attempt must be refused by the pool; the callee then repays properly, so the outer flash
        // swap can still succeed and the recorded outcome survives.
        if (mode == Mode.REENTER_SWAP) {
            (bool ok, ) = pair.call(abi.encodeCall(ICircleswapPair.swap, (1, 0, address(this), "")));
            reentryFailed = !ok;
        } else if (mode == Mode.REENTER_MINT) {
            (bool ok, ) = pair.call(abi.encodeCall(ICircleswapPair.mint, (address(this))));
            reentryFailed = !ok;
        } else if (mode == Mode.REENTER_BURN) {
            (bool ok, ) = pair.call(abi.encodeCall(ICircleswapPair.burn, (address(this))));
            reentryFailed = !ok;
        } else if (mode == Mode.REENTER_SYNC) {
            (bool ok, ) = pair.call(abi.encodeCall(ICircleswapPair.sync, ()));
            reentryFailed = !ok;
        } else if (mode == Mode.REENTER_SKIM) {
            (bool ok, ) = pair.call(abi.encodeCall(ICircleswapPair.skim, (address(this))));
            reentryFailed = !ok;
        }

        if (mode == Mode.REPAY_TOO_LITTLE) {
            if (amount0 > 0) IERC20(t0).transfer(pair, amount0);
            if (amount1 > 0) IERC20(t1).transfer(pair, amount1);
        } else if (mode != Mode.NO_REPAY) {
            // Repay principal + the 0.3% fee (rounded up) in the token that was borrowed.
            if (amount0 > 0) IERC20(t0).transfer(pair, amount0 + (amount0 * 3) / 997 + 1);
            if (amount1 > 0) IERC20(t1).transfer(pair, amount1 + (amount1 * 3) / 997 + 1);
        }
        // NO_REPAY: return without paying anything.
    }
}

/// @dev Test-only native-QUAI recipient that rejects every payment, to prove the router reports a failed refund.
contract RejectsNative {
    function noop() external {}
}

/// @dev Test-only native-QUAI recipient that tries to re-enter the router when it receives a payout, and records
///      exactly why the router refused.
contract ReentrantNativeReceiver {
    CircleswapRouter public router;
    address public token;
    bool public attempted;
    bool public reentrySucceeded;
    bytes4 public lastRevert;

    constructor(CircleswapRouter router_, address token_) {
        router = router_;
        token = token_;
    }

    function withdrawTo(uint256 liquidity) external {
        address pair = ICircleswapFactoryLike(router.factory()).getPair(token, router.WETH());
        IERC20(pair).approve(address(router), liquidity);
        router.removeLiquidityETH(token, liquidity, 0, 0, address(this), block.timestamp + 100);
    }

    receive() external payable {
        attempted = true;
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = token;
        (bool ok, bytes memory ret) = address(router).call{value: msg.value}(
            abi.encodeWithSelector(router.swapExactETHForTokens.selector, 0, path, address(this), block.timestamp + 100)
        );
        if (ok) {
            reentrySucceeded = true;
        } else if (ret.length >= 4) {
            lastRevert = bytes4(ret);
        }
    }
}

interface ICircleswapFactoryLike {
    function getPair(address a, address b) external view returns (address);
}
