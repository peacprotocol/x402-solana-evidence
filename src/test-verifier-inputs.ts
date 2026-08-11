/**
 * The verifier against inputs chosen by whoever produced them.
 *
 * The other evidence suite damages documents: a digest that no longer matches, a member that was
 * edited, a file that was removed. This one attacks the reading itself. An evidence directory is
 * handed over by another party, so that party decides how large its files are and what its names
 * point at, and a verifier that reads them without bounds has trusted both of those decisions
 * before it has verified anything at all.
 *
 * The property under test is the same in every case: a bounded, named failure, promptly. Not a
 * crash, not an exhausted process, not a wait that never ends, and never a read of something the
 * directory does not actually contain.
 *
 * This suite creates symbolic links and, for the one case that needs it, spawns `mkfifo` to create
 * a named pipe: there is no Node API for that file type, and a named pipe is the shape that
 * demonstrates a verifier being made to wait rather than to answer. Where the platform cannot
 * express it the case falls back to a file type that is always expressible and says which shape it
 * exercised. Nothing here opens a connection.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { LIMITS } from './binding.ts';
import { X402_LIMITS } from './x402-header.ts';
import { EXPECTED_EVIDENCE_DIR } from './flow/issue-record.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
import { EVIDENCE_ARTIFACTS } from './flow/presence.ts';
import {
  ARTIFACT_CONTAINERS,
  ARTIFACT_MAX_BYTES,
  NO_FOLLOW_AT_OPEN,
  PUBLIC_KEY_FILE_MAX_BYTES,
} from './flow/safe-read.ts';
import { verifyEvidence, type EvidenceVerificationReport } from './flow/verify-evidence.ts';

beginAcceptanceSuite('verifier-inputs');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const fixtureKey = await resolveIssuerKey('fixture');

/** A private copy of the committed evidence, so a case can damage it without damaging the fixture. */
function hostileCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-inputs-'));
  cpSync(EXPECTED_EVIDENCE_DIR, directory, { recursive: true });
  return directory;
}

/**
 * Somewhere outside the evidence directory for a link to point at.
 *
 * Kept until the suite ends rather than removed with the case that made it: a link whose target has
 * already been deleted would be refused for being broken, which is a different and much weaker
 * property than the one under test.
 */
const linkTargets: string[] = [];
function elsewhere(): string {
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-elsewhere-'));
  linkTargets.push(directory);
  return directory;
}

/**
 * Verify a directory and report what came back, with how long it took.
 *
 * A thrown exception is captured rather than allowed to end the suite, because a crash instead of a
 * verdict is precisely the outcome these cases exist to rule out. The elapsed time is carried for
 * the same reason: a verifier that never returns has failed just as completely as one that throws,
 * and only a measurement distinguishes the two.
 */
async function verdictFor(directory: string): Promise<{
  readonly report?: EvidenceVerificationReport;
  readonly thrown?: string;
  readonly elapsedMs: number;
}> {
  const started = Date.now();
  try {
    const report = await verifyEvidence(directory, fixtureKey.publicKey);
    return { report, elapsedMs: Date.now() - started };
  } catch (e) {
    return {
      thrown: `${(e as Error).constructor.name}: ${(e as Error).message}`,
      elapsedMs: Date.now() - started,
    };
  }
}

