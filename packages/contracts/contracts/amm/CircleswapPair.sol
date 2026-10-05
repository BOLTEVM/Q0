// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/ICircleswapPair.sol";
import "./interfaces/ICircleswapFactory.sol";
import "./interfaces/ICircleswapCallee.sol";
import "./libraries/ReentrancyGuardUpgradeable.sol";

/**
 * @title CircleswapPair
 * @author Circleswap DeFi Protocol
 * @notice A constant-product (x * y = k) pool for two ERC-20 tokens. The pool is its own LP token ("Circleswap
 *         LP", CSLP): liquidity providers hold a share of the pool, redeemable for their part of both reserves.
 *
 * @dev Every pool is a BeaconProxy pointing to an UpgradeableBeacon deployed by the factory.
 *      The implementation logic can be upgraded atomically across all pools in a single transaction
 *      by the beacon owner without migrating liquidity or shifting storage layout.
 *
 *      How it stays solvent:
 *        - swap(): tokens are paid out first, then the pool requires (balance*1000 - amountIn*3) products to be
 *          at least reserve0*reserve1*1000^2, i.e. k never falls once the 0.3% fee is netted out. This is what
 *          makes flash swaps safe: repay inside the callback or the whole call reverts.
 *        - mint()/burn()/swap()/skim()/sync() are non-reentrant, so a token or callee cannot re-enter a pool
 *          mid-update.
 *        - The first deposit locks MINIMUM_LIQUIDITY shares to a dead address, so share price cannot be
 *          manipulated by a tiny first deposit.
 *        - Reserves are stored as uint112; a balance above that reverts instead of wrapping.
 */
