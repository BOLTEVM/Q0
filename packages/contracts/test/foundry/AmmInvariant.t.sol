// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AmmBase.sol";

/// @dev Random-but-valid activity across three pools (A/B, B/C, A/C, so multi-hop and triangular routes exist).
///      A call may only revert with the dust errors the contracts raise on purpose; anything else (notably
///      InvariantViolated after a router-quoted swap) escapes and fails the run.
contract AmmHandler is Test {
    CircleswapFactory public immutable factory;
    CircleswapRouter public immutable router;
    MockToken[3] public tokens;
    CircleswapPair[3] public pairs;
    address[] public actors;
    address public feeRecipient = address(0xFEE1);
    uint256 public calls;
    uint256 public swaps;

    constructor(CircleswapFactory f, CircleswapRouter r, MockToken a, MockToken b, MockToken c) {
        factory = f;
        router = r;
        tokens[0] = a;
        tokens[1] = b;
        tokens[2] = c;
        pairs[0] = CircleswapPair(f.getPair(address(a), address(b)));
        pairs[1] = CircleswapPair(f.getPair(address(b), address(c)));
        pairs[2] = CircleswapPair(f.getPair(address(a), address(c)));
        for (uint256 i; i < 3; ++i) {
            address who = makeAddr(string.concat("amm-actor", vm.toString(i)));
            actors.push(who);
            _approveAll(who);
        }
    }

    function _approveAll(address who) internal {
        for (uint256 t; t < 3; ++t) {
            vm.prank(who);
            tokens[t].approve(address(router), type(uint256).max);
            vm.prank(who);
            pairs[t].approve(address(router), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // -------------------------------------------------------------------------------------------------- helpers

    function _expected(bytes memory reason) internal pure {
        bytes4 sel;
        assembly {
            sel := mload(add(reason, 32))
        }
        if (
            sel == CircleswapMath.InsufficientInputAmount.selector
                || sel == CircleswapMath.InsufficientOutputAmount.selector
                || sel == CircleswapMath.InsufficientLiquidity.selector || sel == CircleswapMath.InsufficientAmount.selector
                || sel == CircleswapPair.InsufficientLiquidityMinted.selector
                || sel == CircleswapPair.InsufficientLiquidityBurned.selector
                // Draining nearly a whole pool by exact-output needs an input beyond a uint112 reserve: refused.
                || sel == CircleswapPair.BalanceOverflow.selector
        ) return;
        assembly {
            revert(add(reason, 32), mload(reason)) // anything unexpected fails the campaign, reason intact
        }
    }

    function _pair(uint256 seed) internal view returns (CircleswapPair p, MockToken x, MockToken y) {
        uint256 i = seed % 3;
        p = pairs[i];
        x = MockToken(p.token0());
        y = MockToken(p.token1());
    }

    function _k(CircleswapPair p) internal view returns (uint256) {
        (uint112 r0, uint112 r1, ) = p.getReserves();
        return uint256(r0) * uint256(r1);
    }

    function _p2(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    // -------------------------------------------------------------------------------------------------- actions

    function addLiquidity(uint256 actorSeed, uint256 poolSeed, uint256 a0, uint256 a1) external {
        address who = actors[actorSeed % actors.length];
        (, MockToken x, MockToken y) = _pair(poolSeed);
        a0 = bound(a0, 1, 1e24);
        a1 = bound(a1, 1, 1e24);
        x.mint(who, a0);
        y.mint(who, a1);
        vm.prank(who);
        try router.addLiquidity(address(x), address(y), a0, a1, 0, 0, who, block.timestamp) {} catch (bytes memory r) {
            _expected(r);
        }
        ++calls;
    }

    function removeLiquidity(uint256 actorSeed, uint256 poolSeed, uint256 fraction) external {
        address who = actors[actorSeed % actors.length];
        (CircleswapPair p, MockToken x, MockToken y) = _pair(poolSeed);
        uint256 shares = (p.balanceOf(who) * bound(fraction, 0, 100)) / 100;
        if (shares == 0) return;
        vm.prank(who);
        try router.removeLiquidity(address(x), address(y), shares, 0, 0, who, block.timestamp) {}
        catch (bytes memory r) {
            _expected(r);
        }
        ++calls;
    }

    function swapExactIn(uint256 actorSeed, uint256 poolSeed, bool dir, uint256 amt) external {
        address who = actors[actorSeed % actors.length];
        (CircleswapPair p, MockToken x, MockToken y) = _pair(poolSeed);
        (MockToken i, MockToken o) = dir ? (x, y) : (y, x);
        amt = bound(amt, 1, 1e24);
        i.mint(who, amt);
        uint256 kBefore = _k(p);
        vm.prank(who);
        try router.swapExactTokensForTokens(amt, 0, _p2(address(i), address(o)), who, block.timestamp) {
            ++swaps;
            assertGe(_k(p), kBefore, "a swap lowered k");
        } catch (bytes memory r) {
            _expected(r);
        }
        ++calls;
    }

    function swapExactOut(uint256 actorSeed, uint256 poolSeed, bool dir, uint256 out) external {
        (CircleswapPair p, MockToken x, MockToken y) = _pair(poolSeed);
        (MockToken i, MockToken o) = dir ? (x, y) : (y, x);
        (uint112 r0, uint112 r1, ) = p.getReserves();
        uint256 ro = address(o) == p.token0() ? r0 : r1;
        if (ro < 2) return;
        _swapOut(actors[actorSeed % actors.length], p, i, o, bound(out, 1, ro - 1));
        ++calls;
    }

    function _swapOut(address who, CircleswapPair p, MockToken i, MockToken o, uint256 out) internal {
        uint256 need;
        try router.getAmountsIn(out, _p2(address(i), address(o))) returns (uint256[] memory a) {
            need = a[0];
        } catch (bytes memory r) {
            _expected(r);
            return;
        }
        i.mint(who, need);
        uint256 kBefore = _k(p);
        vm.prank(who);
        try router.swapTokensForExactTokens(out, need, _p2(address(i), address(o)), who, type(uint256).max) {
            ++swaps;
            assertGe(_k(p), kBefore, "a swap lowered k");
        } catch (bytes memory r) {
            _expected(r);
        }
    }

    /// @dev A -> B -> C along two pools in one call.
    function swapTwoHops(uint256 actorSeed, uint256 amt) external {
        address who = actors[actorSeed % actors.length];
        amt = bound(amt, 1, 1e24);
        tokens[0].mint(who, amt);
        address[] memory path = new address[](3);
        path[0] = address(tokens[0]);
        path[1] = address(tokens[1]);
        path[2] = address(tokens[2]);
        vm.prank(who);
        try router.swapExactTokensForTokens(amt, 0, path, who, block.timestamp) {
            ++swaps;
        } catch (bytes memory r) {
            _expected(r);
        }
        ++calls;
    }

    /// @dev Tokens sent straight to a pool, then either swept (skim) or absorbed (sync). Either way the pool
    ///      must stay solvent and no one must be able to take value they did not put in.
    function donate(uint256 poolSeed, bool tokenSide, uint256 amt, bool absorb) external {
        (CircleswapPair p, MockToken x, MockToken y) = _pair(poolSeed);
        MockToken t = tokenSide ? x : y;
        t.mint(address(p), bound(amt, 0, 1e22));
        if (absorb) p.sync();
        else p.skim(feeRecipient);
        ++calls;
    }

    function toggleFee() external {
        factory.setFeeTo(factory.feeTo() == address(0) ? feeRecipient : address(0));
        ++calls;
    }

    function warp(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 1 days));
        ++calls;
    }
}

contract AmmInvariantTest is AmmBase {
    AmmHandler internal handler;
    CircleswapPair[3] internal pools;

    function setUp() public override {
        super.setUp();
        pools[0] = _seed(tA, tB, 1e22, 2e22);
        pools[1] = _seed(tB, tC, 3e22, 1e22);
        pools[2] = _seed(tA, tC, 5e21, 5e21);
        handler = new AmmHandler(factory, router, tA, tB, tC);
        factory.transferOwnership(address(handler));
        vm.prank(address(handler));
        factory.acceptOwnership();
        targetContract(address(handler));
    }

    /// No pool can ever hold less than it owes: balances cover the recorded reserves, always.
    function invariant_poolsAreSolvent() public view {
        for (uint256 i; i < 3; ++i) {
            (uint112 r0, uint112 r1, ) = pools[i].getReserves();
            assertGe(MockToken(pools[i].token0()).balanceOf(address(pools[i])), r0, "token0 below reserve");
            assertGe(MockToken(pools[i].token1()).balanceOf(address(pools[i])), r1, "token1 below reserve");
        }
    }

    /// The router never keeps anything: not tokens, not native.
    function invariant_routerHoldsNothing() public view {
        assertEq(tA.balanceOf(address(router)), 0);
        assertEq(tB.balanceOf(address(router)), 0);
        assertEq(tC.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    /// A pool cannot be emptied or bricked: the locked minimum stays, reserves stay positive, and no shares are
    /// stranded in the pool itself.
    function invariant_minimumLiquidityLocked() public view {
        for (uint256 i; i < 3; ++i) {
            assertEq(pools[i].balanceOf(address(0xdEaD)), pools[i].MINIMUM_LIQUIDITY(), "locked shares moved");
            assertGe(pools[i].totalSupply(), pools[i].MINIMUM_LIQUIDITY());
            (uint112 r0, uint112 r1, ) = pools[i].getReserves();
            assertGt(r0, 0, "reserve0 drained");
            assertGt(r1, 0, "reserve1 drained");
            assertEq(pools[i].balanceOf(address(pools[i])), 0, "shares stranded in the pool");
        }
    }

    function _lpHeld(CircleswapPair pool) internal view returns (uint256 sum) {
        sum = pool.balanceOf(address(0xdEaD)) + pool.balanceOf(lp) + pool.balanceOf(handler.feeRecipient());
        for (uint256 i; i < handler.actorCount(); ++i) sum += pool.balanceOf(handler.actors(i));
    }

    function _tokenHeld(MockToken t) internal view returns (uint256 sum) {
        sum = t.balanceOf(lp) + t.balanceOf(address(router)) + t.balanceOf(handler.feeRecipient()) + t.balanceOf(address(handler));
        for (uint256 p; p < 3; ++p) sum += t.balanceOf(address(pools[p]));
        for (uint256 i; i < handler.actorCount(); ++i) sum += t.balanceOf(handler.actors(i));
    }

    /// LP shares add up: every holder's shares sum to the supply.
    function invariant_lpSupplyIsFullyAccounted() public view {
        for (uint256 p; p < 3; ++p) {
            assertEq(_lpHeld(pools[p]), pools[p].totalSupply(), "LP shares unaccounted for");
        }
    }

    /// Value is conserved: every unit of each token is held by a known account (nothing burned, nothing lost
    /// inside the pools or the router).
    function invariant_tokensConserved() public view {
        assertEq(_tokenHeld(tA), tA.totalSupply(), "token A vanished or appeared");
        assertEq(_tokenHeld(tB), tB.totalSupply(), "token B vanished or appeared");
        assertEq(_tokenHeld(tC), tC.totalSupply(), "token C vanished or appeared");
    }
}
