// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/IQrbBoost.sol";

/**
 * @title CircleswapMasterChef
 * @author Circleswap DeFi Protocol
 * @notice Dual-reward liquidity mining and single-asset staking for Circleswap on Quai Network.
 * @dev Distributes two reward tokens (BoltDelta and Q0) per second, split across pools by allocation.
 *
 *      Boost: the farm asks one place, `qrb.boostBpsOf(user)`, and adds that many basis points to both
 *      pending rewards. It stores no boost figure of its own and `qrb` is immutable, so the owner cannot
 *      change who gets a boost or how much. Boost is paid from the reward inventory on top of emissions,
 *      so the inventory must be funded for about (1 + boost) times the base emission.
 *
 *      Solvency: a pool may stake a token that is also a reward token (BDELTA and Q0 single-stake pools).
 *      Rewards are therefore paid only from the balance above what users have staked of that token, so
 *      rewards can never be paid out of depositors' principal.
 *
 *      Shortfall: if the inventory cannot cover a harvest, what could not be paid stays owed to the user
 *      (`unpaidA` / `unpaidB`) and is paid, first, by the next harvest after the owner refills it. Nothing is
 *      forfeited except through `emergencyWithdraw`, which is explicitly the exit that gives rewards up.
 *
 *      Not supported: fee-on-transfer or rebasing stake tokens (deposits are credited at face value).
 */
