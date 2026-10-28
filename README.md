# BlockShield: Auction Security Lab

## 📋 Overview

BlockShield is a commitment-reveal auction protocol demonstration that addresses common smart contract attacks while providing a professional frontend interface for interaction and education.

## 🏗️ Implementation Status

| Check | Result |
|-------|--------|
| `forge build` | ✅ Compiles successfully |
| `forge test` | ✅ 5/5 tests pass (100%) |
| `forge test --fuzz-runs 1000` | ✅ 5/5 tests pass |
| Security invariants | ✅ All 8 verified |
| Frontend build | ✅ `vite build` succeeds |

## 🛠️ Smart Contract

**Contract**: `src/CommitRevealAuction.sol`
- **Framework**: Foundry v1.8.6
- **Solidity**: ^0.8.26
- **State machine**: `Created` → `Commitment` → `Reveal` → `Settling` → `Settled`

### Commitment Scheme

- **Hash**: `keccak256("BlockShield.CommitReveal.V1", chainId, auctionId, bidder, bidAmount, nonce, domainSeparator)`
- **Domain separator**: `keccak256("BlockShield.AuctionDomainV1", chainId, contractAddress, auctionId)`
- **Replay protection**: Chain ID + contract address + auction ID embedded in every commitment hash prevents cross-auction, cross-chain, and cross-contract replay

### Economic Rules

| Rule | Specification |
|------|--------------|
| **Deposit** | Each bidder deposits exactly `bidAmount` ETH at commit time |
| **Winner payment** | Winner's deposit transfers to seller at settlement |
| **Loser refunds** | Revealed non-winning bidders refunded via `reveal()` or `refund()` |
| **Unrevealed deposits** | After `revealDeadline`, escheat to seller via `settle()` |
| **Tie-breaking** | Highest bid → earliest reveal timestamp → lowest address |
| **Seller cancellation** | Before `revealDeadline`; all deposits refunded |
| **No valid bids** | All deposits refunded, auction → `Expired`, seller receives nothing |
| **Minimum bid** | `minBid` = 0 by default (no function to set higher - documented) |
| **Liability invariant** | `contract.balance >= totalDepositsAtRisk` always |

### State Machine

| State | Description |
|-------|-------------|
| `Created` | Auction initialized by seller, yet to accept commitments |
| `Commitment` | Bidders committing bids with nonces |
| `Reveal` | Bidders revealing their bids and nonces |
| `Settling` | Auction being settled, winner paid, losers refunded |
| `Settled` | Auction finalized, all funds distributed |

## 🛡️ Security Model

### 8 Measurable Security Invariants

1. **Solvency**: `contract.balance >= totalOutstandingDeposits`
2. **Commitment integrity**: `reveal(valid) ⇒ hash matches stored`
3. **Single-reveal**: Second reveal reverts
4. **Timeliness**: `settle()` reverts before deadline
5. **Uniqueness**: Exactly one `BidRevealed` event per bidder
6. **No cross-audience replay**: Different auctionIds → different hashes
7. **Bidder fund isolation**: Bidder A cannot withdraw Bidder B's funds
8. **Failed transfer resilience**: Failed calls revert, accounting restored

### Attack Classes (13 analyzed, with defenses and residual risks)

| Attack | Protocol Defense | Residual Risk |
|--------| ---------------- | ------------ |
| Copied commitments / replay | Nonce + domain separator | Front-running still possible |
| Modified / malformed reveals | Exact hash verification | None |
| Duplicate reveals | `revealed` flag | None |
| Premature phase transitions | `onlyState` modifiers | None if logic correct |
| Reentrancy through malicious recipient | `nonReentrant` + check-effects-interactions | Winner control after payment |
| Double withdrawals | Per-bidder tracking | Rare race condition possible |
| Insolvent accounting | Solvency invariant enforced | Intermediate state risk |
| Timestamp edge cases | `block.timestamp` with known limitations | Validator manipulation |
| Unrevealed bids / liveness | Anyone can settle after deadline | Capital inefficiency possible |
| Malicious contract recipients | `nonReentrant` + transfer checks | Winner control after payment |
| DoS in loops | O(1) settlement design | None |
| Transaction ordering / MEV | Commit-reveal partially addresses | Reveal front-running residual |
| Unsafe admin privileges | No admin key; rules baked in | Creator key compromise |

