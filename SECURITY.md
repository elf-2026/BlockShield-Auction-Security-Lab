# BlockShield: Security Considerations

This document outlines the security assumptions, limitations, and residual risks of the BlockShield commit-reveal auction protocol.

## Security Model

The BlockShield protocol uses a commit-reveal scheme to limit early bid disclosure while maintaining deterministic winner selection and secure fund accounting. The following security invariants are enforced:

### Measurable Security Invariants

1. **Solvency**: `contract.balance >= totalOutstandingDeposits` at all times. The contract's ETH balance must always cover all refundable deposits.

2. **Commitment Integrity**: A bid can only be revealed if the revealed `(bidAmount, nonce)` pair produces a commitment hash that matches the originally committed hash. Any alteration changes the hash and causes the reveal to revert.

3. **Single-Reveal**: Each commitment can only be successfully revealed once. The `revealed` flag is set to `true` after the first successful reveal; second reveal attempts revert.

4. **Timeliness**: `settle()` reverts if `block.number < revealDeadline`. Settlement cannot occur before the required deadline.

5. **Uniqueness**: Exactly one `BidRevealed` event is emitted per valid bidder reveal. Duplicate reveals are prevented by the `revealed` flag.

6. **No Cross-Audience Replay**: `commitmentHash(auctionId1, ...) != commitmentHash(auctionId2, ...)` for `auctionId1 != auctionId2`. Cross-auction replay is prevented by embedding the auction ID in the commitment hash.

7. **Bidder Fund Isolation**: A bidder cannot withdraw another bidder's funds. Refunds and withdrawals are only allowed for the caller's own deposited amount.

8. **Failed Transfer Resilience**: Failed external calls do not silently corrupt accounting. All `settle()` and `refund()` operations check transfer return status and revert on failure.

### Attack Classes and Protocol Defenses

| Attack Class | Protocol Defense | Residual Risk |
|-------------| ---------------- | ------------ |
| **Copied commitments / replay** | Nonce per bidder per auction + domain separator (chainId + contract address + auctionId in commitment hash); only first valid reveal accepted | **Residual**: Reveal front-running still possible - observer sees commitment hash, races to reveal first with same bid. Mitigation: users should reveal promptly after committing. |
| **Modified / malformed reveals** | Reveal verification: commitmentHash must exactly match stored hash; deterministic hash verification | None - hash verification is deterministic. |
| **Duplicate reveals** | `Commitment.revealed` flag set to `true` after first successful reveal; second `reveal()` reverts | None. |
| **Premature phase transitions** | State gate on every function (`onlyState` modifier), `revealDeadline` checked via `block.number` | None if gate logic correct. |
| **Reentrancy through malicious recipient** | `nonReentrant` modifier on `settle()`; winner payment executed AFTER state update; all external ETH transfers check return status. Winner cannot re-enter before balance change. | **Residual**: If winner is a contract that receives ETH and the transfer succeeds, the winner's code executes post-payment. The `nonReentrant` guard prevents re-entering `settle()`, but the winner can still execute arbitrary logic with received funds. This is a known limitation - the protocol prevents re-entrancy into contract state changes, but cannot control what the winner does with received funds. |
| **Double withdrawals / incorrect refunds** | Per-bidder withdrawal tracking; refund amounts calculated from on-chain state, not user-supplied values; `revealed` flag prevents double-reveal | **Residual**: If a bidder calls `refund()` twice before state updates, both could succeed before `revealed` is set. Mitigation: `revealed` flag set before transfer. |
| **Insolvent accounting** | Solvency invariant `B >= Σ D[b]` enforced at every state change; `settle()` reverts if insufficient balance; `transfer` return status checked | **Residual**: If ETH is sent to the contract between invariant check and transfer, balance could drop. Mitigation: `settle()` runs as a single atomic transaction; no intermediate state changes. |
| **Timestamp / integer edge cases** | `revealDeadline` checked against `block.timestamp` (not timestamp, which can be manipulated by miners); Solidity ^0.8+ provides automatic integer checking; `highestBid` tracked on-chain | **Residual**: `block.timestamp` can be manipulated by up to ~2 seconds by honest validators, and more by malicious miners. Mitigation: use reliable oracle for critical deadlines (out of scope for this demo). |
| **Unrevealed bids / settlement liveness** | `settle()` callable by anyone after `revealDeadline`; if no one calls, auction stays in `Reveal` state but deposits remain secure; unrevealed deposits refunded after 30-day timelock | **Residual**: If no one calls `settle()` for an extended period, capital is inefficient but **safe**. The protocol cannot force liveness; community coordination required. |
| **Malicious contract recipients** | Winner payment uses `transfer{value: W}(seller)` - ETH sent to seller (EOA typically). If winner is a contract, fallback receives ETH but cannot re-enter `settle()` due to `nonReentrant`. Transfer return status checked. | **Residual**: If winner is a contract with a `fallback()` that calls `settle()` again, the second call reverts via `nonReentrant`. **However**, the winner contract now holds ETH and can do whatever its code intends. This is a mitigated risk, not fully preventable. |
| **Transaction ordering / MEV** | Commit-reveal provides some privacy, but reveal order is visible on-chain; domain separator raises cost of targeted front-running; reveal order determines tie-breaking | **Residual**: Reveal front-running is still possible. The commit scheme prevents bid front-running before commitment, but the reveal order itself is orderable by miners/validators. This is a residual MEV risk that commit-reveal partially addresses but cannot fully eliminate. |
| **Unsafe administrative privileges** | No admin key; all rules baked into code; `onlyState` modifiers; `cancelAuction()` only before `revealDeadline`; no emergent privileges | **Residual**: If the creator private key is compromised, the attacker can cancel the auction or manipulate parameters within allowed bounds. Mitigation: use a multi-sig creator account; no emergency admin upgrades. |

