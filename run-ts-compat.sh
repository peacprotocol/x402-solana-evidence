#!/usr/bin/env bash
# TypeScript 6 compatibility gate.
#
# TypeScript 7 is the primary typecheck (pnpm typecheck). This runs the same sources through the
# side-by-side TypeScript 6 compiler so a consumer still on 6.x is not left with a project that
# only compiles under 7. It is a GATE: a diagnostic here fails the run.
set -euo pipefail
cd "$(dirname "$0")"
BIN="node_modules/@typescript/typescript6/bin/tsc6"
if [ ! -f "$BIN" ]; then
  echo "compat gate FAILED: @typescript/typescript6 is not installed" >&2
  exit 1
fi
# Two different versions, and reporting the wrong one makes this gate claim something it did not
# check. The package version is the version of the wrapper that ships the compiler; the compiler
# that actually runs reports its own, and they are not the same number. What the sources were
# checked under is the second one, so it is taken from the binary that is about to run and is the
# one the result below is stated against.
COMPILER="$("$BIN" --version)"
WRAPPER="$(node -p "require('./node_modules/@typescript/typescript6/package.json').version")"
echo "TypeScript compatibility gate"
echo "  compiler: $COMPILER"
echo "  wrapper package @typescript/typescript6: $WRAPPER"
"$BIN" --noEmit
echo "compat: clean under the compiler above ($COMPILER)"
