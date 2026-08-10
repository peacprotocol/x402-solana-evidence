/**
 * The evidence directory as something handed to someone else.
 *
 * Every other suite verifies evidence the way the run that produced it can: with the key already in
 * memory, against a directory it just wrote. That is not the position a reader is in. A reader has
 * a directory, a key file, and a command, and this suite exercises exactly that path: the arguments
 * are parsed the way the command parses them, the key is read from a file the way the command reads
 * it, and both failure directions are covered, because a verifier that only ever sees the right key
 * and a well-formed file is a verifier nobody has tested.
 *
 * Nothing here opens a connection or spawns a process.
 */
import { generateKeypair } from '@peac/crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { EXPECTED_EVIDENCE_DIR, EXPECTED_EVIDENCE_DISPLAY } from './flow/issue-record.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
import {
  InvalidPublicKeyFileError,
  readIssuerPublicKeyFile,
  writeIssuerPublicKeyFile,
} from './flow/public-key-file.ts';
import {
  parseVerifyArguments,
  UsageError,
  verifyEvidence,
  type EvidenceVerificationReport,
} from './flow/verify-evidence.ts';

beginAcceptanceSuite('evidence');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const workspace = mkdtempSync(join(tmpdir(), 'peac-evidence-cli-'));

const failedChecks = (report: EvidenceVerificationReport): string[] =>
  report.checks.filter((c) => !c.ok).map((c) => c.name);

/** Run the parser and report whether it refused, without letting a refusal end the suite. */
const usageRefusal = (argv: readonly string[]): string | undefined => {
  try {
    parseVerifyArguments(argv);
    return undefined;
  } catch (e) {
    return e instanceof UsageError ? e.message : `unexpected ${(e as Error).constructor.name}`;
  }
};

/** Read a key file and report the refusal reason, if it was refused. */
const keyRefusal = (path: string): string | undefined => {
  try {
    readIssuerPublicKeyFile(path);
    return undefined;
  } catch (e) {
    return e instanceof InvalidPublicKeyFileError
      ? e.message
      : `unexpected ${(e as Error).constructor.name}`;
  }
};

console.log('\nEvidence verification through the documented arguments\n');

const fixtureKey = await resolveIssuerKey('fixture');

/**
 * EVID-CLI-001. The committed fixture, verified the way an outsider verifies a live run.
 *
 * The key is written out and read back rather than passed along in memory, so the file format is
 * exercised end to end and not merely declared.
 */
recordExecution('EVID-CLI-001');
{
  const keyFile = join(workspace, 'issuer.pub.json');
  writeIssuerPublicKeyFile(keyFile, fixtureKey);

  const request = parseVerifyArguments(['--evidence', EXPECTED_EVIDENCE_DIR, '--public-key', keyFile]);
  check(
    'the arguments name the supplied directory and key file',
    request.directory === EXPECTED_EVIDENCE_DIR && request.publicKeyFile === keyFile,
    `${request.directory}, ${String(request.publicKeyFile)}`,
  );

  const loaded = readIssuerPublicKeyFile(keyFile);
  check(
    'the key file round-trips to the same public key and identifier',
    Buffer.from(loaded.publicKey).equals(Buffer.from(fixtureKey.publicKey)) &&
      loaded.kid === fixtureKey.kid &&
      loaded.issuer === fixtureKey.iss,
    `${loaded.kid}, ${loaded.issuer}`,
  );

  const report = await verifyEvidence(request.directory, loaded.publicKey);
  check(
    'the committed evidence verifies under the supplied key file',
    report.ok,
    failedChecks(report).join(', ') || 'nothing failed',
  );

  // The documented command carries the package manager's `--` separator, which some versions
  // forward verbatim. It has to reach the same request as the form without it.
  const separated = parseVerifyArguments(['--', '--evidence', EXPECTED_EVIDENCE_DIR, '--public-key', keyFile]);
  check(
    'a forwarded argument separator is accepted, so the documented command works either way',
    separated.directory === request.directory && separated.publicKeyFile === request.publicKeyFile,
    `${separated.directory}, ${String(separated.publicKeyFile)}`,
  );

  const noArguments = parseVerifyArguments([]);
  check(
    'no arguments still means the committed fixture and its test key',
    noArguments.directory === EXPECTED_EVIDENCE_DIR &&
      noArguments.display === EXPECTED_EVIDENCE_DISPLAY &&
      noArguments.publicKeyFile === undefined,
  );

  // Each option is useless without the other, and a half-supplied pair must not quietly fall back
  // to the fixture key: a directory that failed for that reason would read as tampering.
  check('--evidence without --public-key is refused', usageRefusal(['--evidence', workspace]) !== undefined);
  check(
    '--public-key without --evidence is refused',
    usageRefusal(['--public-key', join(workspace, 'issuer.pub.json')]) !== undefined,
  );
  check('an option with no value is refused', usageRefusal(['--evidence', '--public-key']) !== undefined);
  check('an unrecognised argument is refused', usageRefusal(['--everything']) !== undefined);
  check(
    'a repeated option is refused rather than resolved by position',
    usageRefusal(['--evidence', 'a', '--evidence', 'b', '--public-key', 'k']) !== undefined,
  );
}