/** Every failing check name in a report, for a diagnostic that says what did happen instead. */
const failedNames = (report?: EvidenceVerificationReport): string =>
  (report?.checks ?? [])
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail}`)
    .join(' | ') || 'nothing failed';

/**
 * One refused-input case.
 *
 * Four assertions, and all four matter: a verdict came back at all, it is a failure, the named
 * check that failed is the one that describes this refusal, and the reason recorded is the
 * specific one rather than a generic unreadable. The last is what keeps a reader able to tell a
 * file that is too large from a name pointing somewhere else.
 */
async function refusalCase(input: {
  readonly label: string;
  readonly arrange: (directory: string) => void;
  readonly expectCheck: string;
  readonly expectReason: string;
}): Promise<void> {
  const directory = hostileCopy();
  try {
    input.arrange(directory);
    const verdict = await verdictFor(directory);
    check(
      `${input.label}: verification returns a verdict rather than throwing`,
      verdict.thrown === undefined,
      verdict.thrown ?? '',
    );
    check(`${input.label}: the verdict is a failure`, verdict.report?.ok === false);
    const failing = verdict.report?.checks.find((c) => c.name === input.expectCheck && !c.ok);
    check(
      `${input.label}: the failure is reported as "${input.expectCheck}"`,
      failing !== undefined,
      failedNames(verdict.report),
    );
    check(
      `${input.label}: the reason recorded is ${input.expectReason}`,
      failing?.detail.includes(input.expectReason) === true,
      failing?.detail ?? failedNames(verdict.report),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log('\nBounds on what an evidence directory can make the verifier read\n');

// The bounds are grounded in what produced these files, so the two cannot drift apart quietly.
check(
  'the captured field values are bounded by the encoded-value bound the capture path enforces',
  ARTIFACT_MAX_BYTES['artifacts/payment-required.txt'] === X402_LIMITS.maxEncodedValueBytes &&
    ARTIFACT_MAX_BYTES['artifacts/payment-signature.txt'] === X402_LIMITS.maxEncodedValueBytes &&
    ARTIFACT_MAX_BYTES['artifacts/payment-response.txt'] === X402_LIMITS.maxEncodedValueBytes,
);
check(
  'the origin result body is bounded by the body bound the binding path enforces',
  ARTIFACT_MAX_BYTES['origin-result-body.bin'] === LIMITS.maxBodyBytes,
);
check(
  'every artifact carries a positive integer bound and a supplied key file is bounded too',
  EVIDENCE_ARTIFACTS.every(
    (artifact) =>
      Number.isSafeInteger(ARTIFACT_MAX_BYTES[artifact]) && ARTIFACT_MAX_BYTES[artifact] > 0,
  ) && PUBLIC_KEY_FILE_MAX_BYTES > 0,
);
check(
  'every directory the artifact names descend through is checked',
  ARTIFACT_CONTAINERS.length > 0 &&
    EVIDENCE_ARTIFACTS.filter((artifact) => artifact.includes('/')).every((artifact) =>
      ARTIFACT_CONTAINERS.some((container) => artifact.startsWith(`${container}/`)),
    ),
);
console.log(
  `  note  ${
    NO_FOLLOW_AT_OPEN
      ? 'this platform refuses to follow a link at open time'
      : 'this platform has no open-time no-follow flag, so a link is refused by the check before the open'
  }`,
);

/** A file of exactly the given size, written without holding it all in memory at once. */
function writeSized(path: string, bytes: number): void {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const parts: Buffer[] = [];
  let remaining = bytes;
  while (remaining > 0) {
    const take = Math.min(remaining, chunk.length);
    parts.push(chunk.subarray(0, take));
    remaining -= take;
  }
  writeFileSync(path, Buffer.concat(parts));
}

/**
 * FS-BOUND-001. A sidecar larger than a sidecar can be.
 *
 * Refused on the size the descriptor reports, before the bytes are allocated, which is the only
 * point at which refusing costs nothing.
 */
recordExecution('FS-BOUND-001');
await refusalCase({
  label: 'a request binding past its bound',
  arrange: (d) =>
    writeSized(join(d, 'request-binding.json'), ARTIFACT_MAX_BYTES['request-binding.json'] + 1),
  expectCheck: 'every artifact is readable',
  expectReason: 'too_large',
});

/** FS-BOUND-002. The same, for the document with the largest sidecar bound. */
recordExecution('FS-BOUND-002');
await refusalCase({
  label: 'a chain observation past its bound',
  arrange: (d) =>
    writeSized(join(d, 'chain-observation.json'), ARTIFACT_MAX_BYTES['chain-observation.json'] + 1),
  expectCheck: 'every artifact is readable',
  expectReason: 'too_large',
});

/**
 * FS-BOUND-003. The origin result body, which is the artifact with a real producer bound.
 *
 * A body is bounded when it is digested into a binding, so a body past that bound could not have
 * been produced by a run. Reading it back is refused for the same reason it could not be written.
 */
recordExecution('FS-BOUND-003');
await refusalCase({
  label: 'an origin result body past its bound',
  arrange: (d) =>
    writeSized(join(d, 'origin-result-body.bin'), ARTIFACT_MAX_BYTES['origin-result-body.bin'] + 1),
  expectCheck: 'every artifact is readable',
  expectReason: 'too_large',
});

/**
 * FS-BOUND-004. A name that points somewhere else.
 *
 * The link is aimed at a byte-identical copy of the document it replaces, so nothing about the
 * contents explains the refusal: what is refused is the indirection itself. A verifier that
 * followed it would report on a file the directory does not contain, and would say the directory
 * verified.
 */
recordExecution('FS-BOUND-004');
await refusalCase({
  label: 'a symbolic link standing in for a sidecar',
  arrange: (d) => {
    const target = join(elsewhere(), 'chain-observation.json');
    cpSync(join(d, 'chain-observation.json'), target);
    rmSync(join(d, 'chain-observation.json'));
    symlinkSync(target, join(d, 'chain-observation.json'));
  },
  expectCheck: 'every artifact is readable',
  expectReason: 'symbolic_link',
});

/** FS-BOUND-005. The same indirection, one directory down, where the captured field values live. */
recordExecution('FS-BOUND-005');
await refusalCase({
  label: 'a symbolic link standing in for a captured field value',
  arrange: (d) => {
    const target = join(elsewhere(), 'payment-required.txt');
    cpSync(join(d, 'artifacts', 'payment-required.txt'), target);
    rmSync(join(d, 'artifacts', 'payment-required.txt'));
    symlinkSync(target, join(d, 'artifacts', 'payment-required.txt'));
  },
  expectCheck: 'every artifact is readable',
  expectReason: 'symbolic_link',
});

/**
 * FS-BOUND-006. The container rather than the file.
 *
 * Refused before a single artifact below it is read. Checking each nested file individually would
 * not catch this: every one of them would be a regular file of a plausible size, and every path
 * would still look like it names this evidence directory.
 */
recordExecution('FS-BOUND-006');
await refusalCase({
  label: 'a symbolic link standing in for the nested artifact directory',
  arrange: (d) => {
    const target = join(elsewhere(), 'artifacts');
    cpSync(join(d, 'artifacts'), target, { recursive: true });
    rmSync(join(d, 'artifacts'), { recursive: true });
    symlinkSync(target, join(d, 'artifacts'));
  },
  expectCheck: 'nested artifact directories are directories',
  expectReason: 'symbolic_link',
});

/**
 * FS-BOUND-007. A path that is not a file at all.
 *
 * A named pipe is the case worth demonstrating, because opening one for reading waits for a writer
 * that never comes: the failure it produces is not an error but a verifier that never answers. It
 * is refused on the file type, before any open, so the wait cannot begin. Where `mkfifo` is not
 * available the case runs against a directory instead, which every platform expresses and which
 * exercises the same refusal, and says which shape it used.
 */
recordExecution('FS-BOUND-007');
{
  const directory = hostileCopy();
  const target = join(directory, 'chain-observation.json');
  rmSync(target);
  let shape = 'a named pipe';
  try {
    execFileSync('mkfifo', [target], { stdio: 'ignore' });
  } catch {
    shape = 'a directory';
    mkdirSync(target);
    console.log('  note  mkfifo is not available here; the non-regular case ran against a directory');
  }
  const verdict = await verdictFor(directory);
  check(
    `${shape} in place of an artifact returns a verdict rather than throwing`,
    verdict.thrown === undefined,
    verdict.thrown ?? '',
  );
  check(`${shape} in place of an artifact is a failure`, verdict.report?.ok === false);
  const failing = verdict.report?.checks.find((c) => c.name === 'every artifact is readable' && !c.ok);
  check(
    `${shape} is refused as a file type, not reported as absent`,
    failing?.detail.includes('not_a_regular_file') === true,
    failing?.detail ?? failedNames(verdict.report),
  );
  // The bound is loose on purpose: what it rules out is an open that waits for a writer, which
  // never returns at all, rather than a slow machine.
  check(
    `${shape} is refused promptly rather than waited on`,
    verdict.elapsedMs < 10_000,
    `${verdict.elapsedMs}ms`,
  );
  rmSync(directory, { recursive: true, force: true });
}

for (const directory of linkTargets) rmSync(directory, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
