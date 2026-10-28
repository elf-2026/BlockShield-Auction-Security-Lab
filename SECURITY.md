# BlockShield — Security Model (V2 contract)

**Scope & disclaimer.** This repository is a **local Anvil security lab**
(chain id 31337, unlocked dev accounts) demonstrating commit–reveal auction
mechanics and their failure modes. It is **not a production-ready mainnet
auction** and has **no external audit**. Fund it only with local test ETH.

The contract under review is `src/CommitRevealAuction.sol` (V2):
single auction per deployment, two fixed timestamp deadlines, pull-based
withdrawals. Every claim below is backed by a named test in
`test/CommitRevealAuction.t.sol` (44 tests) and, where it crosses the
client boundary, by frontend/integration suites cited at the end.

---

## 1. Design summary

```
constructor(commitDuration, revealDuration)   // each ≥ MIN_PHASE_DURATION = 60s
commitDeadline  = block.timestamp + commitDuration   (immutable)
revealDeadline  = commitDeadline  + revealDuration   (immutable)

phase()  // DERIVED from block.timestamp; nothing stored can desync
  PHASE_COMMIT  0: ts <  commitDeadline   commit(bytes32) · refund() · cancel()
  PHASE_REVEAL  1: ts <  revealDeadline   reveal(bidAmount, nonce)
  PHASE_SETTLE  2: ts ≥  revealDeadline   settle()   (no ETH moves)
  PHASE_ENDED   3: settled || canceled    withdraw() (pull payments)
```

Commitment hash (public helper `computeCommitmentHash`):

```solidity
keccak256(abi.encodePacked(
    keccak256("BlockShield.CommitReveal.V2"),  // domain tag
    block.chainid, address(this),              // replay binding
    bidder, bidAmount, nonce                   // bid binding
))
```

## 2. Accounting invariants (the core guarantees)

| #      | Invariant                                                                                                                                                                                                                                                           | Enforced by                                                                                                                                                       | Tested by                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | **Solvency** — `address(this).balance ≥ totalDeposits` always. Excess ETH (self-destruct / forced `coinbase`-style transfers) is _unclaimable_, never paid out.                                                                                                     | `commit` is the only fund inflow; `refund`/`withdraw` are the only outflows and decrement `totalDeposits` atomically; no function pays more than the ledger says. | `test_ForcedEthNeverWithdrawable`, `test_FailedWithdrawPreservesClaimForRetry`                                                                                       |
| **I2** | **Ledger** — while active, `totalDeposits == Σ bidderDeposits`. Escrow is created/consumed only inside `commit`/`refund` together with the commitment record.                                                                                                       | single write path per mapping                                                                                                                                     | `test_CommitEscrowsValueAndStoresHash`, `test_RefundClearsCommitmentAndAccounting`, `test_SettleFullSettlementWinnerLosersForfeits`                                  |
| **I3** | **Claims** — after `settle()` or `cancel()`, `totalDeposits == Σ withdrawable(a)` over affected parties: winner escrow (== bid) + forfeited unrevealed escrow are re-attributed to `sellerProceeds`, losers keep their escrow as claims, so no wei is double-owned. | settlement is pure bookkeeping; `_escrowClaim()` and `withdrawable()` mirror each other and consume disjoint buckets                                              | `test_PartialWithdrawalsPreserveInvariants`, `test_SellerAndBiddersInvariantLifecycle`, `test_SellerIsLoserDualWithdrawal`, `test_SellerWinsOwnAuctionNoDoubleCount` |

**Every wei has exactly one claimant at all times.** The seller-as-bidder
duality (escrow bucket + proceeds bucket in one `withdraw()`) is explicitly
covered: `test_SellerIsLoserDualWithdrawal`, `test_SellerWinsOwnAuctionNoDoubleCount`.

## 3. Fund-flow guarantees

### Pull-based withdrawals (no push, no blockage)

`settle()` and `cancel()` **perform no external calls and send no ETH**;
payouts happen only when the claimant calls `withdraw()` for their own
account. Consequences:

- A recipient with a reverting fallback (contracts without `receive()`), or a
  malicious actor, can **never stall settlement or drain anyone else's funds** —
  they can only delay collecting _their own_ claim.
- Failed transfers revert the whole `withdraw()`; the claim survives intact
  for retry (`test_FailedWithdrawPreservesClaimForRetry`).
- Contrast with push-payment designs where one poisoned recipient blocks the
  loop: settlement is O(1) and never loops over bidders
  (`test_SettleFullSettlementWinnerLosersForfeits`).

### Refunds & forfeiture

- **Losers** (revealed, not highest) receive their full escrow via `withdraw()`
  after settlement.
- **Unrevealed commitments forfeit**: `settle()` moves their escrow into
  `sellerProceeds`; `withdrawable()` returns 0 for them. This is the economic
  cost of not revealing — griefing is impossible beyond losing your own escrow,
  because forfeits can only exceed what the forfeiter deposited.