/**
 * EVID-CLI-002. A key that did not sign this record.
 *
 * The failure has to name the signature stage. "Verification failed" would leave a reader unable to
 * tell a wrong key from an edited document, which are different problems with different answers.
 */
recordExecution('EVID-CLI-002');
{
  const other = await generateKeypair();
  const keyFile = join(workspace, 'other-issuer.pub.json');
  writeIssuerPublicKeyFile(keyFile, {
    publicKey: other.publicKey,
    kid: 'a-key-that-signed-nothing-here',
    iss: 'https://elsewhere.example.test',
  });

  const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, readIssuerPublicKeyFile(keyFile).publicKey);
  const signature = report.checks.find((c) => c.name === 'record signature and schema');
  check(
    'evidence verified under the wrong key is refused at the signature stage',
    !report.ok && signature?.ok === false && signature.detail === 'E_INVALID_SIGNATURE',
    `${String(signature?.detail)}`,
  );
  check(
    'and nothing downstream of the signature is reported as checked',
    report.checks.length === 1,
    report.checks.map((c) => c.name).join(', '),
  );
}

/**
 * EVID-CLI-003. Key files that cannot be used.
 *
 * Each is refused with the file and the reason named. Guessing at any of them would report a result
 * about material the reader did not choose.
 */
recordExecution('EVID-CLI-003');
{
  const write = (name: string, contents: string): string => {
    const path = join(workspace, name);
    writeFileSync(path, contents);
    return path;
  };
  const hex = Buffer.from(fixtureKey.publicKey).toString('hex');

  const cases: ReadonlyArray<{ readonly label: string; readonly path: string }> = [
    { label: 'a file that is not there', path: join(workspace, 'absent.pub.json') },
    { label: 'a file that is not JSON', path: write('not-json.pub.json', '{ not json') },
    { label: 'a JSON array rather than a key object', path: write('array.pub.json', '[]') },
    {
      label: 'a key of another algorithm',
      path: write('rsa.pub.json', JSON.stringify({ algorithm: 'RSA', kid: 'k', issuer: 'i', publicKey: hex })),
    },
    {
      label: 'a key with no identifier',
      path: write('no-kid.pub.json', JSON.stringify({ algorithm: 'Ed25519', issuer: 'i', publicKey: hex })),
    },
    {
      label: 'a key naming no issuer',
      path: write('no-issuer.pub.json', JSON.stringify({ algorithm: 'Ed25519', kid: 'k', publicKey: hex })),
    },
    {
      label: 'a key that is not 32 bytes of hex',
      path: write('short.pub.json', JSON.stringify({ algorithm: 'Ed25519', kid: 'k', issuer: 'i', publicKey: hex.slice(0, 40) })),
    },
    {
      label: 'a key carrying non-hex characters',
      path: write('non-hex.pub.json', JSON.stringify({ algorithm: 'Ed25519', kid: 'k', issuer: 'i', publicKey: `${'z'.repeat(2)}${hex.slice(2)}` })),
    },
  ];

  for (const { label, path } of cases) {
    const refusal = keyRefusal(path);
    check(`${label} is refused`, refusal !== undefined, 'it was accepted');
    check(
      `${label} names the file and a reason`,
      refusal !== undefined && refusal.includes('reason:') && refusal.includes('.pub.json'),
      refusal ?? '',
    );
  }

  // A refused key file is never written over: the caller supplied it, and repairing it is theirs.
  const keyFile = join(workspace, 'issuer.pub.json');
  check(
    'writing a public key never replaces an existing file',
    (() => {
      try {
        writeIssuerPublicKeyFile(keyFile, fixtureKey);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EEXIST';
      }
    })(),
  );
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