contract CircleswapPair is Initializable, ERC20Upgradeable, ERC20PermitUpgradeable, ReentrancyGuardUpgradeable, ICircleswapPair {
    using SafeERC20 for IERC20;

    /// @inheritdoc ICircleswapPair
    uint256 public constant override MINIMUM_LIQUIDITY = 1000;

    /// @dev Where the locked first-deposit shares live. No key controls this address.
    address private constant DEAD = address(0xdEaD);

    address public override factory;
    address public override token0;
    address public override token1;

    // Packed into one storage slot.
    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    /// @inheritdoc ICircleswapPair
    uint256 public override price0CumulativeLast;
    /// @inheritdoc ICircleswapPair
    uint256 public override price1CumulativeLast;
    /// @inheritdoc ICircleswapPair
    uint256 public override kLast;

    uint256[50] private __gap;

    error AlreadyInitialized();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error InvariantViolated();
    error BalanceOverflow();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
        factory = address(1);
    }

    /// @notice Constant token name.
    function name() public pure override(ERC20Upgradeable) returns (string memory) {
        return "Circleswap LP";
    }

    /// @notice Constant token symbol.
    function symbol() public pure override(ERC20Upgradeable) returns (string memory) {
        return "CSLP";
    }

    /// @inheritdoc ICircleswapPair
    function initialize(address token0_, address token1_) external override initializer {
        __ERC20_init("Circleswap LP", "CSLP");
        __ERC20Permit_init("Circleswap LP");
        __ReentrancyGuard_init();

        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
        // slither-disable-next-line missing-zero-check -- only the factory calls this, with tokens it has already checked
        token0 = token0_;
        // slither-disable-next-line missing-zero-check -- see token0
        token1 = token1_;
    }

    /// @inheritdoc ICircleswapPair
    function getReserves() public view override returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    // -------------------------------------------------------------------------------------------------- liquidity

    /// @inheritdoc ICircleswapPair
    function mint(address to) external override nonReentrant returns (uint256 liquidity) {
        (uint112 reserve0, uint112 reserve1, ) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - reserve0;
        uint256 amount1 = balance1 - reserve1;

        bool feeOn = _mintProtocolFee(reserve0, reserve1);
        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality -- "no shares exist yet" is the first-deposit case, not a balance comparison
        if (supply == 0) {
            uint256 initial = Math.sqrt(amount0 * amount1);
            if (initial <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = initial - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * supply) / reserve0, (amount1 * supply) / reserve1);
        }
        // slither-disable-next-line incorrect-equality -- rounding to zero shares is the case being refused
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, reserve0, reserve1);
        if (feeOn) kLast = uint256(_reserve0) * _reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @inheritdoc ICircleswapPair
    function burn(address to) external override nonReentrant returns (uint256 amount0, uint256 amount1) {
        (uint112 reserve0, uint112 reserve1, ) = getReserves();
        address t0 = token0;
        address t1 = token1;
        uint256 balance0 = IERC20(t0).balanceOf(address(this));
        uint256 balance1 = IERC20(t1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintProtocolFee(reserve0, reserve1);
        uint256 supply = totalSupply();
        amount0 = (liquidity * balance0) / supply;
        amount1 = (liquidity * balance1) / supply;
        // slither-disable-next-line incorrect-equality -- a burn that rounds to zero is refused
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        IERC20(t0).safeTransfer(to, amount0);
        IERC20(t1).safeTransfer(to, amount1);
        balance0 = IERC20(t0).balanceOf(address(this));
        balance1 = IERC20(t1).balanceOf(address(this));

        _update(balance0, balance1, reserve0, reserve1);
        if (feeOn) kLast = uint256(_reserve0) * _reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ------------------------------------------------------------------------------------------------------ swap

    /// @inheritdoc ICircleswapPair
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
        external
        override
        nonReentrant
    {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 reserve0, uint112 reserve1, ) = getReserves();
        if (amount0Out >= reserve0 || amount1Out >= reserve1) revert InsufficientLiquidity();

        address t0 = token0;
        address t1 = token1;
        if (to == t0 || to == t1) revert InvalidTo();

        // Optimistic: pay out first. A flash-swap callee gets the tokens before it has paid.
        if (amount0Out > 0) IERC20(t0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(t1).safeTransfer(to, amount1Out);
        // slither-disable-next-line reentrancy-no-eth,reentrancy-benign -- flash swap by design: nonReentrant, and k is checked after the callback
        if (data.length > 0) ICircleswapCallee(to).circleswapCall(msg.sender, amount0Out, amount1Out, data);

        uint256 balance0 = IERC20(t0).balanceOf(address(this));
        uint256 balance1 = IERC20(t1).balanceOf(address(this));

        // What was paid in: whatever the balance holds above what remains of the reserve after the payout.
        uint256 amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        // slither-disable-next-line incorrect-equality -- nothing paid in is the case being refused
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        // k must not fall once the 0.3% fee on what came in is set aside (all scaled by 1000).
        uint256 adjusted0 = balance0 * 1000 - amount0In * 3;
        uint256 adjusted1 = balance1 * 1000 - amount1In * 3;
        if (adjusted0 * adjusted1 < uint256(reserve0) * uint256(reserve1) * 1_000_000) revert InvariantViolated();

        _update(balance0, balance1, reserve0, reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @inheritdoc ICircleswapPair
    function skim(address to) external override nonReentrant {
        address t0 = token0;
        address t1 = token1;
        IERC20(t0).safeTransfer(to, IERC20(t0).balanceOf(address(this)) - _reserve0);
        IERC20(t1).safeTransfer(to, IERC20(t1).balanceOf(address(this)) - _reserve1);
    }

    /// @inheritdoc ICircleswapPair
    function sync() external override nonReentrant {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), _reserve0, _reserve1);
    }

    // ---------------------------------------------------------------------------------------------- internals

    /// @dev Records new reserves and folds the time since the last update into the price accumulators, which
    ///      let other contracts compute a time-weighted average price. Accumulators are meant to wrap.
    function _update(uint256 balance0, uint256 balance1, uint112 oldReserve0, uint112 oldReserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert BalanceOverflow();
        uint32 timestamp = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = timestamp - _blockTimestampLast;
            if (elapsed > 0 && oldReserve0 != 0 && oldReserve1 != 0) {
                // price = other reserve / this reserve, as a 112.112 fixed-point number, times seconds elapsed.
                // slither-disable-next-line divide-before-multiply,reentrancy-benign -- UQ112x112 price: the shift is the fixed-point scale, not lost precision
                price0CumulativeLast += ((uint256(oldReserve1) << 112) / oldReserve0) * elapsed;
                // slither-disable-next-line divide-before-multiply,reentrancy-benign -- see price0CumulativeLast
                price1CumulativeLast += ((uint256(oldReserve0) << 112) / oldReserve1) * elapsed;
            }
        }
        _reserve0 = uint112(balance0);
        _reserve1 = uint112(balance1);
        _blockTimestampLast = timestamp;
        emit Sync(_reserve0, _reserve1);
    }

    /// @dev If the factory has a fee recipient, mints it LP shares worth one sixth of the growth in
    ///      sqrt(k) since the last liquidity event (one sixth of the 0.3% fee, i.e. 0.05% of volume). Returns
    ///      whether the fee is on so the caller can refresh kLast afterwards. Off means kLast stays 0.
    function _mintProtocolFee(uint112 reserve0, uint112 reserve1) private returns (bool feeOn) {
        address feeTo = _feeTo();
        feeOn = feeTo != address(0);
        uint256 lastK = kLast;
        if (feeOn) {
            if (lastK != 0) {
                uint256 rootK = Math.sqrt(uint256(reserve0) * reserve1);
                uint256 rootLastK = Math.sqrt(lastK);
                if (rootK > rootLastK) {
                    uint256 shares = (totalSupply() * (rootK - rootLastK)) / (rootK * 5 + rootLastK);
                    if (shares > 0) _mint(feeTo, shares);
                }
            }
        } else if (lastK != 0) {
            kLast = 0;
        }
    }

    /// @dev Gas allowed for asking the factory where the protocol fee goes.
    uint256 private constant FEE_TO_GAS = 100_000;

    /**
     * @dev The factory is upgradable, but a pool's exits must not depend on it: `mint` and `burn` ask it for `feeTo`,
     *      so if that call could revert, run out of gas or return a huge payload, a bad factory upgrade would lock
     *      every liquidity provider in. The call is therefore capped in gas, its reply is read as exactly one word
     *      (never copied whole), and anything else counts as "protocol fee off". A broken factory can cost the
     *      protocol its fee; it cannot stop a withdrawal.
     */
    function _feeTo() private view returns (address result) {
        address f = factory;
        bytes4 selector = ICircleswapFactory.feeTo.selector;
        bool ok;
        // slither-disable-next-line assembly -- a gas-capped staticcall that reads exactly one word: see the doc above
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            ok := staticcall(FEE_TO_GAS, f, ptr, 4, ptr, 32)
            if ok {
                if iszero(eq(returndatasize(), 32)) { ok := 0 }
            }
            if ok { result := and(mload(ptr), 0xffffffffffffffffffffffffffffffffffffffff) }
        }
    }
}