- **Zero-reveal settlement is a full unwind**: if `highestBid == 0` nobody
  forfeits and every escrow stays claimable
  (`test_ZeroRevealSettlement`, `test_CancelWithoutBids`).
- **Early exit**: during the commit phase a bidder may `refund()` (clears
  commitment + escrow atomically); duplicate commitments are rejected
  (`"Active commitment exists"`) so a refund is required first
  (`test_CommitRejectsDuplicateCommitment`, `test_ReCommitAfterRefundSucceeds`,
  `test_RevealAfterRefundReverts`).
- **Cancel** is seller-only and commit-phase-only; afterwards all escrow is
  withdrawable (`test_CancelSellerOnly`, `test_CancelRevertsInRevealPhase`,
  `test_CancelWithCommitmentsAllowsFullWithdrawals`).

## 4. Commitment scheme — what it binds, and what it does **not** hide

**Bound (tested):**

- Wrong `bidAmount` or wrong `nonce` fails the hash
  (`test_RevealRejectsWrongNonce`, `test_RevealRejectsWrongAmount`).
- Revealing without a commitment, or double-revealing, reverts
  (`test_RevealWithoutCommitmentReverts`, `test_DoubleRevealReverts`).
- **Replay protection**: the hash embeds `block.chainid` and
  `address(this)` — a commitment cannot be replayed on another chain or
  another deployment, and (by construction) only `msg.sender` can reveal it
  since `computeCommitmentHash(msg.sender, …)` is checked
  (`test_HashBindsChainAndContract`, `test_HashMatchesInlineConstruction`).
- **Escrow == bid**: reveal enforces `bidAmount == bidderDeposits`, so escrow
  can never be underfunded relative to the winning claim
  (`test_RevealRequiresEscrowToEqualBid`).

**Not hidden — the central honesty note of this design:**

- Because escrow must equal the revealed bid, **the bid amount is visible
  on-chain from the moment `commit` is mined** (as `msg.value`). What the
  commitment hides until reveal is _nothing about the amount_ — its role here
  is binding (no renegotiation), identity (only the owner with the nonce can
  reveal), and replay isolation. Classic sealed-bid privacy would require
  decoupling escrow from the bid (e.g. a fixed deposit + separate settlement
  charge); the V2 design deliberately trades that away for the simple,
  auditable solvency invariant `totalDeposits == Σ escrow == Σ claims`.
- A hidden-hash preimage attack would need `keccak256` preimage recovery on a
  128-bit CSPRNG nonce; a low-entropy nonce (user-typed) **does** leak the
  amount — hence enforced client-side: nonces come from
  `crypto.getRandomValues` (`src/utils/commitment.ts::generateNonce`,
  tested in `src/utils/commitment.test.ts`), never `Math.random`.
- Reveal order remains visible; the tie-break
  (_higher bid → earlier reveal → lower address_,
  `test_TieBreakEarliestRevealWins`,
  `test_TieBreakSameTimestampLowerAddressWins`) is deterministic but
  block-producers can still influence ordering within their block (see §6).

## 5. EVM-level hardening

| Concern                     | Implementation                                                                                                                                                                                        | Test                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Reentrancy on ETH transfers | hand-rolled `nonReentrant` (single storage slot, `=2`/`=1` around body) on the only two functions that transfer (`refund`, `withdraw`); commit/reveal/settle/cancel make **no external calls at all** | `test_RefundReentrancyBlocked`, `test_WithdrawReentrancyPaysOnce`                                                                            |
| Check-Effects-Interactions  | all bucket decrements (`bidderDeposits`, `sellerProceeds`, `totalDeposits`) happen _before_ the `.call{value}`                                                                                        | `test_FailedWithdrawPreservesClaimForRetry`                                                                                                  |
| Timestamp dependence        | deadlines are `block.timestamp` comparisons; `phase()` derived, half-open intervals (`ts < commitDeadline` = commit) — no stored phase to desync                                                      | `test_PhaseTransitions`, `test_CommitAllowedUntilCommitDeadline`, `test_CommitRevertsAtCommitDeadline`, `test_RevealRevertsAtRevealDeadline` |
| Integer overflow            | Solidity ^0.8.26 checked arithmetic everywhere                                                                                                                                                        | —                                                                                                                                            |
| Short phases                | constructor requires each duration ≥ 60 s                                                                                                                                                             | `test_ConstructorRejectsShortPhases`                                                                                                         |
| Empty commits               | zero value or zero hash rejected                                                                                                                                                                      | `test_CommitRejectsZeroValue`, `test_CommitRejectsZeroHash`                                                                                  |

## 6. Known limitations & residual risks (by design, not by oversight)

