#!/usr/bin/env bash
set -euo pipefail

# BlockShield local demo: Anvil (automine) -> deploy CommitRevealAuction -> Vite.
#
# Safety/portability rules:
#   * All paths are derived from this script's location (no hardcoded repo path).
#   * Never kills processes it did not start: refuses to run if the RPC port is
#     already in use; shutdown only targets PIDs captured below.
#   * No placeholder private keys and no zero-address fallback: if deployment or
#     address parsing fails, the script exits with an error.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID=31337
COMMIT_DURATION="${COMMIT_DURATION:-120}"
REVEAL_DURATION="${REVEAL_DURATION:-180}"
ANVIL_LOG="/tmp/blockshield-anvil.log"
ANVIL_PID=""
VITE_PID=""

cleanup() {
    local code=$?
    trap - INT TERM EXIT
    echo ""
    echo "Shutting down services started by this script..."
    if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
        kill "$VITE_PID" 2>/dev/null || true
    fi
    if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
        kill "$ANVIL_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    exit "$code"
}
trap cleanup INT TERM EXIT

# --- Preflight: never clobber an existing chain -------------------------
if curl -s --max-time 1 "$RPC_URL" >/dev/null 2>&1; then
    echo "ERROR: $RPC_URL already serves requests." >&2
    echo "       Stop that Anvil instance yourself; this script never kills" >&2
    echo "       processes it did not start." >&2
    exit 1
fi
if [ ! -x "$ROOT/node_modules/.bin/vite" ]; then
    echo "ERROR: vite binary not found at $ROOT/node_modules/.bin/vite (run npm install)." >&2
    exit 1
fi

# --- Anvil with automining (no --block-time delay) ----------------------
echo "=== Starting Anvil (automine, 3 accounts) ==="
rm -f "$ANVIL_LOG"
anvil -a 3 >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!

ready=0
for _ in $(seq 1 30); do
    if curl -s --max-time 1 "$RPC_URL" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
        echo "ERROR: Anvil exited early; see $ANVIL_LOG" >&2
        exit 1
    fi
    sleep 1
done
if [ "$ready" -ne 1 ]; then
    echo "ERROR: Anvil did not become ready within 30s; see $ANVIL_LOG" >&2
    exit 1
fi
echo "Anvil ready (pid $ANVIL_PID, rpc $RPC_URL, chain $CHAIN_ID)"

# --- Parse unlocked accounts (address lines carry an ETH balance suffix;
#     the private-key section of the Anvil log never does, so keys are
#     excluded, and only exact 40-hex addresses are accepted) --------------
ACCOUNT_LIST=()
while IFS= read -r line; do
    ACCOUNT_LIST+=("$line")
done < <(grep -E '\([0-9]+\) 0x[0-9a-fA-F]{40} .*ETH' "$ANVIL_LOG" | grep -oE '0x[0-9a-fA-F]{40}' | awk '!seen[$0]++' | head -3)

