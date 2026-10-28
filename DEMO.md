# BlockShield — Presenter Demo Runbook

How to drive a complete, real auction through the browser for a reviewer,
with reset and recovery steps. Everything runs against a **local Anvil
chain** (chain id 31337, disposable dev accounts, no real value, no keys —
see `SECURITY.md` for the honest security framing).

## 1. Pre-flight (once)

```bash
git submodule update --init --recursive   # forge-std (fresh clones only)
npm install
forge build && npm run sync-abi           # keep frontend ABI == contract
```

## 2. Start the demo stack

For a **live presentation** use long enough phases that nobody is rushing
(durations must be ≥ 60 s — enforced on-chain, never edit the contract):

```bash
COMMIT_DURATION=300 REVEAL_DURATION=300 npm run dev:local
# -> Anvil accounts 0..2 printed and unlocked; account 0 is seller/deployer
# -> deploy verified (bytecode + sane deadlines), .env.local written, vite up
# -> open http://localhost:5173   (use 5173, not a second stray instance)
```

Stop: Ctrl+C in the dev.sh terminal (it kills only what it started).

## 3. Timed walkthrough (~6–8 minutes, two bidders)

Accounts (Anvil, shown by dev.sh):

- **Account 0** `0xf39F…2266` — Seller (deployer)
- **Account 1** `0x7099…9C8` — Bidder A
- **Account 2** `0x3C44…3BC` — Bidder B

| #      | Action                                                                                                                                                                              | What to point out                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T+0:00 | Select **Seller**, show the dashboard: lifecycle stepper, `Security Lab` solvency panel (`contract balance ≥ totalDeposits` — live from `eth_call`)                                 | derived `phase()`, immutable deadlines                                                                   |
| T+0:30 | Switch to **Bidder A**, commit **0.4 ETH**. Note the shown nonce                                                                                                                    | chain only sees `commitmentHash = keccak256(domain‖chainid‖contract‖bidder‖amount‖nonce)`; escrow == bid |
| T+1:00 | Switch to **Bidder B**, commit **0.9 ETH** (different nonce). Show that A's secret did not follow you to B                                                                          | localStorage custody scoped to (chain · contract · account)                                              |
| T+1:30 | Wait for the commit countdown to hit zero (≈5 min unless you shorten it) — reveal tab opens                                                                                         | phase is derived from `block.timestamp`; no stored phase to desync                                       |
| T+2:00 | As **A**: reveal — amount+nonce are pre-filled from the saved secret. As **B**: same                                                                                                | UI recomputes the hash and shows match-vs-mismatch before you sign                                       |
| T+3:00 | “Highest bid” now reads 0.9 with bidder B. Note **escrow==bid means amounts were observable all along** — sealed until reveal, not hidden deposits (say it; it's in SECURITY.md §4) | tie-break: higher bid → earlier reveal → lower address                                                   |
| T+4:30 | Wait for the reveal countdown; press **Settle**                                                                                                                                     | settle makes **no external calls** — it only crystallizes claims (pull payments)                         |
| T+5:00 | As **A**: withdraw 0.4 ETH. Show the claim drop to 0, press Withdraw again → disabled with “Nothing to withdraw for this account”                                                   | double-spend of a claim is impossible at both layers                                                     |
| T+5:30 | As **Seller**: withdraw 0.9 ETH proceeds                                                                                                                                            | seller-as-bidder duality exists too (`withdrawable()` covers both buckets)                               |
| T+6:00 | Security Lab: contract balance = 0 = every claim pulled                                                                                                                             | end-state of invariant I1–I3                                                                             |

MetaMask note (optional): with an extension installed, a **“Connect browser
wallet”** button appears beside the dropdown; the app checks the wallet's
chain vs `VITE_CHAIN_ID` and offers one-click `wallet_switchEthereumChain`
when it differs. For the demo the dropdown (Anvil dev accounts, unlocked,
no keys in the browser) remains the default and the simplest path.

## 4. Rehearsal & automatic checks

Before presenting, either manually rehearse the table above, or run the
automated version (real Chromium through the real UI):

```bash
COMMIT_DURATION=1800 REVEAL_DURATION=3600 npm run dev:local   # fresh stack
npm run audit:wallet-mode       # injected-wallet UI vs a fake EIP-1193 provider (no txs)
npm run audit:full-lifecycle    # 28 checks: commit→secret retrieval→reveal→winner→settle→withdraw→double-withdraw refused→drain-to-0
npm run audit:responsive        # viewports/themes + commit hash cross-check (after a FRESH deploy; see below)
```

⚠️ Both the lifecycle audit and the integration tests **warp chain time**
(`evm_setNextBlockTimestamp`) and permanently consume the deployment.
Always re-run `npm run dev:local` after them for a clean auction.

## 5. Reset / recovery

| Problem                                     | Fix                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline missed mid-demo                    | The auction is spent. Ctrl+C, re-run `npm run dev:local` (~15 s), continue.                                                                                                  |
| Wrong-chain / “no code” banner              | Same — dev.sh re-verifies deployment and rewrites `.env.local`.                                                                                                              |
| A transaction was rejected or reverted      | The banner states why (classification mirrors contract requires); the escrow and your saved secret are untouched — fix the inputs and retry.                                 |
| Forgot/cleared a nonce                      | That bid can never be revealed: the escrow forfeits to the seller at settlement (or refunds early via `refund()` during the commit phase). Honest failure mode — explain it. |
| Port 8545 busy from a stale Anvil           | `lsof -nP -iTCP:8545 -sTCP:LISTEN` and stop **that** process yourself; dev.sh deliberately refuses to kill what it didn't start.                                             |
| A second Vite on :5174 confuses the browser | Close the stale one; present only on `http://localhost:5173`.                                                                                                                |

## 6. What is actually verified (honest tiers)

- **Contract-level** (44 Foundry tests): phases, ties, reentrancy, invariants I1–I3, forced ETH, forfeits.
- **Pure frontend** (80 unit tests): hash byte-equality, secret scoping, gating mirrors, chain-config & wallet-mode precedence, error mapping.
- **Same-code-path integration** (3 tests): the app's viem write path against a live chain incl. hash cross-check vs the deployed contract.
- **Real browser** (Playwright): the complete lifecycle above, driven through the UI, with on-chain receipts/reads as ground truth.
- **Not done**: external audit — this is a security _lab_, not an audited product.