1. **Amounts are public** (§4): commit–reveal here provides binding + replay
   protection, not sealed-bid price privacy. Documented trade-off for
   auditability of I1–I3.
2. **`block.timestamp` can be nudged** (~12 s class window): deadline
   boundaries inherit that. Phase durations are ≥ 60 s and the lab runs on
   automine — acceptable for demonstration, not for high-stakes mainnet use.
3. **Reveal-order MEV**: within the reveal window, block producers order
   reveals; the earlier-reveal tie-break can be influenced by them.
   Commit–reveal delays but cannot eliminate ordering games.
4. **No asset transfer**: settling pays the seller but delivers nothing —
   an item/NFT handover (escrowed or atomic swap) is out of scope; "the
   auction" is purely about allocating ETH claims.
5. **Trust in the seller**: seller may `cancel()` during the commit phase
   (bounded: funds are never pushed anywhere and all escrow remains
   withdrawable — but cancel can be timed to disrupt planning). Seller's key
   compromise = cancel risk only, never fund theft (I1/I3 hold regardless).
6. **Winner-keeps-ETH is uncontrolled**: after settlement the winner's payout
   logic is theirs; nothing the contract can do.
7. **Client custody**: bid amount + nonce live in `localStorage` (scoped per
   chain/contract/bidder, never containing private keys — see
   `src/utils/secrets.ts` + tests). **Losing them = forfeiting the reveal**
   (and the escrow at settlement, unless no bids were revealed at all).
   Backup export is provided; clearing browser data is user risk.
8. **No auth/anti-Sybil**: any address may commit unlimited ETH — the design
   relies on economics, not identity.
9. **Single auction per deployment**: deadlines are `immutable`; a new
   auction needs a new deployment (by design, keeps `address(this)` binding
   meaningful).
10. **Not audited externally**; the invariant tests are thorough but written
    by the same author. Treat all mainnet use as out of scope.

## 7. Client-side security surface

- **Hash fidelity**: `src/utils/commitment.ts` reproduces the Solidity hash
  byte-for-byte (`encodePacked` = raw 20-byte addresses, chain-scoped domain
  tag). Golden vectors were generated from the _deployed contract_ via
  `cast`; `src/utils/commitment.test.ts` pins them;
  `src/integration/live.integration.test.ts` re-verifies
  `frontend hash == computeCommitmentHash()` on a live node (multiple
  bidders/amounts/nonces, incl. chain/contract scoping sensitivity).
- **Secret scoping**: localStorage keys include `(chainId, contract, bidder)`
  (lower-cased); loading cross-checks the stored record against the key and
  rejects tampered/foreign/mismatched records — switching account or
  redeploying never leaks an old bid into the wrong reveal
  (`src/utils/secrets.test.ts`).
- **No key custody**: in default local mode the browser talks to unlocked
  Anvil accounts via `eth_sendTransaction` — no private keys or seed phrases
  ever enter the app or storage. In injected-wallet mode (MetaMask et al.)
  the **extension** signs; the app requests accounts and verifies the wallet's
  chain against `VITE_CHAIN_ID`, and refuses to submit while the wallet sits
  on a different chain (`combineChainOk` fail-closed gating, tested in
  `src/utils/chainconfig.test.ts`). `generateNonce` uses
  `crypto.getRandomValues` (test asserts `Math.random` is never consulted
  for the nonce).
- **No fake state**: UI renders auction data only from live reads at the
  `pending` block tag (so the displayed phase can never lag execution and
  enable an action that would revert); wrong chain / missing code / failed
  reads disable actions and say so; disabled controls carry the exact gating
  reason (same rules as contract `require`s, mirrored + tested in
  `src/utils/gating.test.ts`, browser-confirmed by `npm run
audit:full-lifecycle`).

## 8. How to verify

```bash
forge test -vvv               # 44 contract tests
npm run test:frontend         # 80 unit tests
npm run test:integration      # 3 live-chain tests (needs npm run dev:local)
npm run audit:full-lifecycle  # Playwright: whole auction via the UI — commits, per-account
                              # secret retrieval, reveals, winner, settle, withdrawals,
                              # double-withdraw refused (UI + on-chain revert), drain-to-0
npm run audit:responsive      # Playwright: viewports/themes + E2E commit hash cross-check
npm run verify                # full static battery (fmt/build/tests/lint/build)
```

Both browser audits drive real transactions against a fresh local deployment
and check on-chain state directly; they are the strongest layer of evidence
this project provides short of an independent external audit (which this
project has **not** received — see the disclaimer above).

## 9. Reporting issues

This is a demonstration project; treat findings as lab feedback. For real
deployments of similar designs, commission an external audit and re-derive
which invariants survive mainnet assumptions (timestamp tolerance, MEV,
ERC-20/NFT settlement coupling, gas refunds, etc.).
