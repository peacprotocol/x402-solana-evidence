#!/usr/bin/env node
/**
 * The whole test suite, run without a package manager on `PATH`.
 *
 * WHY THIS EXISTS. The `test` script used to chain `pnpm test:imports && pnpm test:golden && ...`,
 * which means the script only runs if a `pnpm` executable is already resolvable. Someone who has
 * no global install and follows the documented `corepack pnpm@8.15.0 test` gets
 * `sh: pnpm: command not found`: corepack runs the outer command, but the shell it spawns for the
 * script has no shim for the nested ones. A reader evaluating this example should not have to
 * debug the runner before seeing a single check.
 *
 * So each step is spawned directly as `node <local entry point>`, using the same Node that started
 * this process and the binaries the install already placed in `node_modules`. Nothing is resolved
 * from `PATH`, and no step invokes a package manager.
 *
 * ORDER AND FAIL-FAST. Steps run sequentially and the first failure stops the run, because a later
 * step reading a directory an earlier one was supposed to write produces a confusing second
 * failure rather than more information. The acceptance-completeness gate runs last by
 * construction: it checks that every declared case executed, so it is only meaningful once
 * everything that records a case has run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Local entry points, addressed as files rather than as commands. */
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const COMPAT_GATE = join(ROOT, 'run-ts-compat.sh');

/** A TypeScript source run through the local tsx entry point by the running Node. */
const suite = (entry) => ({ command: process.execPath, args: [TSX, join(ROOT, entry)] });

const STEPS = [
  { name: 'dependency import smoke', step: suite('src/imports-smoke.ts') },
  { name: 'deterministic validation vectors', step: suite('src/test-golden.ts') },
  { name: 'rejection corpus', step: suite('src/test-negative.ts') },
  { name: 'key persistence', step: suite('src/test-keys.ts') },
  { name: 'preflight revalidation', step: suite('src/test-preflight.ts') },
  { name: 'offline end-to-end flow', step: suite('src/flow/fixture-e2e.ts') },
  // The CI no-network job runs this file under plain node, whose strip-only TypeScript mode
  // rejects syntax that tsx compiles away (parameter properties, enums). Running it here under
  // plain node keeps that whole class of failure catchable without a container runtime.
  {
    name: 'offline flow under type-stripping node',
    step: { command: process.execPath, args: ['src/flow/fixture-e2e.ts'] },
  },
  { name: 'security, replay, binding and tamper matrix', step: suite('src/test-svm-matrix.ts') },
  { name: 'evidence emission and verification', step: suite('src/test-evidence.ts') },
  { name: 'typecheck (primary)', step: { command: process.execPath, args: [TSC, '--noEmit'] } },
  // The compatibility gate stays one script rather than being restated here, so the version it
  // pins and the diagnostics it treats as fatal have a single definition. It spawns node itself.
  { name: 'typecheck (compatibility)', step: { command: COMPAT_GATE, args: [] } },
  { name: 'acceptance matrix completeness', step: suite('src/test-acceptance.ts') },
];

/** Fail before the first step rather than midway, with the command that fixes it. */
const REQUIRED = [TSX, TSC, COMPAT_GATE];
const missing = REQUIRED.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error('\nDependencies are not installed. Missing:');
  for (const path of missing) console.error(`  ${relative(ROOT, path)}`);
  console.error('\nInstall them first:\n  corepack pnpm@8.15.0 install --frozen-lockfile\n');
  process.exit(1);
}

for (const [index, { name, step }] of STEPS.entries()) {
  console.log(`\n=== ${index + 1}/${STEPS.length}  ${name}`);
  const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(`\nFAILED to start: ${name}\n  ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal !== null) {
    console.error(`\nFAILED: ${name} was terminated by ${result.signal}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nFAILED: ${name} exited ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${STEPS.length} steps passed.\n`);
