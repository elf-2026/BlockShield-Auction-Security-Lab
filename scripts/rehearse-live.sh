#!/usr/bin/env bash
# scripts/rehearse-live.sh — full live battery against real chains.
#
# Each time-warping check (integration, responsive E2E, full-lifecycle) needs
# its OWN fresh deployment in the commit phase: evm_setNextBlockTimestamp and
# real txs permanently consume a deployment's phases, and the browser audits
# share Anvil account 2's on-chain commitment state. This script runs them
# against fresh stacks in order and cleans up only processes it started.
#
# Usage: bash scripts/rehearse-live.sh [--keep]
#   --keep  leave the stack running at the end (for an immediate demo)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
DEV_PID=""
FAILED=""

say()  { echo ""; echo "=== $* ==="; }
die()  { echo "ERROR: $*" >&2; exit 1; }

start_stack() {
    if curl -s --max-time 1 http://127.0.0.1:8545 >/dev/null 2>&1; then
        die "port 8545 already in use — stop the existing Anvil first (this script never kills processes it didn't start)"
    fi
    COMMIT_DURATION=1800 REVEAL_DURATION=3600 bash scripts/dev.sh >/tmp/blockshield-rehearse-dev.log 2>&1 &
    DEV_PID=$!
    for _ in $(seq 1 40); do
        grep -q "deployed and verified" /tmp/blockshield-rehearse-dev.log 2>/dev/null && return 0
        kill -0 "$DEV_PID" 2>/dev/null || { cat /tmp/blockshield-rehearse-dev.log; die "dev.sh exited early"; }
        sleep 1
    done
    cat /tmp/blockshield-rehearse-dev.log
    die "stack did not deploy within 40s"
}

stop_stack() {
    if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
        kill "$DEV_PID" 2>/dev/null # dev.sh's trap stops only its own anvil+vite
        wait "$DEV_PID" 2>/dev/null
    fi
    DEV_PID=""
    for _ in $(seq 1 20); do
        curl -s --max-time 1 http://127.0.0.1:8545 >/dev/null 2>&1 || return 0
        sleep 1
    done
    echo "WARN: 8545 still busy after cleanup" >&2
}

step() { # step <name> <cmd...>
    local name="$1"; shift
    say "$name"
    if "$@"; then
        say "$name: PASS"
    else
        say "$name: FAIL"
        FAILED="$FAILED $name"
    fi
}

trap 'stop_stack' INT TERM EXIT

say "rehearse-live: static battery (verify) against a CLEAN tree"
step "npm run verify" npm run verify || true

start_stack
step "integration (own deployments, warps chain time)" npm run test:integration || true
stop_stack

start_stack
step "responsive audit (E2E commit, fresh localStorage browser)" npm run audit:responsive || true
stop_stack

start_stack
step "wallet-mode audit (fake EIP-1193 provider; no transactions sent)" npm run audit:wallet-mode || true
step "full-lifecycle audit (2 bidders, reveals, settle, withdraw, double-withdraw refused)" npm run audit:full-lifecycle || true

if [ "$KEEP" -eq 1 ]; then
    trap - INT TERM EXIT
    echo ""; echo "Stack left running for a live demo: http://localhost:5173"
    echo "Contract: $(grep -h VITE_CONTRACT_ADDRESS "$ROOT/.env.local")"
else
    stop_stack
fi

echo ""
if [ -n "$FAILED" ]; then
    echo "REHEARSAL FAILED:$FAILED"
    exit 1
fi
echo "REHEARSAL: ALL LIVE CHECKS PASSED"