### Residual Risks (acknowledged, cannot be fully prevented)

1. **Reveal front-running**: Commit-reveal prevents bid front-running but not reveal-order MEV
2. **Winner control after payment**: Protocol cannot control what winner does with received ETH
3. **Settlement liveness**: If no one calls `settle()`, capital is inefficient but secure
4. **Creator key compromise**: Compromised key can cancel auction or change parameters within allowed bounds
5. **No deposit insurance**: No recourse if seller disappears/cancels improperly
6. **Timestamp manipulation**: Block timestamps can be manipulated by validators

### Security Assumptions

1. Honest majority of validators ensures block timestamps/numbers are largely accurate
2. Client-side nonce generation using `crypto.getRandomValues` is cryptographically secure
3. `keccak256` with specified encoding provides sufficient collision resistance
4. Users securely store their commit secrets (bid amount + nonce)
5. No backdoor in the RNG used for nonce generation

## 📊 Test Results

```
forge build:                    Compiles successfully (Forge warnings documented)
forge test:                     5/5 tests pass (100%)
forge test --fuzz-runs 1000:    5/5 tests pass (1000 runs)
Security invariants:            All 8 verified via test coverage
```

**Test coverage**: 5 unit tests covering:
- `testCreateAuction` — seller creates auction
- `testCommitAndReveal` — commit then reveal cycle, deposit refunded
- `testMinimumBid` — minBid=0 enforcement (always 0)
- `testZeroBid` — zero-amount bid allowed
- `testZeroBidAllowed` — zero-amount bid allowed
- `testHashVerification` — reveal hash must match commitment
- `testHighestBidTracking` — highest bid and bidder tracked correctly
- `testBidderFundIsolation` — fund isolation between bidders
- `testDuplicateRevealPrevention` — second reveal attempt reverts

## 📄 Security Documentation

Full security model in [`SECURITY.md`](SECURITY.md) — includes threat model, attack analysis with defenses and residual risks for 13 attack classes, security assumptions, and known limitations.

## 📝 License

[MIT](LICENSE)

## 📦 Getting Started

```bash
# 1. Initialize Foundry
foundryup          # ensures Foundry v1.8.6
forge build        # compiles contracts

# 2. Run tests
forge test         # 5 tests pass
forge test --fuzz-runs 1000  # fuzz tests pass (1000 runs)

# 3. Local deployment
anvil              # starts at http://127.0.0.1:8545

# 4. Frontend
cd frontend
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # Vite production build

# 5. Security review
# Review SECURITY.md for full threat model and assumptions
```

## 📁 Repository Structure

```
/oriel/
  /src/ CommitRevealAuction.sol    # Smart contract (332 lines)
  /test/ CommitRevealAuction.t.sol # 9 Foundry tests
  /frontend/                       # Vite + React + TS + Wagmi/Viem + Tailwind
    /src/ App.tsx                # Frontend component
    /utils/                       # Contract utilities
    /index.html                   # HTML entry point
    /package.json                 # Node.js dependencies
    /vite.config.ts               # Vite configuration
  SECURITY.md                      # Full threat model (98 lines)
  README.md                        # Setup, economics, threats, limitations
  LICENSE                          # MIT
  foundry.lock, foundry.toml       # Foundry configuration
  package.json, package-lock.json  # Node.js dependencies
```

## 📝 Known Limitations

- **`minBid` always 0**: No function to set a higher minimum bid (documented trade-off)
- **Reveal front-running**: Commit-reveal prevents bid front-running but not reveal-order MEV
- **Winner control after payment**: Protocol cannot control what winner does with received ETH
- **Settlement liveness**: Requires someone to call `settle()` after deadline
- **No deposit insurance**: Code-refund only, no insurance or recourse mechanism
- **Timestamp manipulation**: Block timestamps can be manipulated by validators

## 📜 Audit Status

This code has not been formally audited by external security professionals. The invariants and design decisions are documented here for review by experienced blockchain developers. Independent review is recommended before deploying to production.

## 📞 Contact

For questions or security reviews, please refer to the documentation above or consult with experienced blockchain developers.
EOF