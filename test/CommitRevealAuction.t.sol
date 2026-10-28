// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommitRevealAuction} from "../src/CommitRevealAuction.sol";

/// @dev Re-declare contract events so vm.expectEmit can match them.
event AuctionCreated(address indexed seller, uint256 commitDeadline, uint256 revealDeadline);
event BidCommitted(address indexed bidder, bytes32 commitmentHash);
event BidRevealed(address indexed bidder, uint256 bidAmount);
event AuctionSettled(address indexed winner, uint256 winningBid, bool hasWinner);
event AuctionCanceled();
event BidRefunded(address indexed bidder, uint256 amount);
event Withdrawal(address indexed account, uint256 amount);

/// @dev Bids from a contract that re-enters refund() while being refunded.
contract RefundReenterer {
    CommitRevealAuction public auction;
    bool public reentrySucceeded;

    constructor(CommitRevealAuction a) {
        auction = a;
    }

    function commitBid(bytes32 h) external payable {
        auction.commit{value: msg.value}(h);
    }

    function doRefund() external {
        auction.refund();
    }

    receive() external payable {
        try auction.refund() {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}

/// @dev Bids from a contract that can reject ETH and re-enter withdraw().
contract WithdrawTester {
    CommitRevealAuction public auction;
    bool public rejectEth = true;
    bool public reentrySucceeded;

    constructor(CommitRevealAuction a) {
        auction = a;
    }

    function commitBid(bytes32 h) external payable {
        auction.commit{value: msg.value}(h);
    }

    function doReveal(uint256 bidAmount, uint256 nonce) external {
        auction.reveal(bidAmount, nonce);
    }

    function doWithdraw() external {
        auction.withdraw();
    }

    function setRejectEth(bool v) external {
        rejectEth = v;
    }

    receive() external payable {
        if (rejectEth) revert("no deposits");
        try auction.withdraw() {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}

contract CommitRevealAuctionTest is Test {
    uint256 internal constant COMMIT_DURATION = 100;
    uint256 internal constant REVEAL_DURATION = 100;

    CommitRevealAuction internal auction;
    address internal seller;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public {
        seller = makeAddr("seller");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        vm.deal(seller, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(address(this), 100 ether);

        vm.prank(seller);
        auction = new CommitRevealAuction(COMMIT_DURATION, REVEAL_DURATION);
    }

    // ---------------------------------------------------------------------
    // Helpers — invariants
    // ---------------------------------------------------------------------

    function _actors5() internal view returns (address[] memory a) {
        a = new address[](5);
        a[0] = seller;
        a[1] = alice;
        a[2] = bob;
        a[3] = carol;
        a[4] = address(this);
    }

    function _sumEscrow(address[] memory actors) internal view returns (uint256 s) {
        for (uint256 i = 0; i < actors.length; ++i) {
            s += auction.bidderDeposits(actors[i]);
        }
    }

    function _sumClaims(address[] memory actors) internal view returns (uint256 s) {
        for (uint256 i = 0; i < actors.length; ++i) {
            s += auction.withdrawable(actors[i]);
        }
    }

    /// @dev I1: balance covers all claims (equality when no force-fed ETH).
    function _assertSolvency() internal view {
        assertGe(address(auction).balance, auction.totalDeposits(), "I1: balance < totalDeposits");
    }

    /// @dev I1 + I2: while the auction is active, balance == totalDeposits
    ///      == sum of raw escrow entries.
    function _assertActive(address[] memory actors) internal view {
        assertEq(address(auction).balance, auction.totalDeposits(), "I1: balance != totalDeposits");
        assertEq(_sumEscrow(actors), auction.totalDeposits(), "I2: escrow sum != totalDeposits");
    }

    /// @dev I1 + I3: once settled/canceled, totalDeposits == sum of claims.
    function _assertClaims(address[] memory actors) internal view {
        _assertSolvency();
        assertEq(_sumClaims(actors), auction.totalDeposits(), "I3: claim sum != totalDeposits");
    }

    function _hash(address bidder, uint256 amount, uint256 nonce) internal view returns (bytes32) {
        return auction.computeCommitmentHash(bidder, amount, nonce);
    }

    function _commit(address bidder, uint256 amount, uint256 nonce) internal {
        bytes32 h = _hash(bidder, amount, nonce);
        vm.prank(bidder);
        auction.commit{value: amount}(h);
    }

    function _reveal(address bidder, uint256 amount, uint256 nonce) internal {
        vm.prank(bidder);
        auction.reveal(amount, nonce);
    }

    // ---------------------------------------------------------------------
    // Constructor / phases
    // ---------------------------------------------------------------------

    function test_ConstructorSetsSellerAndDeadlines() public view {
        assertEq(auction.seller(), seller, "seller");
        assertEq(auction.commitDeadline(), block.timestamp + COMMIT_DURATION, "commitDeadline");
        assertEq(auction.revealDeadline(), auction.commitDeadline() + REVEAL_DURATION, "revealDeadline");
        assertEq(auction.phase(), auction.PHASE_COMMIT(), "initial phase");
    }

    function test_ConstructorRejectsShortPhases() public {
        vm.expectRevert("Commit phase too short");
        new CommitRevealAuction(59, REVEAL_DURATION);

        vm.expectRevert("Reveal phase too short");
        new CommitRevealAuction(COMMIT_DURATION, 59);
    }

    function test_ConstructorEmitsAuctionCreated() public {
        uint256 cd = block.timestamp + COMMIT_DURATION;
        uint256 rd = cd + REVEAL_DURATION;
        vm.expectEmit(true, false, false, true);
        emit AuctionCreated(seller, cd, rd);
        vm.prank(seller);
        new CommitRevealAuction(COMMIT_DURATION, REVEAL_DURATION);
    }

    function test_PhaseTransitions() public {
        assertEq(auction.phase(), auction.PHASE_COMMIT());
        vm.warp(auction.commitDeadline());
        assertEq(auction.phase(), auction.PHASE_REVEAL());
        vm.warp(auction.revealDeadline());
        assertEq(auction.phase(), auction.PHASE_SETTLE());
        auction.settle();
        assertEq(auction.phase(), auction.PHASE_ENDED());
    }

    // ---------------------------------------------------------------------
    // Commit
    // ---------------------------------------------------------------------

    function test_CommitEscrowsValueAndStoresHash() public {
        bytes32 h = _hash(alice, 1 ether, 42);
        vm.expectEmit(true, false, false, true);
        emit BidCommitted(alice, h);
        _commit(alice, 1 ether, 42);

        assertEq(auction.commitmentHash(alice), h, "hash stored");
        assertEq(auction.bidderDeposits(alice), 1 ether, "escrow");
        assertEq(auction.totalDeposits(), 1 ether, "totalDeposits");
        assertEq(address(auction).balance, 1 ether, "balance");
        _assertActive(_actors5());
    }

    function test_CommitRejectsDuplicateCommitment() public {
        _commit(alice, 1 ether, 42);
        bytes32 h2 = _hash(alice, 2 ether, 43);
        vm.prank(alice);
        vm.expectRevert("Active commitment exists");
        auction.commit{value: 2 ether}(h2);
        _assertActive(_actors5());
    }

    function test_CommitRejectsZeroValue() public {
        bytes32 h = _hash(alice, 0, 42);
        vm.prank(alice);
        vm.expectRevert("Empty bid");
        auction.commit{value: 0}(h);
    }

    function test_CommitRejectsZeroHash() public {
        vm.prank(alice);
        vm.expectRevert("Invalid commitment");
        auction.commit{value: 1 ether}(bytes32(0));
    }

    function test_CommitAllowedUntilCommitDeadline() public {
        vm.warp(auction.commitDeadline() - 1);
        _commit(alice, 1 ether, 42);
        assertEq(auction.bidderDeposits(alice), 1 ether);
        _assertActive(_actors5());
    }

    function test_CommitRevertsAtCommitDeadline() public {
        vm.warp(auction.commitDeadline());
        bytes32 h = _hash(alice, 1 ether, 42);
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.commit{value: 1 ether}(h);
    }

    function test_CommitRevertsAfterCancel() public {
        vm.prank(seller);
        auction.cancel();
        bytes32 h = _hash(alice, 1 ether, 42);
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.commit{value: 1 ether}(h);
    }

    // ---------------------------------------------------------------------
    // Early refund
    // ---------------------------------------------------------------------

    function test_RefundClearsCommitmentAndAccounting() public {
        _commit(alice, 1 ether, 42);
        uint256 before = alice.balance;

        vm.expectEmit(true, false, false, true);
        emit BidRefunded(alice, 1 ether);
        vm.prank(alice);
        auction.refund();

        assertEq(auction.commitmentHash(alice), bytes32(0), "hash cleared");
        assertEq(auction.bidderDeposits(alice), 0, "escrow cleared");
        assertEq(auction.totalDeposits(), 0, "totalDeposits cleared");
        assertEq(address(auction).balance, 0, "balance returned");
        assertEq(alice.balance, before + 1 ether, "bidder paid");
        _assertActive(_actors5());
    }

    function test_RefundRevertsWithoutCommitment() public {
        vm.prank(alice);
        vm.expectRevert("No active commitment");
        auction.refund();
    }

    function test_RefundRevertsAtCommitDeadline() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.refund();
    }

    function test_RevealAfterRefundReverts() public {
        _commit(alice, 1 ether, 42);
        vm.prank(alice);
        auction.refund();
        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("No active commitment");
        auction.reveal(1 ether, 42);
    }

    function test_ReCommitAfterRefundSucceeds() public {
        _commit(alice, 1 ether, 42);
        vm.prank(alice);
        auction.refund();

        _commit(alice, 2 ether, 43);
        assertEq(auction.commitmentHash(alice), _hash(alice, 2 ether, 43), "new hash stored");
        assertEq(auction.bidderDeposits(alice), 2 ether, "new escrow");
        assertEq(auction.totalDeposits(), 2 ether, "totals after replacement");
        _assertActive(_actors5());
    }

    function test_RefundReentrancyBlocked() public {
        RefundReenterer reenterer = new RefundReenterer(auction);
        vm.deal(address(reenterer), 0);
        bytes32 h = auction.computeCommitmentHash(address(reenterer), 1 ether, 7);
        reenterer.commitBid{value: 1 ether}(h);
        assertEq(auction.totalDeposits(), 1 ether);

        reenterer.doRefund();

        assertFalse(reenterer.reentrySucceeded(), "reentrant refund must fail");
        assertEq(auction.commitmentHash(address(reenterer)), bytes32(0));
        assertEq(auction.bidderDeposits(address(reenterer)), 0);
        assertEq(auction.totalDeposits(), 0);
        assertEq(address(auction).balance, 0);
        assertEq(address(reenterer).balance, 1 ether, "single payout");
    }

    // ---------------------------------------------------------------------
    // Cancel
    // ---------------------------------------------------------------------

    function test_CancelSellerOnly() public {
        vm.prank(alice);
        vm.expectRevert("Seller only");
        auction.cancel();
    }

    function test_CancelRevertsInRevealPhase() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        vm.prank(seller);
        vm.expectRevert("Wrong phase");
        auction.cancel();
    }

    function test_CancelWithCommitmentsAllowsFullWithdrawals() public {
        _commit(alice, 1 ether, 42);
        _commit(seller, 0.5 ether, 43);

        vm.expectEmit(false, false, false, true);
        emit AuctionCanceled();
        vm.prank(seller);
        auction.cancel();
        assertEq(auction.phase(), auction.PHASE_ENDED());

        address[] memory actors = _actors5();
        _assertClaims(actors);

        assertEq(auction.withdrawable(alice), 1 ether);
        assertEq(auction.withdrawable(seller), 0.5 ether);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        auction.withdraw();
        assertEq(alice.balance, aliceBefore + 1 ether);
        _assertClaims(actors);

        vm.prank(seller);
        auction.withdraw();
        assertEq(address(auction).balance, 0);
        _assertClaims(actors);

        // Ended phase blocks every other operation.
        bytes32 h = _hash(bob, 1 ether, 1);
        vm.prank(bob);
        vm.expectRevert("Wrong phase");
        auction.commit{value: 1 ether}(h);

        vm.warp(auction.revealDeadline());
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.reveal(1 ether, 42);

        vm.expectRevert("Wrong phase");
        auction.settle();

        vm.prank(seller);
        vm.expectRevert("Wrong phase");
        auction.cancel();
    }

    function test_CancelWithoutBids() public {
        vm.prank(seller);
        auction.cancel();
        assertTrue(auction.canceled());
        assertEq(auction.withdrawable(seller), 0);
        _assertClaims(_actors5());
    }

    // ---------------------------------------------------------------------
    // Reveal
    // ---------------------------------------------------------------------

    function test_RevealBeforeCommitDeadlineReverts() public {
        _commit(alice, 1 ether, 42);
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.reveal(1 ether, 42);
    }

    function test_RevealSetsWinnerAndAccounting() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());

        vm.expectEmit(true, false, false, true);
        emit BidRevealed(alice, 1 ether);
        _reveal(alice, 1 ether, 42);

        assertTrue(auction.revealed(alice));
        assertEq(auction.commitmentHash(alice), bytes32(0), "hash consumed");
        assertEq(auction.revealedDepositsTotal(), 1 ether);
        assertEq(auction.highestBid(), 1 ether);
        assertEq(auction.highestBidder(), alice);
        assertEq(auction.winnerRevealTime(), auction.commitDeadline());
        _assertActive(_actors5());
    }

    function test_RevealRevertsAtRevealDeadline() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.revealDeadline());
        vm.prank(alice);
        vm.expectRevert("Wrong phase");
        auction.reveal(1 ether, 42);
    }

    function test_RevealRejectsWrongNonce() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("Commitment mismatch");
        auction.reveal(1 ether, 43);
    }

    function test_RevealRejectsWrongAmount() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("Commitment mismatch");
        auction.reveal(2 ether, 42);
    }

    function test_RevealWithoutCommitmentReverts() public {
        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("No active commitment");
        auction.reveal(1 ether, 42);
    }

    function test_DoubleRevealReverts() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        vm.prank(alice);
        vm.expectRevert("Already revealed");
        auction.reveal(1 ether, 42);
    }

    function test_RevealRequiresEscrowToEqualBid() public {
        // Hash commits to 5 ETH but only 1 ETH is escrowed: hash passes,
        // solvency check rejects the reveal.
        bytes32 h = _hash(alice, 5 ether, 77);
        vm.prank(alice);
        auction.commit{value: 1 ether}(h);

        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("Bid must equal escrow");
        auction.reveal(5 ether, 77);
        _assertActive(_actors5());
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function test_SettleRevertsBeforeRevealDeadline() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        vm.warp(auction.revealDeadline() - 1);
        vm.expectRevert("Wrong phase");
        auction.settle();
    }

    function test_SettleFullSettlementWinnerLosersForfeits() public {
        _commit(alice, 1 ether, 42);
        _commit(bob, 2 ether, 43);
        _commit(carol, 3 ether, 44);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        _reveal(bob, 2 ether, 43);
        // carol never reveals -> forfeited
        vm.warp(auction.revealDeadline());

        vm.expectEmit(true, false, false, true);
        emit AuctionSettled(bob, 2 ether, true);
        auction.settle();

        assertTrue(auction.settled());
        assertEq(auction.sellerProceeds(), 5 ether, "winning bid + forfeits");
        assertEq(auction.withdrawable(bob), 0, "winner escrow fully consumed");
        assertEq(auction.withdrawable(alice), 1 ether, "loser refunded");
        assertEq(auction.withdrawable(carol), 0, "unrevealed forfeited");
        assertEq(auction.withdrawable(seller), 5 ether, "seller proceeds");
        _assertClaims(_actors5());

        // double settle blocked
        vm.expectRevert("Wrong phase");
        auction.settle();

        // winner and forfeited cannot withdraw
        vm.prank(bob);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();
        vm.prank(carol);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();

        // pull payouts
        uint256 sellerBefore = seller.balance;
        vm.prank(seller);
        auction.withdraw();
        assertEq(seller.balance, sellerBefore + 5 ether);
        _assertClaims(_actors5());

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        auction.withdraw();
        assertEq(alice.balance, aliceBefore + 1 ether);

        assertEq(address(auction).balance, 0, "fully drained");
        assertEq(auction.totalDeposits(), 0);
        _assertClaims(_actors5());
    }

    function test_ZeroRevealSettlement() public {
        _commit(alice, 1 ether, 42);
        _commit(bob, 2 ether, 43);
        vm.warp(auction.revealDeadline());

        vm.expectEmit(true, false, false, true);
        emit AuctionSettled(address(0), 0, false);
        auction.settle();

        assertEq(auction.sellerProceeds(), 0, "no proceeds");
        assertEq(auction.withdrawable(alice), 1 ether, "full reclaim");
        assertEq(auction.withdrawable(bob), 2 ether, "full reclaim");
        assertEq(auction.withdrawable(seller), 0);
        _assertClaims(_actors5());

        vm.prank(alice);
        auction.withdraw();
        _assertClaims(_actors5());
        vm.prank(bob);
        auction.withdraw();
        assertEq(address(auction).balance, 0);
        _assertClaims(_actors5());
    }

    function test_PartialWithdrawalsPreserveInvariants() public {
        _commit(alice, 1 ether, 42);
        _commit(bob, 2 ether, 43);
        _commit(carol, 3 ether, 44);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        _reveal(bob, 2 ether, 43);
        _reveal(carol, 3 ether, 44);
        vm.warp(auction.revealDeadline());
        auction.settle();
        _assertClaims(_actors5());

        vm.prank(alice);
        auction.withdraw();
        _assertClaims(_actors5());
        vm.prank(seller);
        auction.withdraw();
        _assertClaims(_actors5());
        vm.prank(bob);
        auction.withdraw();
        _assertClaims(_actors5());

        assertEq(address(auction).balance, 0);
    }

    function test_SellerAndBiddersInvariantLifecycle() public {
        address[] memory actors = _actors5();

        _commit(alice, 1 ether, 42);
        _assertActive(actors);
        _commit(bob, 2 ether, 43);
        _assertActive(actors);
        _commit(carol, 3 ether, 44);
        _assertActive(actors);

        vm.prank(carol);
        auction.refund();
        _assertActive(actors);

        _commit(seller, 0.5 ether, 45);
        _assertActive(actors);

        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        _assertActive(actors);
        _reveal(bob, 2 ether, 43);
        _assertActive(actors);
        _reveal(seller, 0.5 ether, 45);
        _assertActive(actors);

        vm.warp(auction.revealDeadline());
        auction.settle();
        assertEq(auction.sellerProceeds(), 2 ether, "bob's bid; carol already refunded");
        _assertClaims(actors);
        assertEq(auction.withdrawable(seller), 2.5 ether, "proceeds + revealed escrow");
        assertEq(auction.withdrawable(alice), 1 ether);
        assertEq(auction.withdrawable(bob), 0);

        vm.prank(alice);
        auction.withdraw();
        _assertClaims(actors);

        uint256 sellerBefore = seller.balance;
        vm.prank(seller);
        auction.withdraw();
        assertEq(seller.balance, sellerBefore + 2.5 ether, "one payout, both buckets");
        _assertClaims(actors);

        assertEq(address(auction).balance, 0);
        assertEq(auction.totalDeposits(), 0);
    }

    // ---------------------------------------------------------------------
    // Seller-as-bidder edge cases
    // ---------------------------------------------------------------------

    function test_SellerIsLoserDualWithdrawal() public {
        _commit(seller, 1 ether, 42);
        _commit(alice, 3 ether, 43);
        vm.warp(auction.commitDeadline());
        _reveal(seller, 1 ether, 42);
        _reveal(alice, 3 ether, 43);
        vm.warp(auction.revealDeadline());
        auction.settle();

        assertEq(auction.sellerProceeds(), 3 ether);
        assertEq(auction.withdrawable(seller), 4 ether, "escrow 1e + proceeds 3e, no double count");
        _assertClaims(_actors5());

        uint256 before = seller.balance;
        vm.prank(seller);
        auction.withdraw();
        assertEq(seller.balance, before + 4 ether, "single combined payout");

        assertEq(auction.bidderDeposits(seller), 0, "escrow bucket consumed");
        assertEq(auction.sellerProceeds(), 0, "proceeds bucket consumed");
        assertEq(auction.totalDeposits(), 0);
        _assertClaims(_actors5());

        vm.prank(seller);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();

        // winner has no claim either
        vm.prank(alice);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();
        assertEq(address(auction).balance, 0);
    }

    function test_SellerWinsOwnAuctionNoDoubleCount() public {
        _commit(seller, 2 ether, 42);
        _commit(alice, 1 ether, 43);
        vm.warp(auction.commitDeadline());
        _reveal(seller, 2 ether, 42);
        _reveal(alice, 1 ether, 43);
        vm.warp(auction.revealDeadline());
        auction.settle();

        assertEq(auction.highestBidder(), seller);
        assertEq(auction.sellerProceeds(), 2 ether, "winning bid, zero forfeits");
        assertEq(auction.withdrawable(seller), 2 ether, "NOT escrow + proceeds");
        assertEq(auction.withdrawable(alice), 1 ether);
        _assertClaims(_actors5());

        uint256 before = seller.balance;
        vm.prank(seller);
        auction.withdraw();
        assertEq(seller.balance, before + 2 ether, "paid exactly once");
        assertEq(auction.bidderDeposits(seller), 2 ether, "raw escrow inert after payout");
        assertEq(auction.sellerProceeds(), 0);
        _assertClaims(_actors5());

        vm.prank(seller);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();

        vm.prank(alice);
        auction.withdraw();
        assertEq(address(auction).balance, 0);
        _assertClaims(_actors5());
    }

    // ---------------------------------------------------------------------
    // Tie-breaking
    // ---------------------------------------------------------------------

    function test_TieBreakEarliestRevealWins() public {
        _commit(alice, 1 ether, 42);
        _commit(bob, 1 ether, 43);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline() + 1);
        _reveal(bob, 1 ether, 43);
        assertEq(auction.highestBidder(), alice, "earlier reveal keeps the win");
        assertEq(auction.highestBid(), 1 ether);
    }

    function test_TieBreakSameTimestampLowerAddressWins() public {
        _commit(alice, 1 ether, 42);
        _commit(bob, 1 ether, 43);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);
        _reveal(bob, 1 ether, 43);
        address expected = alice < bob ? alice : bob;
        assertEq(auction.highestBidder(), expected, "lower address wins same-instant tie");
    }

    // ---------------------------------------------------------------------
    // Forced ETH
    // ---------------------------------------------------------------------

    function test_ForcedEthNeverWithdrawable() public {
        _commit(alice, 1 ether, 42);
        vm.warp(auction.commitDeadline());
        _reveal(alice, 1 ether, 42);

        uint256 forced = 1 ether;
        vm.deal(address(auction), address(auction).balance + forced);

        assertEq(address(auction).balance, auction.totalDeposits() + forced, "I1: excess present");
        assertGe(address(auction).balance, auction.totalDeposits(), "I1 holds");
        assertEq(auction.totalDeposits(), 1 ether, "force-feed never enters totals");
        assertEq(auction.bidderDeposits(alice), 1 ether, "escrow claim unchanged by force-feed");
        assertEq(auction.withdrawable(alice), 0, "withdraw() preview unchanged while active");

        vm.warp(auction.revealDeadline());
        auction.settle();
        assertEq(auction.sellerProceeds(), 1 ether, "proceeds from deposits only; forced ETH excluded");
        _assertClaims(_actors5());

        // Sole revealed bidder is the winner: escrow fully consumed as the bid.
        vm.prank(alice);
        vm.expectRevert("Nothing to withdraw");
        auction.withdraw();

        vm.prank(seller);
        auction.withdraw();

        assertEq(auction.totalDeposits(), 0);
        assertEq(address(auction).balance, forced, "forced ETH stranded, never claimable");
        _assertClaims(_actors5());
    }

    // ---------------------------------------------------------------------
    // Failed / reentrant withdrawals
    // ---------------------------------------------------------------------

    function test_FailedWithdrawPreservesClaimForRetry() public {
        WithdrawTester attacker = new WithdrawTester(auction);
        vm.deal(address(attacker), 10 ether);
        address[] memory actors = new address[](6);
        actors[0] = seller;
        actors[1] = alice;
        actors[2] = bob;
        actors[3] = carol;
        actors[4] = address(this);
        actors[5] = address(attacker);

        bytes32 h = auction.computeCommitmentHash(address(attacker), 1 ether, 7);
        attacker.commitBid{value: 1 ether}(h);
        _commit(alice, 2 ether, 42);

        vm.warp(auction.commitDeadline());
        attacker.doReveal(1 ether, 7);
        _reveal(alice, 2 ether, 42);
        vm.warp(auction.revealDeadline());
        auction.settle();
        assertEq(auction.sellerProceeds(), 2 ether);
        assertEq(auction.withdrawable(address(attacker)), 1 ether, "attacker is a revealed loser");
        _assertClaims(actors);

        // Rejecting receiver: withdrawal fails, whole tx reverts.
        vm.expectRevert("Withdraw failed");
        attacker.doWithdraw();
        assertEq(auction.withdrawable(address(attacker)), 1 ether, "claim preserved");
        assertEq(auction.bidderDeposits(address(attacker)), 1 ether, "bucket preserved");
        assertEq(auction.totalDeposits(), 3 ether, "totals preserved");
        assertEq(address(auction).balance, 3 ether, "balance preserved");
        _assertClaims(actors);

        // Honest participants are unaffected.
        uint256 sellerBefore = seller.balance;
        vm.prank(seller);
        auction.withdraw();
        assertEq(seller.balance, sellerBefore + 2 ether);
        _assertClaims(actors);

        // Retry after accepting ETH: full original claim paid once.
        attacker.setRejectEth(false);
        attacker.doWithdraw();
        assertEq(address(attacker).balance, 11 ether, "10 dealt + 1 withdrawn (single payout)");
        assertEq(auction.bidderDeposits(address(attacker)), 0);
        assertEq(auction.totalDeposits(), 0);
        assertEq(address(auction).balance, 0);
        _assertClaims(actors);
    }

    function test_WithdrawReentrancyPaysOnce() public {
        WithdrawTester attacker = new WithdrawTester(auction);
        vm.deal(address(attacker), 10 ether);
        address[] memory actors = new address[](6);
        actors[0] = seller;
        actors[1] = alice;
        actors[2] = bob;
        actors[3] = carol;
        actors[4] = address(this);
        actors[5] = address(attacker);

        bytes32 h = auction.computeCommitmentHash(address(attacker), 1 ether, 7);
        attacker.commitBid{value: 1 ether}(h);
        _commit(alice, 2 ether, 42);

        vm.warp(auction.commitDeadline());
        attacker.doReveal(1 ether, 7);
        _reveal(alice, 2 ether, 42);
        vm.warp(auction.revealDeadline());
        auction.settle();

        attacker.setRejectEth(false);
        attacker.doWithdraw();

        assertFalse(attacker.reentrySucceeded(), "reentrant withdraw blocked");
        assertEq(address(attacker).balance, 11 ether, "exactly one payout");
        _assertClaims(actors);
        assertEq(address(auction).balance, 2 ether, "seller proceeds remain");
    }

    function test_WithdrawRevertsDuringActiveAuction() public {
        _commit(alice, 1 ether, 42);
        vm.prank(alice);
        vm.expectRevert("Not claimable yet");
        auction.withdraw();

        vm.warp(auction.commitDeadline());
        vm.prank(alice);
        vm.expectRevert("Not claimable yet");
        auction.withdraw();

        vm.warp(auction.revealDeadline());
        vm.prank(alice);
        vm.expectRevert("Not claimable yet");
        auction.withdraw();
    }

    // ---------------------------------------------------------------------
    // Commitment hash scheme
    // ---------------------------------------------------------------------

    function test_HashMatchesInlineConstruction() public view {
        bytes32 expected = keccak256(
            abi.encodePacked(
                keccak256("BlockShield.CommitReveal.V2"),
                block.chainid,
                address(auction),
                alice,
                uint256(1 ether),
                uint256(42)
            )
        );
        assertEq(auction.computeCommitmentHash(alice, 1 ether, 42), expected, "vector mismatch");
    }

    function test_HashBindsChainAndContract() public {
        bytes32 h1 = auction.computeCommitmentHash(alice, 1 ether, 42);

        vm.chainId(999);
        bytes32 h2 = auction.computeCommitmentHash(alice, 1 ether, 42);
        assertTrue(h1 != h2, "chain id must be bound");
        vm.chainId(31337);

        vm.prank(seller);
        CommitRevealAuction other = new CommitRevealAuction(COMMIT_DURATION, REVEAL_DURATION);
        bytes32 h3 = other.computeCommitmentHash(alice, 1 ether, 42);
        assertTrue(h1 != h3, "contract address must be bound");

        bytes32 h4 = auction.computeCommitmentHash(bob, 1 ether, 42);
        assertTrue(h1 != h4, "bidder must be bound");
        bytes32 h5 = auction.computeCommitmentHash(alice, 1 ether, 43);
        assertTrue(h1 != h5, "nonce must be bound");
        bytes32 h6 = auction.computeCommitmentHash(alice, 2 ether, 42);
        assertTrue(h1 != h6, "amount must be bound");
    }
}
