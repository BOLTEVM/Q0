// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import "../../contracts/Qrb.sol";
import "../../contracts/libraries/ArweaveURI.sol";
import "../../contracts/libraries/QrbFormat.sol";

string constant ART = "ar://abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP_";

/// @notice The Qrb boost is only worth having if it cannot be borrowed: these tests try to borrow it.
contract QrbBoostTest is Test {
    Qrb internal qrb;
    address internal holder = makeAddr("holder");
    uint256 internal thr;
    uint256 internal maturity;

    function setUp() public {
        qrb = new Qrb(address(this), ART);
        qrb.mintGenesis(holder);
        thr = qrb.BOOST_THRESHOLD();
        maturity = qrb.BOOST_MATURITY();
    }

    /// A flash-borrowed balance never carries a boost: receive it, check, hand it back, all in one block.
    function testFuzz_borrowedBalanceNeverBoosts(uint256 amount) public {
        amount = bound(amount, thr, 1e18);
        address borrower = makeAddr("borrower");
        vm.prank(holder);
        qrb.transfer(borrower, amount);
        assertEq(qrb.boostBpsOf(borrower), 0, "boost paid on a balance held for zero seconds");
        vm.prank(borrower);
        qrb.transfer(holder, amount);
        assertEq(qrb.boostBpsOf(borrower), 0);
        assertEq(qrb.boostEligibleAt(borrower), 0, "clock still running after the balance was returned");
    }

    /// The boost switches on at exactly `maturity` seconds after the balance reached the threshold.
    function testFuzz_boostStartsExactlyAtMaturity(uint256 amount, uint256 early) public {
        amount = bound(amount, thr, 1e18);
        early = bound(early, 1, maturity);
        address a = makeAddr("a");
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(holder);
        qrb.transfer(a, amount);

        vm.warp(t0 + maturity - early);
        assertEq(qrb.boostBpsOf(a), 0, "boost before maturity");
        vm.warp(t0 + maturity);
        assertEq(qrb.boostBpsOf(a), qrb.BOOST_BPS(), "no boost at maturity");
        assertEq(qrb.boostEligibleAt(a), t0 + maturity);
    }

    /// Dipping below the threshold, even for one transaction, restarts the whole wait; topping up does not.
    function testFuzz_dipResetsClock_topUpDoesNot(uint256 extra) public {
        extra = bound(extra, 1, 1e17);
        address a = makeAddr("a");
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(holder);
        qrb.transfer(a, thr);
        vm.warp(t0 + maturity / 2);

        vm.prank(holder);
        qrb.transfer(a, extra); // top-up
        vm.warp(t0 + maturity);
        assertEq(qrb.boostBpsOf(a), qrb.BOOST_BPS(), "a top-up restarted the clock");

        vm.prank(a);
        qrb.transfer(holder, 1); // still >= threshold: harmless
        assertEq(qrb.boostBpsOf(a), qrb.BOOST_BPS());

        vm.startPrank(a);
        qrb.transfer(holder, qrb.balanceOf(a)); // empties: below threshold
        vm.stopPrank();
        assertEq(qrb.boostBpsOf(a), 0);
        vm.prank(holder);
        qrb.transfer(a, thr);
        assertEq(qrb.boostBpsOf(a), 0, "clock survived a full exit");
        assertEq(qrb.boostEligibleAt(a), vm.getBlockTimestamp() + maturity);
    }

    /// Nobody can reset or start someone else's clock by sending them tokens or dust.
    function testFuzz_strangerCannotResetClock(uint256 dust) public {
        dust = bound(dust, 1, thr); // the stranger holds exactly `thr`
        address a = makeAddr("a");
        address stranger = makeAddr("stranger");
        vm.prank(holder);
        qrb.transfer(a, thr);
        uint256 eligible = qrb.boostEligibleAt(a);
        vm.prank(holder);
        qrb.transfer(stranger, thr);
        vm.prank(stranger);
        qrb.transfer(a, dust);
        assertEq(qrb.boostEligibleAt(a), eligible, "incoming dust moved the clock");
    }

    /// Anything that can still be transferred stays inside the fixed supply.
    function test_supplyIsFixedAndMintIsOnce() public {
        assertEq(qrb.totalSupply(), 1e18);
        vm.expectRevert(Qrb.MaxSupplyReached.selector);
        qrb.mintGenesis(holder);
        vm.prank(holder);
        qrb.burn(1e18);
        assertEq(qrb.totalSupply(), 0);
        vm.expectRevert(Qrb.MaxSupplyReached.selector); // burning does not reopen the mint
        qrb.mintGenesis(holder);
    }
}