SENDER="${ACCOUNT_LIST[0]:-}"
if ! [[ "$SENDER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: could not parse an unlocked deployer account from $ANVIL_LOG" >&2
    exit 1
fi

echo ""
echo "Unlocked Anvil accounts:"
for i in "${!ACCOUNT_LIST[@]}"; do
    echo "  [$i] ${ACCOUNT_LIST[$i]}"
done

# --- ABI sync: frontend must see the current artifact -------------------
echo ""
echo "=== Syncing ABI + bytecode ==="
bash "$ROOT/scripts/sync-abi.sh"

# --- Deploy (constructor: commit and reveal DURATIONS in seconds) --------
echo ""
echo "=== Deploying CommitRevealAuction (commit=${COMMIT_DURATION}s, reveal=${REVEAL_DURATION}s) ==="
if ! DEPLOY_OUTPUT=$(forge create \
    --rpc-url "$RPC_URL" \
    --unlocked \
    --broadcast \
    --from "$SENDER" \
    src/CommitRevealAuction.sol:CommitRevealAuction \
    --constructor-args "$COMMIT_DURATION" "$REVEAL_DURATION" 2>&1); then
    echo "ERROR: deployment failed:" >&2
    echo "$DEPLOY_OUTPUT" >&2
    exit 1
fi

# Require exactly 40 hex characters after 0x, taken from the address line.
DEPLOYED_ADDRESS=$(printf '%s\n' "$DEPLOY_OUTPUT" \
    | grep -iE 'Deployed to|Contract address' \
    | grep -oE '0x[0-9a-fA-F]{40}' \
    | head -1 || true)
if ! [[ "$DEPLOYED_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: could not parse a 40-hex deploy address from forge create output:" >&2
    echo "$DEPLOY_OUTPUT" >&2
    exit 1
fi

# Verify code actually exists at the address before handing it to the UI.
CODE=$(cast code "$DEPLOYED_ADDRESS" --rpc-url "$RPC_URL")
if [ -z "$CODE" ] || [ "$CODE" = "0x" ]; then
    echo "ERROR: no contract code at $DEPLOYED_ADDRESS" >&2
    exit 1
fi

# Verify the constructor stored sane timestamp deadlines before claiming success.
# cast may append a scientific-notation suffix like "[1.793e9]" — keep digits only.
COMMIT_DL=$(cast call "$DEPLOYED_ADDRESS" "commitDeadline()(uint256)" --rpc-url "$RPC_URL" | grep -oE '[0-9]+' | head -1)
REVEAL_DL=$(cast call "$DEPLOYED_ADDRESS" "revealDeadline()(uint256)" --rpc-url "$RPC_URL" | grep -oE '[0-9]+' | head -1)
NOW=$(cast block latest --rpc-url "$RPC_URL" --field timestamp | grep -oE '[0-9]+' | head -1)
if [ -z "$COMMIT_DL" ] || [ -z "$REVEAL_DL" ] || [ -z "$NOW" ]; then
    echo "ERROR: could not read deadlines from $DEPLOYED_ADDRESS" >&2
    exit 1
fi
if [ "$COMMIT_DL" -le "$NOW" ] || [ "$REVEAL_DL" -le "$COMMIT_DL" ]; then
    echo "ERROR: deadlines are not sane timestamps (now=$NOW commit=$COMMIT_DL reveal=$REVEAL_DL)" >&2
    exit 1
fi

echo ""
echo "Contract deployed and verified: $DEPLOYED_ADDRESS"
echo "  commitDeadline: $COMMIT_DL"
echo "  revealDeadline: $REVEAL_DL"
echo "  chain timestamp: $NOW"

# Persist the deployment so ANY vite start (this child or a plain `npm run dev`)
# picks up the address — Vite auto-loads .env.local from the project root.
{
    echo "# generated by scripts/dev.sh — local dev values, not secrets"
    echo "VITE_RPC_URL=$RPC_URL"
    echo "VITE_CONTRACT_ADDRESS=$DEPLOYED_ADDRESS"
    echo "VITE_CHAIN_ID=$CHAIN_ID"
} >"$ROOT/.env.local"
echo "Wrote $ROOT/.env.local (VITE_CONTRACT_ADDRESS=$DEPLOYED_ADDRESS)"

# --- Vite dev server ----------------------------------------------------
echo ""
echo "=== Starting Vite development server ==="
cd "$ROOT"
export VITE_CONTRACT_ADDRESS="$DEPLOYED_ADDRESS"
"$ROOT/node_modules/.bin/vite" &
VITE_PID=$!
sleep 2
if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "ERROR: vite exited during startup" >&2
    exit 1
fi

echo ""
echo "=== BlockShield Local Demo ==="
echo "  App:      http://localhost:5173"
echo "  RPC:      $RPC_URL (chain $CHAIN_ID, automine)"
echo "  Contract: $DEPLOYED_ADDRESS"
echo "  Accounts:"
for i in "${!ACCOUNT_LIST[@]}"; do
    echo "    [$i] ${ACCOUNT_LIST[$i]}"
done
echo ""
echo "Press Ctrl+C to stop the services started by this script..."

wait
