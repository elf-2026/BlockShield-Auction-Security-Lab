// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.26;

/// @title BlockShield Commit-Reveal Auction — two-phase sealed-bid design
/// @notice Single-auction-per-deployment sealed-bid auction with explicit
///         commit/reveal phase boundaries, pull-based withdrawals and
///         strict accounting invariants.
///
/// Phases (single source of truth: block.timestamp vs stored deadlines):
///   Commit  : timestamp <  commitDeadline    commit, refund, seller cancel
///   Reveal  : commitDeadline <= ts < revealDeadline    reveal only
///   Settle  : revealDeadline <= ts           settle, then withdraw
///   Ended   : settled || canceled            withdraw only
///
/// Accounting invariants:
///   I1 (solvency):  address(this).balance == totalDeposits,
///                   plus any force-fed ETH which is excess and NEVER claimable.
///   I2 (ledger):    totalDeposits == sum(bidderDeposits) while the auction is
///                   active (and until the first payout after settlement).
///   I3 (claims):    totalDeposits == sum(withdrawable) once settled/canceled.
///
/// Each wei has exactly one outstanding claimant at all times:
///   - before settlement it belongs to exactly one bidder's escrow entry;
///   - settlement re-attributes the winner's escrow (winning bid) and all
///     unrevealed escrow into sellerProceeds while their withdrawable escrow
///     component drops to zero — so bidder escrow and seller proceeds never
///     cover the same wei. Withdrawals zero the consumed bucket(s) before any
///     external transfer (CEI), and `nonReentrant` guards the two functions
///     that ever transfer ETH (refund, withdraw). commit/reveal/settle/cancel
///     perform no external calls at all.
///
/// Pull-based withdrawals: settlement and cancellation never transfer funds,
/// so a party that rejects ETH or re-enters can only affect its own claim and
/// can never block settlement or anyone else's withdrawal.
contract CommitRevealAuction {
    // ---------------------------------------------------------------------
    // Phases
    // ---------------------------------------------------------------------

    uint8 public constant PHASE_COMMIT = 0;
    uint8 public constant PHASE_REVEAL = 1;
    uint8 public constant PHASE_SETTLE = 2;
    uint8 public constant PHASE_ENDED = 3;

    /// @notice Minimum length of each phase in seconds.
    uint256 public constant MIN_PHASE_DURATION = 60;

    // ---------------------------------------------------------------------
    // Configuration (immutable — set once at deployment; no createAuction)
    // ---------------------------------------------------------------------

    address public immutable seller;
    /// @notice Unix timestamp; commits allowed strictly before this instant.
    uint256 public immutable commitDeadline;
    /// @notice Unix timestamp; reveals allowed in [commitDeadline, this).
    uint256 public immutable revealDeadline;

    // ---------------------------------------------------------------------
    // Commitment state
    // ---------------------------------------------------------------------

    /// @notice Stored commitment hash; bytes32(0) means "no active commitment".
    mapping(address => bytes32) public commitmentHash;
    /// @notice Raw escrow ledger (msg.value of the active commitment, or the
    ///         unconsumed remainder). Authoritative payout is withdrawable().
    mapping(address => uint256) public bidderDeposits;
    mapping(address => bool) public revealed;

    // ---------------------------------------------------------------------
    // Aggregates and auction outcome
    // ---------------------------------------------------------------------

    /// @notice Outstanding claims on the contract balance (see invariants).
    uint256 public totalDeposits;
    /// @notice Sum of all revealed bid amounts.
    uint256 public revealedDepositsTotal;
    uint256 public highestBid;
    address public highestBidder;
    /// @notice Reveal timestamp of the incumbent winner (tie-break).
    uint256 public winnerRevealTime;

    bool public settled;
    bool public canceled;
    /// @notice Seller's claim after settlement (winning bid + forfeited escrow).
    uint256 public sellerProceeds;

    uint256 private _reentrancyStatus = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event AuctionCreated(address indexed seller, uint256 commitDeadline, uint256 revealDeadline);
    event BidCommitted(address indexed bidder, bytes32 commitmentHash);
    event BidRevealed(address indexed bidder, uint256 bidAmount);
    event AuctionSettled(address indexed winner, uint256 winningBid, bool hasWinner);
    event AuctionCanceled();
    event BidRefunded(address indexed bidder, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyPhase(uint8 p) {
        require(phase() == p, "Wrong phase");
        _;
    }

    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "Reentrancy");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(uint256 commitDuration, uint256 revealDuration) {
        require(commitDuration >= MIN_PHASE_DURATION, "Commit phase too short");
        require(revealDuration >= MIN_PHASE_DURATION, "Reveal phase too short");
        seller = msg.sender;
        commitDeadline = block.timestamp + commitDuration;
        revealDeadline = commitDeadline + revealDuration;
        emit AuctionCreated(seller, commitDeadline, revealDeadline);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Derived phase — never stored, so phase state cannot diverge
    ///         from the deadlines.
    function phase() public view returns (uint8) {
        if (settled || canceled) return PHASE_ENDED;
        if (block.timestamp < commitDeadline) return PHASE_COMMIT;
        if (block.timestamp < revealDeadline) return PHASE_REVEAL;
        return PHASE_SETTLE;
    }

    /// @notice Domain-separated commitment hash. Bound to chain id and this
    ///         contract (replay protection) and to the exact bidder, amount
    ///         and nonce. Clients must reproduce this byte-exactly.
    function computeCommitmentHash(address bidder, uint256 bidAmount, uint256 nonce) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                keccak256("BlockShield.CommitReveal.V2"), block.chainid, address(this), bidder, bidAmount, nonce
            )
        );
    }

    /// @notice Authoritative payout for `account` via withdraw(). Returns 0
    ///         while the auction is active (early exit during the commit phase
    ///         is refund(), realized against bidderDeposits).
    function withdrawable(address account) public view returns (uint256) {
        uint256 escrow = bidderDeposits[account];
        uint256 claim = 0;

        if (settled) {
            if (highestBid == 0) {
                // No bids revealed: every escrow entry is reclaimable.
                claim = escrow;
            } else if (revealed[account]) {
                if (account == highestBidder) {
                    // Winner: escrow beyond the winning bid is surplus
                    // (zero under the commit-equals-escrow rule).
                    claim = escrow > highestBid ? escrow - highestBid : 0;
                } else {
                    // Revealed loser: full escrow refund.
                    claim = escrow;
                }
            }
            // Unrevealed after settlement with a winner: forfeited — 0.
        } else if (canceled) {
            claim = escrow;
        }
        // Commit/Reveal/Settle-awaiting: not payable through withdraw().

        if (settled && account == seller) {
            claim += sellerProceeds;
        }
        return claim;
    }

    // ---------------------------------------------------------------------
    // Commit phase
    // ---------------------------------------------------------------------

    /// @notice Submit a sealed bid. The contract only ever sees the hash and
    ///         the escrowed ETH — never the bid amount or nonce. A second
    ///         commitment is rejected: refund first, then commit again.
    function commit(bytes32 _commitmentHash) external payable onlyPhase(PHASE_COMMIT) {
        require(commitmentHash[msg.sender] == bytes32(0), "Active commitment exists");
        require(msg.value > 0, "Empty bid");
        require(_commitmentHash != bytes32(0), "Invalid commitment");

        commitmentHash[msg.sender] = _commitmentHash;
        bidderDeposits[msg.sender] = msg.value;
        totalDeposits += msg.value;

        emit BidCommitted(msg.sender, _commitmentHash);
    }

    /// @notice Withdraw an unrevealed commitment during the commit phase.
    ///         Effects (clear commitment, zero escrow, update totals) are
    ///         applied before the transfer; nonReentrant blocks reentry, and a
    ///         failed transfer reverts everything, preserving the claim.
    function refund() external nonReentrant onlyPhase(PHASE_COMMIT) {
        require(commitmentHash[msg.sender] != bytes32(0), "No active commitment");
        require(!revealed[msg.sender], "Already revealed");

        uint256 amount = bidderDeposits[msg.sender];

        // Effects
        commitmentHash[msg.sender] = bytes32(0);
        bidderDeposits[msg.sender] = 0;
        totalDeposits -= amount;

        emit BidRefunded(msg.sender, amount);

        // Interaction last
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "Refund transfer failed");
    }

    /// @notice Seller-only cancellation, only before the commit deadline.
    ///         No funds move here: every participant pulls via withdraw().
    function cancel() external onlyPhase(PHASE_COMMIT) {
        require(msg.sender == seller, "Seller only");
        canceled = true;
        emit AuctionCanceled();
    }

    // ---------------------------------------------------------------------
    // Reveal phase
    // ---------------------------------------------------------------------

    /// @notice Open the sealed bid. Verifies the hash against the value
    ///         stored at commit time; a refunded bidder has no stored hash
    ///         and therefore cannot reveal the old commitment. The escrow
    ///         must exactly equal the revealed bid (solvency by construction).
    function reveal(uint256 bidAmount, uint256 nonce) external onlyPhase(PHASE_REVEAL) {
        require(!revealed[msg.sender], "Already revealed");
        bytes32 stored = commitmentHash[msg.sender];
        require(stored != bytes32(0), "No active commitment");
        require(computeCommitmentHash(msg.sender, bidAmount, nonce) == stored, "Commitment mismatch");
        require(bidAmount == bidderDeposits[msg.sender], "Bid must equal escrow");

        commitmentHash[msg.sender] = bytes32(0);
        revealed[msg.sender] = true;
        revealedDepositsTotal += bidAmount;

        // Tie-break: higher bid -> earlier reveal -> lower address.
        if (
            bidAmount > highestBid
                || (bidAmount == highestBid
                    && (block.timestamp < winnerRevealTime
                        || (block.timestamp == winnerRevealTime && msg.sender < highestBidder)))
        ) {
            highestBid = bidAmount;
            highestBidder = msg.sender;
            winnerRevealTime = block.timestamp;
        }

        emit BidRevealed(msg.sender, bidAmount);
    }

    // ---------------------------------------------------------------------
    // Settle phase
    // ---------------------------------------------------------------------

    /// @notice Finalize the auction after the reveal deadline. Performs NO
    ///         external calls: it only crystallizes claims. The seller's
    ///         proceeds are the winning bid plus all unrevealed (forfeited)
    ///         escrow, computed O(1); revealed losers keep their escrow as
    ///         withdrawable() claims.
    function settle() external onlyPhase(PHASE_SETTLE) {
        settled = true;
        if (highestBid > 0) {
            uint256 forfeited = totalDeposits - revealedDepositsTotal;
            sellerProceeds = highestBid + forfeited;
        }
        emit AuctionSettled(highestBidder, highestBid, highestBid > 0);
    }

    /// @notice Pull-based payout. Available once settled or canceled. Only
    ///         the caller's own claim is paid; seller proceeds and bidder
    ///         escrow are separate buckets that can each be consumed once.
    ///         CEI: buckets and totals are zeroed before the transfer, so a
    ///         failed transfer reverts the whole call and preserves the
    ///         claim for retry, and reentrancy can never pay twice.
    function withdraw() external nonReentrant {
        require(settled || canceled, "Not claimable yet");

        address account = msg.sender;
        uint256 escrowPart = _escrowClaim(account);
        uint256 proceedsPart = (settled && account == seller) ? sellerProceeds : 0;
        uint256 amount = escrowPart + proceedsPart;
        require(amount > 0, "Nothing to withdraw");

        // Effects
        if (escrowPart > 0) {
            bidderDeposits[account] -= escrowPart;
        }
        if (proceedsPart > 0) {
            sellerProceeds = 0;
        }
        totalDeposits -= amount;

        emit Withdrawal(account, amount);

        // Interaction last
        (bool ok,) = payable(account).call{value: amount}("");
        require(ok, "Withdraw failed");
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Escrow-only portion of `account`'s claim (mirrors withdrawable
    ///      minus seller proceeds). Escrow entries whose value has been
    ///      re-attributed to sellerProceeds (winner bid, forfeits) yield 0,
    ///      which is what makes escrow and proceeds disjoint claims.
    function _escrowClaim(address account) internal view returns (uint256) {
        uint256 escrow = bidderDeposits[account];
        if (canceled) return escrow;
        if (!settled) return 0;
        if (highestBid == 0) return escrow;
        if (!revealed[account]) return 0;
        if (account == highestBidder) return escrow > highestBid ? escrow - highestBid : 0;
        return escrow;
    }
}