/// @dev Random transfers, burns and time jumps around the threshold, with a ghost model of who is eligible that
///      is built only from observed balances (not from the contract's own storage).
contract QrbHandler is Test {
    Qrb public immutable qrb;
    address[] public actors;
    mapping(address => uint256) public lastRise; // last time the balance rose from below the threshold to it

    constructor(Qrb qrb_, address firstHolder) {
        qrb = qrb_;
        actors.push(firstHolder);
        for (uint256 i = 1; i < 4; ++i) actors.push(makeAddr(string.concat("q", vm.toString(i))));
        lastRise[firstHolder] = vm.getBlockTimestamp(); // genesis mint
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _amount(address from, uint256 mode, uint256 seed) internal view returns (uint256) {
        uint256 bal = qrb.balanceOf(from);
        uint256 thr = qrb.BOOST_THRESHOLD();
        mode %= 5;
        if (mode == 0) return thr > bal ? bal : thr;
        if (mode == 1) return thr == 0 || bal < thr - 1 ? bal : thr - 1;
        if (mode == 2) return bal;
        if (mode == 3) return bal / 2;
        return bound(seed, 0, bal);
    }

    function _observe(address who, bool wasAbove) internal {
        bool isAbove = qrb.balanceOf(who) >= qrb.BOOST_THRESHOLD();
        if (!wasAbove && isAbove) lastRise[who] = vm.getBlockTimestamp();
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 mode, uint256 seed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 amount = _amount(from, mode, seed);
        bool fromWas = qrb.balanceOf(from) >= qrb.BOOST_THRESHOLD();
        bool toWas = qrb.balanceOf(to) >= qrb.BOOST_THRESHOLD();
        vm.prank(from);
        qrb.transfer(to, amount);
        _observe(from, fromWas);
        if (to != from) _observe(to, toWas);
    }

    function burn(uint256 fromSeed, uint256 mode, uint256 seed) external {
        address from = actors[fromSeed % actors.length];
        uint256 amount = _amount(from, mode, seed);
        bool was = qrb.balanceOf(from) >= qrb.BOOST_THRESHOLD();
        vm.prank(from);
        qrb.burn(amount);
        _observe(from, was);
    }

    function warp(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 2 days));
    }
}

contract QrbBoostInvariantTest is Test {
    Qrb internal qrb;
    QrbHandler internal handler;

    function setUp() public {
        qrb = new Qrb(address(this), ART);
        address first = makeAddr("first");
        qrb.mintGenesis(first);
        handler = new QrbHandler(qrb, first);
        targetContract(address(handler));
    }

    /// Boost is paid exactly to accounts that hold the threshold now and have held it, unbroken, for the
    /// maturity: no earlier (nobody borrows it) and no later (nobody is locked out).
    function invariant_boostMatchesContinuousHolding() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            bool above = qrb.balanceOf(a) >= qrb.BOOST_THRESHOLD();
            bool matured = above && vm.getBlockTimestamp() >= handler.lastRise(a) + qrb.BOOST_MATURITY();
            assertEq(qrb.boostBpsOf(a), matured ? qrb.BOOST_BPS() : 0, "boost disagrees with the holding history");
            assertEq(qrb.boostEligibleAt(a) != 0, above, "clock running iff at or above the threshold");
        }
    }

    function invariant_supplyNeverExceedsMax() public view {
        assertLe(qrb.totalSupply(), qrb.MAX_SUPPLY());
    }
}

contract UriHarness {
    function valid(string memory s) external pure returns (bool) {
        return ArweaveURI.isValid(s);
    }
    function pct(uint256 v) external pure returns (string memory) {
        return QrbFormat.pct(v);
    }
    function amount18(uint256 v) external pure returns (string memory) {
        return QrbFormat.amount18(v);
    }
    function duration(uint256 v) external pure returns (string memory) {
        return QrbFormat.duration(v);
    }
}

