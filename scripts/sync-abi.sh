#!/usr/bin/env bash
set -euo pipefail

# Copies the ABI and creation bytecode from the current Foundry artifact into
# src/CommitRevealAuction.json, which the frontend imports.
#
# Usage:
#   scripts/sync-abi.sh           # regenerate src/CommitRevealAuction.json
#   scripts/sync-abi.sh --check   # exit 1 if the file is stale vs forge output

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="$ROOT/out/CommitRevealAuction.sol/CommitRevealAuction.json"
TARGET="$ROOT/src/CommitRevealAuction.json"

if [ ! -f "$ARTIFACT" ]; then
    echo "ERROR: $ARTIFACT not found — run 'forge build' first." >&2
    exit 1
fi

generate() {
    node -e '
        const fs = require("fs");
        const artifact = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!Array.isArray(artifact.abi) || !artifact.bytecode || !artifact.bytecode.object) {
            console.error("ERROR: forge artifact is missing abi or bytecode.object");
            process.exit(1);
        }
        // Drop sourceMap: debug metadata changes between builds even when the
        // deployed object is identical, which would make --check report stale.
        const { object, linkReferences } = artifact.bytecode;
        const out = { abi: artifact.abi, bytecode: { object, linkReferences } };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    ' "$ARTIFACT"
}

if [ "${1:-}" = "--check" ]; then
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    generate >"$tmp"
    if [ -f "$TARGET" ] && diff -q "$tmp" "$TARGET" >/dev/null 2>&1; then
        echo "sync-abi: $TARGET is current."
        exit 0
    fi
    echo "sync-abi: STALE — $TARGET differs from the forge artifact. Run: npm run sync-abi" >&2
    diff "$TARGET" "$tmp" 2>/dev/null | head -20 >&2 || true
    exit 1
fi

generate >"$TARGET"
echo "sync-abi: wrote ABI + bytecode -> $TARGET"
