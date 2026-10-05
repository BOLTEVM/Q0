// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import "./interfaces/ICircleswapFactory.sol";
import "./interfaces/ICircleswapPair.sol";
import "./interfaces/IWQUAI.sol";
import "./libraries/CircleswapMath.sol";
import "./libraries/ReentrancyGuardUpgradeable.sol";

/**
 * @title CircleswapRouter
 * @author Circleswap DeFi Protocol
 * @notice The way to use Circleswap pools: add and remove liquidity and swap along a path of pools, with
 *         slippage limits, a deadline, and native QUAI handled through WQUAI.
 *         Upgraded to OpenZeppelin v5 UUPS upgradeable contract pattern.
 *
 * @dev The function set and argument order follow the widely used constant-product router ABI, so wallets and
 *      the app's encoders work unchanged (e.g. swapExactTokensForTokens is 0x38ed1739).
 */
contract CircleswapRouter is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    address public factory;
    /// @notice Wrapped native QUAI.
    address public WETH;

    uint256[50] private __gap;

    error Expired();
    error InvalidPath();
    error PairNotFound();
    error InsufficientAAmount();
    error InsufficientBAmount();
    error InsufficientOutputAmount();
    error ExcessiveInputAmount();
    error InsufficientAmount();
    error NativeTransferFailed();
    error UnexpectedNativeSender();
    error InvalidToken();
    error InvalidRecipient();
    error PermitFailed();

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    /// @dev Tokens sent to the router can never be recovered (it has no admin) and native QUAI sent to the zero
    ///      address is burned, so a recipient of either is refused outright.
    modifier validRecipient(address to) {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function __UUPSUpgradeable_init() internal onlyInitializing {}

    /**
     * @notice Initializes the router as a UUPS upgradeable contract.
     * @param factory_ Address of the CircleswapFactory.
     * @param wquai_ Address of WQUAI.
     * @param initialOwner Address of the router owner with two-step ownership.
     */
    function initialize(address factory_, address wquai_, address initialOwner) external initializer {
        if (factory_.code.length == 0 || wquai_.code.length == 0) revert InvalidToken();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        factory = factory_;
        WETH = wquai_;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Native QUAI is only ever received from WQUAI (on withdraw); anything else is refused.
    receive() external payable {
        if (msg.sender != WETH) revert UnexpectedNativeSender();
    }

    // ------------------------------------------------------------------------------------------ add liquidity

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) validRecipient(to) nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = ICircleswapFactory(factory).getPair(tokenA, tokenB);
        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = ICircleswapPair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        validRecipient(to)
        nonReentrant
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        (amountToken, amountETH) = _addLiquidity(token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);
        address pair = ICircleswapFactory(factory).getPair(token, WETH);
        IERC20(token).safeTransferFrom(msg.sender, pair, amountToken);
        IWQUAI(WETH).deposit{value: amountETH}();
        IERC20(WETH).safeTransfer(pair, amountETH);
        liquidity = ICircleswapPair(pair).mint(to);
        if (msg.value > amountETH) _sendNative(msg.sender, msg.value - amountETH); // refund the unused QUAI
    }

    // --------------------------------------------------------------------------------------- remove liquidity

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) validRecipient(to) nonReentrant returns (uint256 amountA, uint256 amountB) {
        (amountA, amountB) = _removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to);
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) validRecipient(to) nonReentrant returns (uint256 amountToken, uint256 amountETH) {
        (amountToken, amountETH) = _removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this));
        IERC20(token).safeTransfer(to, amountToken);
        IWQUAI(WETH).withdraw(amountETH);
        _sendNative(to, amountETH);
    }

    /// @notice Same as removeLiquidity, but approves the router with an EIP-2612 signature so it is one transaction.
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external ensure(deadline) validRecipient(to) returns (uint256 amountA, uint256 amountB) {
        address pair = ICircleswapFactory(factory).getPair(tokenA, tokenB);
        _permit(pair, approveMax ? type(uint256).max : liquidity, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external ensure(deadline) validRecipient(to) returns (uint256 amountToken, uint256 amountETH) {
        address pair = ICircleswapFactory(factory).getPair(token, WETH);
        _permit(pair, approveMax ? type(uint256).max : liquidity, deadline, v, r, s);
        (amountToken, amountETH) = removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }

    // ---------------------------------------------------------------------------------------------------- swap

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) validRecipient(to) nonReentrant returns (uint256[] memory amounts) {
        address[] memory pairs;
        (amounts, pairs) = _amountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, pairs[0], amounts[0]);
        _swap(amounts, path, pairs, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) validRecipient(to) nonReentrant returns (uint256[] memory amounts) {
        address[] memory pairs;
        (amounts, pairs) = _amountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, pairs[0], amounts[0]);
        _swap(amounts, path, pairs, to);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        validRecipient(to)
        nonReentrant
        returns (uint256[] memory amounts)
    {
        if (path[0] != WETH) revert InvalidPath();
        address[] memory pairs;
        (amounts, pairs) = _amountsOut(msg.value, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IWQUAI(WETH).deposit{value: amounts[0]}();
        IERC20(WETH).safeTransfer(pairs[0], amounts[0]);
        _swap(amounts, path, pairs, to);
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) validRecipient(to) nonReentrant returns (uint256[] memory amounts) {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        address[] memory pairs;
        (amounts, pairs) = _amountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, pairs[0], amounts[0]);
        _swap(amounts, path, pairs, address(this));
        IWQUAI(WETH).withdraw(amounts[amounts.length - 1]);
        _sendNative(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) validRecipient(to) nonReentrant returns (uint256[] memory amounts) {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        address[] memory pairs;
        (amounts, pairs) = _amountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, pairs[0], amounts[0]);
        _swap(amounts, path, pairs, address(this));
        IWQUAI(WETH).withdraw(amounts[amounts.length - 1]);
        _sendNative(to, amounts[amounts.length - 1]);
    }

    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        validRecipient(to)
        nonReentrant
        returns (uint256[] memory amounts)
    {
        if (path[0] != WETH) revert InvalidPath();
        address[] memory pairs;
        (amounts, pairs) = _amountsIn(amountOut, path);
        if (amounts[0] > msg.value) revert ExcessiveInputAmount();
        IWQUAI(WETH).deposit{value: amounts[0]}();
        IERC20(WETH).safeTransfer(pairs[0], amounts[0]);
        _swap(amounts, path, pairs, to);
        if (msg.value > amounts[0]) _sendNative(msg.sender, msg.value - amounts[0]); // refund the unused QUAI
    }

    // ---------------------------------------------------------------------------------------------- read-only

    /// @notice `amountB` of tokenB that matches `amountA` of tokenA at the current pool ratio (no fee).
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB) {
        return CircleswapMath.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        return CircleswapMath.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        return CircleswapMath.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        (amounts, ) = _amountsOut(amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts) {
        (amounts, ) = _amountsIn(amountOut, path);
    }

    // ---------------------------------------------------------------------------------------------- internals

    /// @dev Works out how much of each token to deposit: the desired amounts, trimmed on one side to match the
    ///      pool's current ratio. Creates the pool first if it does not exist (its ratio is then whatever the
    ///      caller deposits).
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private returns (uint256 amountA, uint256 amountB) {
        ICircleswapFactory f = ICircleswapFactory(factory);
        // slither-disable-next-line unused-return -- the pool is looked up with getPair right after, never taken from the return value
        if (f.getPair(tokenA, tokenB) == address(0)) f.createPair(tokenA, tokenB);
        (uint256 reserveA, uint256 reserveB) = _reserves(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = CircleswapMath.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) revert InsufficientBAmount();
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = CircleswapMath.quote(amountBDesired, reserveB, reserveA);
                if (amountAOptimal > amountADesired) revert InsufficientAAmount(); // unreachable by construction
                if (amountAOptimal < amountAMin) revert InsufficientAAmount();
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function _removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to
    ) private returns (uint256 amountA, uint256 amountB) {
        address pair = _pair(tokenA, tokenB);
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = ICircleswapPair(pair).burn(to);
        (amountA, amountB) = tokenA < tokenB ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    /// @dev Runs a swap along `path`, each hop sending its output straight to the next pool.
    function _swap(uint256[] memory amounts, address[] calldata path, address[] memory pairs, address to) private {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input < output ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address recipient = i < path.length - 2 ? pairs[i + 1] : to;
            // slither-disable-next-line calls-loop -- one swap per hop; the caller chooses (and pays for) the path length
            ICircleswapPair(pairs[i]).swap(amount0Out, amount1Out, recipient, new bytes(0));
        }
    }

    function _amountsOut(uint256 amountIn, address[] calldata path)
        private
        view
        returns (uint256[] memory amounts, address[] memory pairs)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        pairs = new address[](path.length - 1);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            pairs[i] = _pair(path[i], path[i + 1]);
            (uint256 reserveIn, uint256 reserveOut) = _pairReserves(pairs[i], path[i], path[i + 1]);
            amounts[i + 1] = CircleswapMath.getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    function _amountsIn(uint256 amountOut, address[] calldata path)
        private
        view
        returns (uint256[] memory amounts, address[] memory pairs)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        pairs = new address[](path.length - 1);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; --i) {
            pairs[i - 1] = _pair(path[i - 1], path[i]);
            (uint256 reserveIn, uint256 reserveOut) = _pairReserves(pairs[i - 1], path[i - 1], path[i]);
            amounts[i - 1] = CircleswapMath.getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @dev The pool for two tokens; reverts if it does not exist.
    function _pair(address tokenA, address tokenB) private view returns (address pair) {
        // slither-disable-next-line calls-loop -- one lookup per hop; the caller chooses (and pays for) the path length
        pair = ICircleswapFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }

    /// @dev Reserves of (tokenA, tokenB) in that order, or (0, 0) if the pool does not exist.
    function _reserves(address tokenA, address tokenB) private view returns (uint256 reserveA, uint256 reserveB) {
        address pair = ICircleswapFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        return _pairReserves(pair, tokenA, tokenB);
    }

    /// @dev Reserves of an already-looked-up pool, ordered as (tokenA, tokenB).
    function _pairReserves(address pair, address tokenA, address tokenB) private view returns (uint256 reserveA, uint256 reserveB) {
        // slither-disable-next-line unused-return,calls-loop -- the timestamp is not needed; one read per hop
        (uint112 reserve0, uint112 reserve1, ) = ICircleswapPair(pair).getReserves();
        (reserveA, reserveB) = tokenA < tokenB ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
    }

    /// @dev A permit signature is public the moment it is broadcast, so anyone can submit it first. That uses up its
    ///      nonce and would make a plain call here revert even though the approval it grants is now in place: a
    ///      cheap way to block someone's withdrawal. So a failing permit is tolerated exactly when the allowance it
    ///      was meant to create already exists, and refused otherwise (a bad signature, or one from someone else,
    ///      leaves the allowance short).
    function _permit(address pair, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        if (pair == address(0)) revert PairNotFound();
        try IERC20Permit(pair).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {
            if (IERC20(pair).allowance(msg.sender, address(this)) < value) revert PermitFailed();
        }
    }

    function _sendNative(address to, uint256 amount) private {
        // slither-disable-next-line low-level-calls -- native QUAI can only be sent this way; failure is checked and reverts
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