contract QrbLibrariesFuzzTest is Test {
    UriHarness internal h = new UriHarness();
    bytes internal constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    function _txid(uint256 seed, uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            b[i] = ALPHABET[seed % 64];
        }
    }

    /// Never reverts on arbitrary input, whatever the string.
    function testFuzz_isValid_neverReverts(string memory s) public view {
        h.valid(s);
    }

    /// Every well-formed URI is accepted, in both accepted spellings.
    function testFuzz_isValid_acceptsWellFormed(uint256 seed, bool https) public view {
        bytes memory id = _txid(seed, 43);
        assertTrue(h.valid(string.concat(https ? "https://arweave.net/" : "ar://", string(id))));
    }

    /// One bad character anywhere in the id, or a wrong length, is refused. Characters that would break the
    /// JSON the contracts build ('"', '\', control bytes, non-ASCII) are all outside the alphabet.
    function testFuzz_isValid_rejectsAnyBadByteOrLength(uint256 seed, uint256 pos, uint8 bad, uint256 badLen) public view {
        bytes memory id = _txid(seed, 43);
        pos = bound(pos, 0, 42);
        bool inAlphabet;
        for (uint256 i; i < 64; ++i) {
            if (ALPHABET[i] == bytes1(bad)) inAlphabet = true;
        }
        if (!inAlphabet) {
            bytes memory broken = id;
            broken[pos] = bytes1(bad);
            assertFalse(h.valid(string.concat("ar://", string(broken))), "accepted a byte outside the alphabet");
        }
        badLen = bound(badLen, 0, 100);
        if (badLen != 43) {
            assertFalse(h.valid(string.concat("ar://", string(_txid(seed, badLen)))), "accepted a wrong-length id");
        }
    }

    function test_isValid_rejectsOtherHostsAndSchemes() public view {
        string memory id = string(_txid(1, 43));
        assertFalse(h.valid(string.concat("http://arweave.net/", id)));
        assertFalse(h.valid(string.concat("https://arweave.net.evil.com/", id)));
        assertFalse(h.valid(string.concat("https://arweave.net//", id)));
        assertFalse(h.valid(string.concat("ipfs://", id)));
        assertFalse(h.valid(string.concat(" ar://", id)));
        assertFalse(h.valid(string.concat("ar://", id, "\n")));
        assertFalse(h.valid(""));
    }

    /// amount18 round-trips: reading the decimal string back gives the number it came from, with no trailing
    /// zeros or dangling point.
    function testFuzz_amount18_roundTrips(uint256 v) public view {
        v = bound(v, 0, type(uint128).max);
        string memory s = h.amount18(v);
        bytes memory b = bytes(s);
        assertTrue(b[b.length - 1] != "." && (b.length == 1 || b[b.length - 1] != "0" || _hasNoPoint(b)), "untrimmed");
        assertEq(_parse18(b), v, "amount18 did not round-trip");
    }

    /// pct round-trips in basis points.
    function testFuzz_pct_roundTrips(uint256 bps) public view {
        bps = bound(bps, 0, 100_000_000);
        bytes memory b = bytes(h.pct(bps));
        assertEq(b[b.length - 1], bytes1("%"));
        bytes memory body = new bytes(b.length - 1);
        for (uint256 i; i < body.length; ++i) body[i] = b[i];
        // parse as a decimal with 2 fractional digits => value in bps
        assertEq(_parseDecimal(body, 2), bps, "pct did not round-trip");
    }

    function testFuzz_duration_wholeDays(uint256 n) public view {
        n = bound(n, 1, 1e6);
        assertEq(h.duration(n * 1 days), string.concat(vm.toString(n), n == 1 ? " day" : " days"));
    }

    // ------------------------------------------------------------------------------------------ parsing helpers

    function _hasNoPoint(bytes memory b) internal pure returns (bool) {
        for (uint256 i; i < b.length; ++i) if (b[i] == ".") return false;
        return true;
    }

    function _parse18(bytes memory b) internal pure returns (uint256) {
        return _parseDecimal(b, 18);
    }

    /// @dev Parses "123" / "123.45" into an integer scaled by 10**decimals; reverts on any other shape.
    function _parseDecimal(bytes memory b, uint256 decimals) internal pure returns (uint256 out) {
        uint256 i;
        for (; i < b.length && b[i] != "."; ++i) {
            require(b[i] >= "0" && b[i] <= "9", "bad digit");
            out = out * 10 + (uint8(b[i]) - 48);
        }
        out *= 10 ** decimals;
        if (i < b.length) {
            ++i;
            uint256 frac = b.length - i;
            require(frac > 0 && frac <= decimals, "bad fraction");
            uint256 place = decimals;
            for (; i < b.length; ++i) {
                require(b[i] >= "0" && b[i] <= "9", "bad digit");
                place--;
                out += (uint8(b[i]) - 48) * 10 ** place;
            }
        }
    }
}