### Security Assumptions

The following assumptions underpin the security of the BlockShield protocol:

1. **Honest majority of validators**: The blockchain's consensus mechanism ensures that block timestamps and block numbers are largely accurate, with bounded manipulation possible.

2. **Cryptographically secure nonce generation**: Client-side nonce generation using `crypto.getRandomValues` (or equivalent) is cryptographically secure and unpredictable to attackers.

3. **Commitment hash collision resistance**: `keccak256` with the specified encoding scheme provides sufficient collision resistance for the commitment scheme.

4. **User-controlled secrets**: Users securely store and protect their commit secrets (bid amount + nonce). Loss of these secrets means loss of the bid.

5. **No backdoor in RNG**: The random number generator used for nonce generation is not backdoored or predictable.

### Known Risks and Limitations

#### Inevitability of Some Risks

The following risks are acknowledged as inherent to the commit-reveal auction design and cannot be fully eliminated:

1. **Reveal front-running**: The commit-reveal scheme prevents bid front-running (bidders cannot see others' bids before committing), but reveal order is still visible on-chain. Miners/validators can order reveals to their advantage.

2. **Winner control after payment**: Once the winner's deposit is transferred, the winner has full control over the received ETH. The protocol cannot prevent the winner from doing whatever they want with the funds.

3. **Settlement liveness**: The protocol relies on someone calling `settle()` after the deadline. If no one does, capital remains inefficient but secure. There is no mechanism to force settlement.

4. **Creator key compromise**: The creator has significant power (can cancel, set parameters). Key compromise leads to potential misuse.

5. **No deposit insurance**: If the seller disappears or cancels improperly, deposits are refunded via code but there's no insurance or recourse mechanism.

6. **Timestamp manipulation**: Block timestamps can be manipulated by validators, though bounded by the consensus protocol.

#### Mitigations and Design Decisions

- **Check-effects-interactions pattern**: State is updated before external calls in all functions, mitigating some reentrancy risks.
- **`nonReentrant` modifier**: Applied to `settle()` to prevent re-entrant calls.
- **`onlyState` modifiers**: Ensure valid phase transitions only occur under correct conditions.
- **No admin keys**: All rules are baked into code; no emergent privileges or emergency controls.
- **Clear invariants**: Eight measurable security invariants are explicitly defined and tested.

#### Recommendations for Users

1. **Reveal promptly**: After committing, reveal your bid as soon as possible to minimize the window for front-running.

2. **Protect your secrets**: Your nonce and bid amount are ephemeral - lose them and lose your bid. Clear browser storage carefully.

3. **Monitor settlement**: After the reveal deadline, monitor the auction to ensure timely settlement.

4. **Use with caution for large amounts**: For significant values, consider additional security measures (multi-sig, time-locks, etc.).

5. **Test before using with real funds**: The contract has been tested with Foundry, but local testing is recommended before mainnet use.

## Audit Status

This code has not been formally audited by external security professionals. The invariants and design decisions are documented here for review by experienced blockchain developers. Independent review is recommended before deploying to production.