contract CircleswapMasterChef is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount; // Stake tokens the user has deposited.
        uint256 rewardDebtA; // Reward debt for Token A (BoltDelta).
        uint256 rewardDebtB; // Reward debt for Token B (Q0).
        uint256 unpaidA; // Token A earned and owed but not yet paid because the inventory ran short.
        uint256 unpaidB; // Token B earned and owed but not yet paid because the inventory ran short.
    }

    struct PoolInfo {
        IERC20 lpToken; // LP or single-asset token being staked.
        uint256 allocPoint; // Allocation points assigned to this pool.
        uint256 lastRewardTime; // Last timestamp at which rewards were accounted.
        uint256 accRewardAPerShare; // Accumulated Token A per share, times ACC_PRECISION.
        uint256 accRewardBPerShare; // Accumulated Token B per share, times ACC_PRECISION.
        uint256 totalStaked; // Total tokens staked in this pool.
    }

    /// @dev Scale of the per-share accumulators. Each pool update floors the accumulator, so the scale must dwarf
    ///      the staked supply relative to the emission earned between updates; at 1e12 a large supply with a small
    ///      emission lost tens of percent of it (fuzzed in test/foundry/MasterChefPrecision.t.sol). Overflow is
    ///      not a concern: reward x ACC_PRECISION stays below 1e70 even at MAX_EMISSION_PER_SECOND.
    uint256 private constant ACC_PRECISION = 1e24;
    uint256 private constant BPS = 10_000;

    /// @notice Highest emission the owner can set, per reward token per second (1e18 whole tokens/s). Far above
    ///         any real rate; it exists so a units mistake cannot overflow the reward math and brick harvests.
    uint256 public constant MAX_EMISSION_PER_SECOND = 1e36;

    /// @notice Highest allocation a single pool can be given. Keeps elapsed x rate x alloc inside uint256.
    uint256 public constant MAX_ALLOC_POINT = 1e18;

    /// @notice Highest boost the farm will ever pay, whatever the boost source reports (+100%).
    uint256 public constant MAX_BOOST_BPS = BPS;

    /// @notice Reward Token A: BoltDelta.
    IERC20 public immutable rewardTokenA;

    /// @notice Reward Token B: Q0.
    IERC20 public immutable rewardTokenB;

    /// @notice Source of the boost (the Qrb ERC-20), or address(0) for a farm with no boost. Immutable.
    IQrbBoost public immutable qrb;

    /// @notice Token A emitted per second across all pools.
    uint256 public rewardAPerSecond;

    /// @notice Token B emitted per second across all pools.
    uint256 public rewardBPerSecond;

    PoolInfo[] public poolInfo;

    /// @notice pid => user => stake info.
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    /// @notice Total staked of each token across every pool; excluded from what can be paid as rewards.
    mapping(IERC20 => uint256) public stakedByToken;

    uint256 public totalAllocPoint;

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 allocPoint);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    /// @dev Amounts are what was actually transferred, including boost. Anything owed but not paid because the
    ///      inventory ran short stays in `userInfo(...).unpaidA/B`.
    event Harvest(address indexed user, uint256 indexed pid, uint256 amountA, uint256 amountB);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmissionRatesUpdated(uint256 rewardAPerSecond, uint256 rewardBPerSecond);

    error InvalidPool();
    error InvalidToken();
    error InvalidQrb();
    error ZeroAmount();
    error InsufficientBalance();
    error ValueTooHigh();

    constructor(
        address initialOwner,
        IERC20 _rewardTokenA,
        IERC20 _rewardTokenB,
        IQrbBoost _qrb,
        uint256 _rewardAPerSecond,
        uint256 _rewardBPerSecond
    ) Ownable(initialOwner) {
        if (address(_rewardTokenA) == address(0) || address(_rewardTokenB) == address(0)) revert InvalidToken();
        if (_rewardAPerSecond > MAX_EMISSION_PER_SECOND || _rewardBPerSecond > MAX_EMISSION_PER_SECOND) {
            revert ValueTooHigh();
        }
        if (address(_qrb) != address(0)) {
            // A boost source that does not answer the interface would silently never boost.
            if (address(_qrb).code.length == 0) revert InvalidQrb();
            // slither-disable-next-line unused-return -- a probe that the source answers the interface; the value is irrelevant
            try _qrb.BOOST_BPS() returns (uint256) {} catch { revert InvalidQrb(); }
        }
        rewardTokenA = _rewardTokenA;
        rewardTokenB = _rewardTokenB;
        qrb = _qrb;
        rewardAPerSecond = _rewardAPerSecond;
        rewardBPerSecond = _rewardBPerSecond;
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    /// @notice Adds a pool. Owner only. Always brings every pool's accounting up to date first, so a change
    ///         of total allocation can never rewrite rewards already earned.
    function addPool(uint256 allocPoint, IERC20 lpToken) external onlyOwner {
        if (address(lpToken) == address(0)) revert InvalidToken();
        if (allocPoint > MAX_ALLOC_POINT) revert ValueTooHigh();
        massUpdatePools();
        totalAllocPoint += allocPoint;
        poolInfo.push(
            PoolInfo({
                lpToken: lpToken,
                allocPoint: allocPoint,
                lastRewardTime: block.timestamp,
                accRewardAPerShare: 0,
                accRewardBPerShare: 0,
                totalStaked: 0
            })
        );
        emit PoolAdded(poolInfo.length - 1, address(lpToken), allocPoint);
    }

    /// @notice Changes a pool's allocation. Owner only. Updates every pool first (see addPool).
    function setPool(uint256 pid, uint256 allocPoint) external onlyOwner {
        if (pid >= poolInfo.length) revert InvalidPool();
        if (allocPoint > MAX_ALLOC_POINT) revert ValueTooHigh();
        massUpdatePools();
        totalAllocPoint = totalAllocPoint - poolInfo[pid].allocPoint + allocPoint;
        poolInfo[pid].allocPoint = allocPoint;
        emit PoolUpdated(pid, allocPoint);
    }

    /// @notice Everything owed to `user` in pool `pid` right now, including boost and anything left unpaid
    ///         by an earlier shortfall.
    function pendingRewards(uint256 pid, address user) external view returns (uint256 pendingA, uint256 pendingB) {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage userItem = userInfo[pid][user];

        uint256 accA = pool.accRewardAPerShare;
        uint256 accB = pool.accRewardBPerShare;
        uint256 lpSupply = pool.totalStaked;

        if (block.timestamp > pool.lastRewardTime && lpSupply != 0 && totalAllocPoint > 0) {
            (uint256 addA, uint256 addB) = _accrued(pool, block.timestamp - pool.lastRewardTime);
            accA += addA;
            accB += addB;
        }

        pendingA = (userItem.amount * accA) / ACC_PRECISION - userItem.rewardDebtA;
        pendingB = (userItem.amount * accB) / ACC_PRECISION - userItem.rewardDebtB;

        uint256 boost = _boostBps(user);
        if (boost != 0) {
            pendingA += (pendingA * boost) / BPS;
            pendingB += (pendingB * boost) / BPS;
        }
        pendingA += userItem.unpaidA;
        pendingB += userItem.unpaidB;
    }

    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            updatePool(pid);
        }
    }

    function updatePool(uint256 pid) public {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        if (block.timestamp <= pool.lastRewardTime) return;

        uint256 lpSupply = pool.totalStaked;
        // slither-disable-next-line incorrect-equality -- empty pool or no allocation: nothing to accrue
        if (lpSupply == 0 || totalAllocPoint == 0) {
            pool.lastRewardTime = block.timestamp;
            return;
        }
        (uint256 addA, uint256 addB) = _accrued(pool, block.timestamp - pool.lastRewardTime);
        pool.accRewardAPerShare += addA;
        pool.accRewardBPerShare += addB;
        pool.lastRewardTime = block.timestamp;
    }

    /// @notice Stakes `amount` into pool `pid`, harvesting any pending rewards first. `amount` may be 0 to
    ///         harvest only.
    function deposit(uint256 pid, uint256 amount) external nonReentrant whenNotPaused {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];
        updatePool(pid);

        if (user.amount > 0 || user.unpaidA > 0 || user.unpaidB > 0) _harvest(pid, msg.sender);

        if (amount > 0) {
            pool.lpToken.safeTransferFrom(msg.sender, address(this), amount);
            user.amount += amount;
            pool.totalStaked += amount;
            stakedByToken[pool.lpToken] += amount;
        }

        user.rewardDebtA = (user.amount * pool.accRewardAPerShare) / ACC_PRECISION;
        user.rewardDebtB = (user.amount * pool.accRewardBPerShare) / ACC_PRECISION;

        emit Deposit(msg.sender, pid, amount);
    }

    /// @notice Withdraws `amount` from pool `pid` and harvests. Allowed while paused.
    function withdraw(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];
        if (user.amount < amount) revert InsufficientBalance();
        updatePool(pid);

        _harvest(pid, msg.sender);

        if (amount > 0) {
            user.amount -= amount;
            pool.totalStaked -= amount;
            stakedByToken[pool.lpToken] -= amount;
            pool.lpToken.safeTransfer(msg.sender, amount);
        }

        user.rewardDebtA = (user.amount * pool.accRewardAPerShare) / ACC_PRECISION;
        user.rewardDebtB = (user.amount * pool.accRewardBPerShare) / ACC_PRECISION;

        emit Withdraw(msg.sender, pid, amount);
    }

    /// @notice Harvests dual rewards from pool `pid` without changing the stake. Also pays anything left
    ///         unpaid by an earlier shortfall, even if the stake has since been withdrawn.
    function harvest(uint256 pid) external nonReentrant whenNotPaused {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];
        updatePool(pid);

        _harvest(pid, msg.sender);

        user.rewardDebtA = (user.amount * pool.accRewardAPerShare) / ACC_PRECISION;
        user.rewardDebtB = (user.amount * pool.accRewardBPerShare) / ACC_PRECISION;
    }

    /// @notice Withdraws the whole stake and gives up every reward, including anything owed but unpaid.
    ///         Works while paused.
    function emergencyWithdraw(uint256 pid) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPool();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];
        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebtA = 0;
        user.rewardDebtB = 0;
        user.unpaidA = 0;
        user.unpaidB = 0;
        pool.totalStaked -= amount;
        stakedByToken[pool.lpToken] -= amount;
        pool.lpToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, pid, amount);
    }

    /// @notice Sets both emission rates. Owner only; every pool is brought up to date at the old rates first.
    function setEmissionRates(uint256 _rewardAPerSecond, uint256 _rewardBPerSecond) external onlyOwner {
        if (_rewardAPerSecond > MAX_EMISSION_PER_SECOND || _rewardBPerSecond > MAX_EMISSION_PER_SECOND) {
            revert ValueTooHigh();
        }
        massUpdatePools();
        rewardAPerSecond = _rewardAPerSecond;
        rewardBPerSecond = _rewardBPerSecond;
        emit EmissionRatesUpdated(_rewardAPerSecond, _rewardBPerSecond);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Per-share accumulator growth over `elapsed` seconds for a pool with stakers, in one full-precision
    ///      step (no intermediate rounding of the pool's reward). Callers guarantee `totalStaked` and
    ///      `totalAllocPoint` are non-zero.
    function _accrued(PoolInfo storage pool, uint256 elapsed) private view returns (uint256 addA, uint256 addB) {
        uint256 denominator = totalAllocPoint * pool.totalStaked;
        addA = Math.mulDiv(elapsed * rewardAPerSecond * pool.allocPoint, ACC_PRECISION, denominator);
        addB = Math.mulDiv(elapsed * rewardBPerSecond * pool.allocPoint, ACC_PRECISION, denominator);
    }

    /// @dev Boost for `user` from the single boost source, never above MAX_BOOST_BPS. A missing or
    ///      misbehaving source means no boost, never a reverted harvest.
    function _boostBps(address user) internal view returns (uint256) {
        if (address(qrb) == address(0)) return 0;
        try qrb.boostBpsOf(user) returns (uint256 bps) {
            return bps > MAX_BOOST_BPS ? MAX_BOOST_BPS : bps;
        } catch {
            return 0;
        }
    }

    function _harvest(uint256 pid, address userAddr) internal {
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][userAddr];

        uint256 earnedA = (user.amount * pool.accRewardAPerShare) / ACC_PRECISION - user.rewardDebtA;
        uint256 earnedB = (user.amount * pool.accRewardBPerShare) / ACC_PRECISION - user.rewardDebtB;

        // Boost applies to what was newly earned, not to amounts already left unpaid.
        uint256 boost = _boostBps(userAddr);
        if (boost != 0) {
            earnedA += (earnedA * boost) / BPS;
            earnedB += (earnedB * boost) / BPS;
        }

        uint256 owedA = earnedA + user.unpaidA;
        uint256 owedB = earnedB + user.unpaidB;

        uint256 paidA = owedA > 0 ? _safeRewardTransfer(rewardTokenA, userAddr, owedA) : 0;
        uint256 paidB = owedB > 0 ? _safeRewardTransfer(rewardTokenB, userAddr, owedB) : 0;

        user.unpaidA = owedA - paidA;
        user.unpaidB = owedB - paidB;

        emit Harvest(userAddr, pid, paidA, paidB);
    }

    /// @dev Pays up to `amount` from the reward inventory only: the contract's balance minus everything
    ///      users have staked of `token`. Returns what was actually paid.
    function _safeRewardTransfer(IERC20 token, address to, uint256 amount) internal returns (uint256 paid) {
        uint256 bal = token.balanceOf(address(this));
        uint256 staked = stakedByToken[token];
        uint256 available = bal > staked ? bal - staked : 0;
        paid = amount > available ? available : amount;
        if (paid > 0) token.safeTransfer(to, paid);
    }
}
