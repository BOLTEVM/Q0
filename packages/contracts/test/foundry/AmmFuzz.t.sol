// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AmmBase.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice Property tests for the pair, router and factory. Every test states the property it defends; a
///         counterexample from the fuzzer is a real input that breaks it.
contract AmmFuzzTest is AmmBase {
    // ------------------------------------------------------------------------------------- swap: exact input

    /// The pool never lets k fall, the trader receives exactly what the router quoted, and a quote of zero
    /// is refused rather than taking the input for nothing.
    function testFuzz_swapExactIn_kNeverFalls_paysQuote(uint256 l0, uint256 l1, uint256 amtIn, bool dir) public {
        l0 = bound(l0, 1e4, 1e30);
        l1 = bound(l1, 1e4, 1e30);
        CircleswapPair pair = _seed(tA, tB, l0, l1);
        (MockToken i, MockToken o) = dir ? (tA, tB) : (tB, tA);
        (uint256 ri, ) = _reserves(i, o);
        amtIn = bound(amtIn, 1, ri * 100);

        i.mint(trader, amtIn);
        _approveRouter(i, trader);
        uint256 quoted = router.getAmountsOut(amtIn, _path2(address(i), address(o)))[1];
        uint256 kBefore = _k(pair);
        uint256 traderBefore = o.balanceOf(trader);

        vm.prank(trader);
        if (quoted == 0) {
            vm.expectRevert();
            router.swapExactTokensForTokens(amtIn, 0, _path2(address(i), address(o)), trader, block.timestamp);
            return;
        }
        router.swapExactTokensForTokens(amtIn, quoted, _path2(address(i), address(o)), trader, block.timestamp);

        assertGe(_k(pair), kBefore, "k fell");
        assertEq(o.balanceOf(trader) - traderBefore, quoted, "trader did not receive the quote");
        assertEq(i.balanceOf(trader), 0, "input not fully spent");
    }

    // ------------------------------------------------------------------------------------ swap: exact output

    /// Exact-output swaps deliver exactly the requested amount, never charge less than the pool needs (k does
    /// not fall), and the input the router asks for really would buy at least that output.
    function testFuzz_swapExactOut_deliversExactly_kNeverFalls(uint256 l0, uint256 l1, uint256 amtOut, bool dir) public {
        l0 = bound(l0, 1e4, 1e30);
        l1 = bound(l1, 1e4, 1e30);
        CircleswapPair pair = _seed(tA, tB, l0, l1);
        (MockToken i, MockToken o) = dir ? (tA, tB) : (tB, tA);
        (uint256 ri, uint256 ro) = _reserves(i, o);
        amtOut = bound(amtOut, 1, ro - 1);

        uint256 need = router.getAmountsIn(amtOut, _path2(address(i), address(o)))[0];
        // Draining almost all of a pool can need more input than a uint112 reserve holds; the pool refuses that
        // on purpose (BalanceOverflow), so it is not a case this property covers.
        vm.assume(need + ri <= type(uint112).max);
        assertGe(router.getAmountOut(need, ri, ro), amtOut, "quoted input does not buy the output");

        i.mint(trader, need);
        _approveRouter(i, trader);
        uint256 kBefore = _k(pair);

        vm.prank(trader);
        router.swapTokensForExactTokens(amtOut, need, _path2(address(i), address(o)), trader, block.timestamp);

        assertEq(o.balanceOf(trader), amtOut, "did not deliver the exact output");
        assertGe(_k(pair), kBefore, "k fell");
    }

    /// Swapping there and straight back never returns more than was put in (the fee and rounding go one way).
    function testFuzz_swapRoundTripNeverProfits(uint256 l0, uint256 l1, uint256 amtIn) public {
        l0 = bound(l0, 1e6, 1e30);
        l1 = bound(l1, 1e6, 1e30);
        _seed(tA, tB, l0, l1);
        amtIn = bound(amtIn, 1e3, l0 * 10);
        tA.mint(trader, amtIn);
        _approveRouter(tA, trader);
        _approveRouter(tB, trader);

        uint256 got = router.getAmountsOut(amtIn, _path2(address(tA), address(tB)))[1];
        if (got == 0) return; // a zero-output swap is refused by the pool; covered by the exact-in test
        vm.startPrank(trader);
        router.swapExactTokensForTokens(amtIn, got, _path2(address(tA), address(tB)), trader, block.timestamp);
        uint256 back = router.getAmountsOut(got, _path2(address(tB), address(tA)))[1];
        if (back != 0) {
            router.swapExactTokensForTokens(got, back, _path2(address(tB), address(tA)), trader, block.timestamp);
        }
        vm.stopPrank();
        back = tA.balanceOf(trader);

        assertLe(back, amtIn, "round trip returned more than it took");
    }

    // ------------------------------------------------------------------------------------------- liquidity

    /// Adding liquidity and removing it in the same block never returns more of either token than was put in.
    function testFuzz_liquidityRoundTripNeverProfits(uint256 l0, uint256 l1, uint256 a0, uint256 a1) public {
        l0 = bound(l0, 1e6, 1e30);
        l1 = bound(l1, 1e6, 1e30);
        CircleswapPair pair = _seed(tA, tB, l0, l1);
        a0 = bound(a0, 1e3, 1e30);
        a1 = bound(a1, 1e3, 1e30);

        address user = makeAddr("user");
        tA.mint(user, a0);
        tB.mint(user, a1);
        _approveRouter(tA, user);
        _approveRouter(tB, user);
        vm.prank(user);
        try router.addLiquidity(address(tA), address(tB), a0, a1, 0, 0, user, block.timestamp) returns (
            uint256, uint256, uint256 shares
        ) {
            vm.startPrank(user);
            pair.approve(address(router), shares);
            try router.removeLiquidity(address(tA), address(tB), shares, 0, 0, user, block.timestamp) {} catch {
                vm.stopPrank();
                return; // dust burn refused: funds stay in the pool as shares, nothing is taken
            }
            vm.stopPrank();
            assertLe(tA.balanceOf(user), a0, "profited in token A");
            assertLe(tB.balanceOf(user), a1, "profited in token B");
        } catch {}
    }

    /// The classic first-depositor inflation attack: the attacker seeds the smallest pool, donates a large
    /// amount to inflate the share price, waits for a victim, then exits. MINIMUM_LIQUIDITY sent to a dead
    /// address makes this cost more than it can win; this asserts the attacker never comes out ahead.
    function testFuzz_inflationAttackIsUnprofitable(uint256 seed, uint256 donation, uint256 victimAmt) public {
        seed = bound(seed, 1001, 1e20); // sqrt(seed*seed) must exceed MINIMUM_LIQUIDITY
        donation = bound(donation, 0, 1e30);
        victimAmt = bound(victimAmt, 1, 1e30);

        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        tA.mint(attacker, seed + donation);
        tB.mint(attacker, seed + donation);
        uint256 spent = 2 * (seed + donation);

        address pairAddr = factory.createPair(address(tA), address(tB));
        CircleswapPair pair = CircleswapPair(pairAddr);
        vm.startPrank(attacker);
        tA.transfer(pairAddr, seed);
        tB.transfer(pairAddr, seed);
        pair.mint(attacker);
        tA.transfer(pairAddr, donation);
        tB.transfer(pairAddr, donation);
        pair.sync();
        vm.stopPrank();

        tA.mint(victim, victimAmt);
        tB.mint(victim, victimAmt);
        _approveRouter(tA, victim);
        _approveRouter(tB, victim);
        vm.prank(victim);
        try router.addLiquidity(address(tA), address(tB), victimAmt, victimAmt, 0, 0, victim, block.timestamp) {}
        catch {
            // The pool refused a deposit that would round to nothing. That is safe: the victim keeps their tokens.
            assertEq(tA.balanceOf(victim), victimAmt, "victim lost funds on a refused deposit");
            return;
        }

        vm.startPrank(attacker);
        uint256 shares = pair.balanceOf(attacker);
        pair.transfer(pairAddr, shares);
        try pair.burn(attacker) {} catch {
            vm.stopPrank();
            return; // burn refused: the attacker cannot exit at all
        }
        vm.stopPrank();

        uint256 out = tA.balanceOf(attacker) + tB.balanceOf(attacker);
        assertLe(out, spent + 2, "attacker profited from the inflation attack");
    }

    /// The same attack aimed at the window where it pays: the smallest legal seed, a large donation, and a victim
    /// whose deposit is a few times the value of one share (so their shares round down the most). Sized relative
    /// to the pool, because a uniform fuzz of the raw amounts almost never lands here.
    function testFuzz_inflationAttackIsUnprofitable_targeted(uint256 extraSeed, uint256 donation, uint256 victimMul)
        public
    {
        uint256 seed = bound(extraSeed, 1001, 5000);
        donation = bound(donation, 1e6, 1e30);
        uint256 sharePrice = (seed + donation) / seed + 1; // tokens per share after the donation
        uint256 victimAmt = sharePrice * bound(victimMul, 1, 6) + bound(victimMul >> 8, 0, sharePrice);

        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        tA.mint(attacker, seed + donation);
        tB.mint(attacker, seed + donation);
        address pairAddr = factory.createPair(address(tA), address(tB));
        CircleswapPair pair = CircleswapPair(pairAddr);
        vm.startPrank(attacker);
        tA.transfer(pairAddr, seed);
        tB.transfer(pairAddr, seed);
        pair.mint(attacker);
        tA.transfer(pairAddr, donation);
        tB.transfer(pairAddr, donation);
        pair.sync();
        vm.stopPrank();

        tA.mint(victim, victimAmt);
        tB.mint(victim, victimAmt);
        _approveRouter(tA, victim);
        _approveRouter(tB, victim);
        vm.prank(victim);
        try router.addLiquidity(address(tA), address(tB), victimAmt, victimAmt, 0, 0, victim, block.timestamp) {}
        catch {
            return; // refused: the victim keeps their tokens
        }

        vm.startPrank(attacker);
        pair.transfer(pairAddr, pair.balanceOf(attacker));
        try pair.burn(attacker) {} catch {
            vm.stopPrank();
            return;
        }
        vm.stopPrank();
        assertLe(tA.balanceOf(attacker) + tB.balanceOf(attacker), 2 * (seed + donation) + 2, "attacker profited");
    }

    /// The many-victims variant, the one that actually depends on MINIMUM_LIQUIDITY. The attacker seeds the
    /// smallest pool and donates so one share costs about V/2; every depositor who brings V then gets exactly one
    /// share (rounded down from almost two) and the attacker, holding the other shares, keeps the difference. With
    /// the locked minimum, the attacker owns too small a slice of the pool to come out ahead; with a minimum of 1
    /// this same sequence pays them roughly half the donation.
    function test_inflationAttackWithManyVictimsIsUnprofitable() public {
        uint256 seed = 1001;
        uint256 donation = 1e21;
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        tA.mint(attacker, seed + donation);
        tB.mint(attacker, seed + donation);

        CircleswapPair pair = CircleswapPair(factory.createPair(address(tA), address(tB)));
        vm.startPrank(attacker);
        tA.transfer(address(pair), seed);
        tB.transfer(address(pair), seed);
        pair.mint(attacker);
        tA.transfer(address(pair), donation);
        tB.transfer(address(pair), donation);
        pair.sync();
        vm.stopPrank();

        uint256 sharePrice = (seed + donation) / seed + 1;
        uint256 victimAmt = sharePrice * 2 - 1; // just under two shares' worth: rounds down to one
        uint256 victims = 1100;
        tA.mint(victim, victimAmt * victims);
        tB.mint(victim, victimAmt * victims);
        for (uint256 i; i < victims; ++i) {
            vm.startPrank(victim);
            tA.transfer(address(pair), victimAmt);
            tB.transfer(address(pair), victimAmt);
            try pair.mint(victim) {} catch {
                // Refused (would mint nothing): the tokens are still in the pool, so take them back out as a skim.
                vm.stopPrank();
                pair.skim(victim);
                vm.startPrank(victim);
            }
            vm.stopPrank();
        }

        vm.startPrank(attacker);
        pair.transfer(address(pair), pair.balanceOf(attacker));
        pair.burn(attacker);
        vm.stopPrank();
        assertLe(tA.balanceOf(attacker) + tB.balanceOf(attacker), 2 * (seed + donation), "attacker profited");
    }

    // -------------------------------------------------------------------------------------- router is stateless

    /// A two-hop swap pays the quoted amount and leaves nothing in the router, in either direction.
    function testFuzz_multiHop_routerKeepsNothing(uint256 l, uint256 amt, bool exactOut) public {
        l = bound(l, 1e6, 1e28);
        _seed(tA, tB, l, l * 2);
        _seed(tB, tC, l * 3, l);
        address[] memory path = _path3(address(tA), address(tB), address(tC));
        _approveRouter(tA, trader);

        if (exactOut) {
            (, uint256 rcOut) = _reserves(tB, tC);
            amt = bound(amt, 1, rcOut / 2);
            uint256[] memory a;
            // The first pool may be too shallow to supply what the second hop needs; that is a clean revert.
            try router.getAmountsIn(amt, path) returns (uint256[] memory quoted) {
                a = quoted;
            } catch {
                return;
            }
            (uint256 rIn, ) = _reserves(tA, tB);
            vm.assume(a[0] + rIn <= type(uint112).max);
            tA.mint(trader, a[0]);
            vm.prank(trader);
            router.swapTokensForExactTokens(amt, a[0], path, trader, block.timestamp);
            assertEq(tC.balanceOf(trader), amt);
        } else {
            amt = bound(amt, 1e3, l);
            uint256[] memory a = router.getAmountsOut(amt, path);
            if (a[2] == 0) return;
            tA.mint(trader, amt);
            vm.prank(trader);
            router.swapExactTokensForTokens(amt, a[2], path, trader, block.timestamp);
            assertEq(tC.balanceOf(trader), a[2]);
        }
        assertEq(tA.balanceOf(address(router)), 0, "router kept token A");
        assertEq(tB.balanceOf(address(router)), 0, "router kept token B");
        assertEq(tC.balanceOf(address(router)), 0, "router kept token C");
        assertEq(address(router).balance, 0, "router kept native");
    }

    /// Native QUAI: exact-output buys refund the unused value exactly, sells pay the quote, and the router is
    /// left holding no value.
    function testFuzz_native_refundsAndSettles(uint256 l, uint256 amtOut, uint256 extra) public {
        l = bound(l, 1e6, 1e24);
        tA.mint(lp, l * 2);
        vm.deal(lp, l);
        _approveRouter(tA, lp);
        vm.prank(lp);
        router.addLiquidityETH{value: l}(address(tA), l * 2, 0, 0, lp, block.timestamp);

        (, uint256 reserveA) = _reserves(MockToken(address(wquai)), tA);
        amtOut = bound(amtOut, 1, reserveA / 2);
        extra = bound(extra, 0, 1e24);
        address[] memory buy = _path2(address(wquai), address(tA));
        uint256 need = router.getAmountsIn(amtOut, buy)[0];
        vm.deal(trader, need + extra);
        vm.prank(trader);
        router.swapETHForExactTokens{value: need + extra}(amtOut, buy, trader, block.timestamp);
        assertEq(trader.balance, extra, "unused native was not refunded exactly");
        assertEq(tA.balanceOf(trader), amtOut);

        address[] memory sell = _path2(address(tA), address(wquai));
        uint256 quoted = router.getAmountsOut(amtOut, sell)[1];
        if (quoted != 0) {
            _approveRouter(tA, trader);
            uint256 nativeBefore = trader.balance;
            vm.prank(trader);
            router.swapExactTokensForETH(amtOut, quoted, sell, trader, block.timestamp);
            assertEq(trader.balance - nativeBefore, quoted, "sell did not pay the quote");
        }
        assertEq(address(router).balance, 0, "router kept native");
        assertEq(tA.balanceOf(address(router)), 0, "router kept tokens");
        assertEq(wquai.balanceOf(address(router)), 0, "router kept WQUAI");
    }

    // ------------------------------------------------------------------------------------------------- flash

    /// A flash swap must repay principal plus the 0.3% fee; anything less reverts the whole call, and a proper
    /// repayment grows k.
    function testFuzz_flashSwap_needsRepayment(uint256 l, uint256 borrow) public {
        l = bound(l, 1e6, 1e28);
        CircleswapPair pair = _seed(tA, tB, l, l);
        borrow = bound(borrow, 1e3, l / 2);
        FlashCallee callee = new FlashCallee();
        tA.mint(address(callee), borrow); // enough to cover the fee

        (uint256 amount0, uint256 amount1) = address(tA) < address(tB) ? (borrow, uint256(0)) : (uint256(0), borrow);

        vm.expectRevert();
        callee.run(address(pair), amount0, amount1, FlashCallee.Mode.REPAY_TOO_LITTLE);
        vm.expectRevert();
        callee.run(address(pair), amount0, amount1, FlashCallee.Mode.NO_REPAY);

        uint256 kBefore = _k(pair);
        callee.run(address(pair), amount0, amount1, FlashCallee.Mode.REPAY_WITH_FEE);
        assertGt(_k(pair), kBefore, "a repaid flash swap must grow k");
    }

    // -------------------------------------------------------------------------------------- factory and clones

    function testFuzz_createPair_symmetricAndUnique(bool flip) public {
        (address x, address y) = flip ? (address(tA), address(tB)) : (address(tB), address(tA));
        address pair = factory.createPair(x, y);
        assertEq(factory.getPair(x, y), pair);
        assertEq(factory.getPair(y, x), pair);
        assertEq(factory.allPairsLength(), 1);

        vm.expectRevert(CircleswapFactory.PairExists.selector);
        factory.createPair(x, y);
        vm.expectRevert(CircleswapFactory.PairExists.selector);
        factory.createPair(y, x);
        vm.expectRevert(CircleswapFactory.IdenticalAddresses.selector);
        factory.createPair(x, x);
    }

    function test_createPair_refusesNonContractsAndZero() public {
        vm.expectRevert(CircleswapFactory.ZeroAddress.selector);
        factory.createPair(address(0), address(tA));
        vm.expectRevert(CircleswapFactory.InvalidToken.selector);
        factory.createPair(makeAddr("eoa"), address(tA));
    }

    /// The implementation cannot be initialised or used, and a clone cannot be initialised twice.
    function test_pairImplementationIsLocked_cloneInitialisesOnce() public {
        CircleswapPair impl = CircleswapPair(factory.pairImplementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(tA), address(tB));
        vm.expectRevert(); // token0 is unset on the implementation: nothing to read balances from
        impl.mint(address(this));

        address pair = factory.createPair(address(tA), address(tB));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        CircleswapPair(pair).initialize(address(tC), address(tB));
    }

    function test_feeToIsOwnerOnly_andOwnershipIsTwoStep() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert();
        factory.setFeeTo(rando);

        factory.transferOwnership(rando);
        assertEq(factory.owner(), address(this), "ownership moved before acceptance");
        vm.prank(rando);
        factory.acceptOwnership();
        assertEq(factory.owner(), rando);
    }

    /// LP-token permits work on a clone, bind to that clone's address, and cannot be replayed on another pool.
    function testFuzz_permit_worksOnCloneAndCannotCrossPools(uint256 pk, uint256 value) public {
        pk = bound(pk, 1, 1e30);
        address owner_ = vm.addr(pk);
        address spender = makeAddr("spender");
        CircleswapPair p1 = CircleswapPair(factory.createPair(address(tA), address(tB)));
        CircleswapPair p2 = CircleswapPair(factory.createPair(address(tA), address(tC)));
        assertTrue(p1.DOMAIN_SEPARATOR() != p2.DOMAIN_SEPARATOR(), "clones share a domain separator");

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner_,
                spender,
                value,
                p1.nonces(owner_),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", p1.DOMAIN_SEPARATOR(), structHash)));

        vm.expectRevert(); // same signature on the other pool: wrong domain
        p2.permit(owner_, spender, value, deadline, v, r, s);

        p1.permit(owner_, spender, value, deadline, v, r, s);
        assertEq(p1.allowance(owner_, spender), value);
        assertEq(p1.nonces(owner_), 1);
        vm.expectRevert(); // replay
        p1.permit(owner_, spender, value, deadline, v, r, s);
    }
}
