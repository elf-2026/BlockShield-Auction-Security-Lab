# BlockShield: Auction Security Lab

A **sealed-bid commit–reveal auction** implemented as a **local Anvil security
lab**: a Foundry smart contract, a responsive React/Vite dApp, and real
(end-to-end, on-chain-verified) tooling around every security claim.

> ⚠️ **This is a security _demonstration_, not a production service.** It targets
> a local Anvil chain (chain id 31337 by default, configurable via
> `VITE_CHAIN_ID`) with disposable dev accounts. Do not fund it with real
> value — it has had no external audit. See
> [SECURITY.md](SECURITY.md) for exactly what is and is not guaranteed.

## What it demonstrates

Commit–reveal is the classic defense against bid front-running and
copying in auctions. This repo implements one from scratch and uses it as the
subject of a security lab:

- **Two-phase lifecycle** — sealed commitments, then verifiable reveals,
  then a settlement that only crystallizes claims, then pull-based withdrawals.
- **Strict accounting invariants** — every wei in the contract always has
  exactly one claimant; forced-injected ETH is provably unclaimable.
- **A frontend that only tells the truth** — every value rendered comes from
  live `eth_call` reads; every disabled control explains why (mirroring the
  contract's own `require` rules); a browser-driven audit suite proves the
  hashes the UI produces are byte-identical to the contract's.

## Architecture

```
src/CommitRevealAuction.sol   Solidity ^0.8.26 — the auction (single auction per deployment)
test/CommitRevealAuction.t.sol 44 Foundry tests — phases, replay, reentrancy, invariants
script/DeployAuction.sol       forge-script deploy helper
src/App.tsx + src/components/  Responsive dashboard (Tailwind v4, light/dark)
src/utils/
  contract.ts     viem clients, snapshot reads (pending blockTag), typed-gas writes, error classification,
                  injected-wallet (EIP-1193) detection + chain gating
  commitment.ts   V2 commitment hash (reproduces Solidity byte-for-byte) + CSPRNG nonce
  secrets.ts      localStorage bid custody, scoped to (chainId · contract · bidder)
  secretStore.ts  React view over the above via useSyncExternalStore
  gating.ts       pure phase/account gates — same rules as the contract's requires
  store.ts        app state (useSyncExternalStore)
scripts/
  dev.sh                 anvil + forge create + .env.local + vite (one command)
  sync-abi.sh            forge artifact -> src/CommitRevealAuction.json {abi, bytecode} (+ --check)
  verify-responsive.mjs  Playwright: 390/834/1440 px × light/dark + on-chain E2E commit
  audit-full-lifecycle.mjs Playwright: full auction via the UI — 2 commits, secret
                         retrieval per account, reveals, winner, settle, withdrawals,
                         and double-withdrawal rejection (UI + on-chain)
  audit-wallet-mode.mjs  Playwright: injected-wallet UI vs a fake EIP-1193 provider
                         (wrong-chain gating, switch prompt, chainChanged recovery)
  rehearse-live.sh       full live battery: each time-warping check on its own fresh stack
```

## The two-phase lifecycle

`commitDeadline` and `revealDeadline` are unix timestamps fixed at construction
(`constructor(commitDuration, revealDuration)`, each ≥ `MIN_PHASE_DURATION` = 60 s).
`phase()` is **derived** from `block.timestamp` — there is no stored state that
can desynchronize from the deadlines.

```
 Commit                     Reveal                       Settle            Ended
 < commitDeadline   ≤ ts <  revealDeadline       ≥ revealDeadline      settled || canceled
 commit · refund    reveal (exact amount+nonce)  settle (no ETH moves) withdraw
 cancel (seller)
```

1. **Commit** — `commit(hash)` with `msg.value` as escrow. The chain only sees
   `keccak256(abi.encodePacked(domainTagV2, chainid, address(this), bidder, bidAmount, nonce))`.
2. **Reveal** — `reveal(bidAmount, nonce)` must reproduce the stored hash
   **and** equal the escrow exactly (`"Bid must equal escrow"`). Winners are
   tracked with tie-break _higher bid → earlier reveal → lower address_.
3. **Settle** — `settle()` after the reveal deadline. It performs **no
   external calls**: the winner's bid and every unrevealed (forfeited) escrow
   become `sellerProceeds`; revealed losers keep their escrow as claims.
4. **Withdraw** — `withdraw()` pays only the caller's `withdrawable()` balance;
   a failed transfer reverts everything and the claim can be retried.
   `cancel()` (seller, commit phase only) marks the auction dead and every
   escrow becomes individually withdrawable.

The full security model, invariants, test mapping, and honest limitations
(including the fact that escrowed amounts are _observable_ — see
“What commit–reveal does NOT hide”) are in **[SECURITY.md](SECURITY.md)**.

## Prerequisites

- [Foundry](https://getfoundry.sh) (`forge`, `anvil`, `cast`) — built against v1.8.6
- Node.js ≥ 22 (uses `crypto.getRandomValues`; `npm run audit:responsive` needs the
  Playwright-managed Chromium, installed once via `npx playwright install chromium`)
- The forge-std submodule: `git submodule update --init --recursive`

## Quickstart (local lab)

```bash
npm install
forge build                      # compiles contracts + the deploy script
npm run sync-abi                 # regenerate src/CommitRevealAuction.json from out/

# One command: starts anvil (automine), deploys, writes .env.local, starts vite
npm run dev:local
# -> Anvil accounts 0..2 printed and unlocked; account 0 is the seller/deployer
# -> open http://localhost:5173
# -> for a guided presenter flow and recovery steps, see DEMO.md
```

`dev.sh` refuses to run if port 8545 is occupied, kills only what it started
(Ctrl+C cleans up), verifies the deployed bytecode exists, and checks the
stored deadlines before reporting success. The generated `.env.local` contains
`VITE_CONTRACT_ADDRESS` — a plain `npm run dev` afterwards also picks it up.

### Manual steps (what dev.sh automates)

```bash
anvil -a 3
forge create --rpc-url http://127.0.0.1:8545 --unlocked --broadcast \
  --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  src/CommitRevealAuction.sol:CommitRevealAuction \
  --constructor-args 120 180
echo "VITE_CONTRACT_ADDRESS=0x<deployed>" > .env.local
npm run sync-abi && npm run dev
```

Phase lengths are env-tunable in dev.sh: `COMMIT_DURATION=600 REVEAL_DURATION=600
npm run dev:local`. Environment variables are documented in
[`.env.example`](.env.example) (copy to `.env.local`). **Never put private keys
in env files** — the local chain's accounts are unlocked and the browser never
signs with a key it holds.

## Using the UI

1. **Connect an account** — two modes:
   - **Local lab (default):** the “Connect a local account…” dropdown lists the
     unlocked Anvil accounts reported by the node itself (`eth_accounts`).
     Selecting the deployer shows the Seller role; others are Bidders.
   - **Injected wallet:** when an EIP-1193 wallet (MetaMask, Rabby,
     Coinbase Wallet, …) is present, a “Connect browser wallet” button appears
     next to the dropdown. It requests accounts, checks the wallet's chain
     against `VITE_CHAIN_ID`, and offers a one-click
     `wallet_switchEthereumChain` when it differs. Transactions from a wallet
     on the wrong chain are gated before submission — the app never signs with
     keys it doesn't hold (anvil dev accounts sign via `eth_sendTransaction`
     on the node; the wallet signs its own).
2. **Commit** — enter a bid (ETH); a cryptographic nonce is generated and
   shown. Only the hash + escrow go on-chain; the app saves your bid secrets to
   **localStorage, scoped to (chain · contract · account)** — with a loud
   warning: _lose the nonce and your bid can never be revealed._
3. **Reveal** — after `commitDeadline`, your saved amount/nonce are
   pre-filled. The app recomputes the commitment and shows whether it matches
   the on-chain hash before you submit. Switching accounts never exposes
   another bidder's saved secret.
4. **Settle / Withdraw** — after `revealDeadline`, anyone may settle; then
   each party pulls exactly their `withdrawable()` amount (winner's escrow +
   seller proceeds included). Withdrawing twice pays once — the second attempt
   is refused by the UI and reverts on-chain.
5. **Activity feed** — real on-chain events (`getLogs` + ABI decode), plus
   transaction-status toasts and an inline Security Lab panel that shows the
   live solvency invariant (`balance ≥ totalDeposits`).

Wrong chain, missing code, unreachable RPC, failed reads, and rejected
transactions each get a distinct, actionable error — and no fake state is ever
rendered when reads fail.

## Testing & verification

Every claim below is reproducible: the tiers state **how** each behavior is
proven, because contract-level tests alone don't prove the UI is correct.

| Tier          | Command                                     | What it actually proves                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract      | `forge test`                                | 44 tests: phases, ties, reentrancy, solvency invariants, forced ETH, refunds/forfeits — pure EVM behavior, no UI                                                                                                                                                                                                                                                      |
| Frontend unit | `npm run test:frontend`                     | 80 tests: hash byte-equality, secret scoping/leak paths, gating mirrors contract requires, error classification, chain-config + wallet-mode precedence — pure functions, no browser                                                                                                                                                                                   |
| Integration   | `npm run test:integration`                  | 3 tests against a live chain via the same viem write path the app uses: hash cross-check vs `computeCommitmentHash`, full lifecycle, seller-as-bidder dual withdrawal                                                                                                                                                                                                 |
| **Browser**   | `npm run audit:full-lifecycle`              | Real Chromium drives the actual UI: 2 bidders commit → per-account secret auto-retrieval (and cross-account isolation) → reveals after the commit deadline → winner verified in UI **and** chain → settle → withdrawals with balance deltas → **double-withdrawal refused in UI (explicit reason) and reverted on-chain (status 0x0)** → contract drains to exactly 0 |
| **Browser**   | `npm run audit:responsive`                  | 6 viewport×theme checks (390/834/1440 light/dark: overflow, clipping, 44px touch targets, countdown ticking) + mobile E2E commit→on-chain hash verification                                                                                                                                                                                                           |
| Static        | `npm run sync-abi:check` · `npm run verify` | ABI never drifts from the contract; fmt · build · forge · tsc · eslint · prettier · unit tests · vite build                                                                                                                                                                                                                                                           |
| Live battery  | `npm run verify:live`                       | `verify` + integration + responsive + full-lifecycle audits — each live check gets its own fresh stack via `scripts/rehearse-live.sh` (time-warp isolation)                                                                                                                                                                                                           |

`test:integration`, `audit:full-lifecycle`, and the responsive E2E step require
a **fresh deployment in its commit phase** (they source `.env.local`, and they
warp chain time with `evm_setNextBlockTimestamp`, which permanently advances
the local chain). Start the stack with headroom before running them:
`COMMIT_DURATION=1800 REVEAL_DURATION=3600 npm run dev:local`.

Golden commitment vectors are cross-verified against the contract itself; the
UI never assumes a matching hash without the integration check. See
[DEMO.md](DEMO.md) for the presenter runbook and reset/recovery procedure.

## Repo layout

```
src/            Solidity contract, JSON artifact (abi+bytecode), React app
test/  script/  Foundry tests and deploy script
scripts/        dev.sh, sync-abi.sh, verify-responsive.mjs, audit-full-lifecycle.mjs
lib/forge-std   pinned Foundry testing library (submodule)
.github/        CI (forge fmt/build/test + node/npm + vitest + tsc + eslint + build)
audit-artifacts/  (generated) screenshots from the responsive audit — gitignored
```

## License

MIT — see [LICENSE](LICENSE).
