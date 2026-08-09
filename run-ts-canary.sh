#!/usr/bin/env bash
# TypeScript 7 canary. Non-blocking by design: it reports, it never gates.
# Uses the version pinned in devDependencies so the result is reproducible offline.
set -uo pipefail
cd "$(dirname "$0")"
BIN="node_modules/typescript-next/bin/tsc"
if [ ! -f "$BIN" ]; then echo "canary SKIP: typescript-next is not installed"; exit 0; fi
VER="$(node -p "require('./node_modules/typescript-next/package.json').version")"
echo "TypeScript canary: $VER (non-blocking)"
if "$BIN" --noEmit; then echo "canary: clean under $VER"; else echo "canary: diagnostics under $VER (advisory, not a gate)"; fi
exit 0
