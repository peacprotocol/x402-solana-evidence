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
import * as F from '../fixtures/deterministic.ts';
import { buildEvidence, FIXTURE_EVIDENCE_OPTIONS, runOnce } from './flow/fixture-e2e.ts';
import {
  EXPECTED_EVIDENCE_DIR,
  EXPECTED_EVIDENCE_DISPLAY,
  writeEvidence,
} from './flow/issue-record.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
import { observeSettlement } from './flow/observe-settlement.ts';
import {
  observeTransaction,
  type TransactionStatus,
  type TransactionStatusSource,
} from './flow/observe-transaction.ts';
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

// ---------------------------------------------------------------------------------------------
// A second observer of the same settlement, asked through an injected source.
// ---------------------------------------------------------------------------------------------

console.log('\nThe node observation, through an injected status source\n');

const TRANSACTION = F.TX_SIGNATURE;
const OBSERVED_AT = F.FIXED_NOW_UNIX_SECONDS;

/** A source that answers, remembering what it was asked. Opens nothing. */
function answering(status: TransactionStatus): TransactionStatusSource & { asked: () => string[] } {
  const asked: string[] = [];
  return {
    reference: 'https://api.devnet.example.test/rpc',
    asked: () => asked,
    async status(signature) {
      asked.push(signature);
      return status;
    },
  };
}

/**
 * SVM-RPC-001. A node answered, and what it said is recorded as its own observation.
 *
 * The point is attribution rather than content: the facilitator's account of the settlement and the
 * node's account of the transaction stay separate documents inside one chain observation, each
 * naming who supplied it.
 */
recordExecution('SVM-RPC-001');
{
  const source = answering({
    slot: F.OBSERVED_SLOT,
    commitment: F.COMMITMENT_LEVEL,
    reportedTransactionError: false,
  });
  const observation = await observeTransaction({
    source,
    transactionSignature: TRANSACTION,
    observedAtUnixSeconds: OBSERVED_AT,
  });

  check('the node was asked about the transaction the settlement reported', source.asked()[0] === TRANSACTION);
  check(
    'the observation records the slot and commitment the node reported',
    observation.status === 'observed' &&
      observation.observedSlot === F.OBSERVED_SLOT &&
      observation.commitment === F.COMMITMENT_LEVEL,
    `${observation.status}, slot ${String(observation.observedSlot)}`,
  );
  check(
    'it names the endpoint that answered, and names it as a node',
    observation.source.kind === 'rpc' && observation.source.reference === source.reference,
  );
  check(
    'the sentence reports what was said rather than asserting it',
    observation.statement.startsWith(`RPC ${source.reference} reported transaction ${TRANSACTION}`) &&
      observation.statement.includes(`at slot ${F.OBSERVED_SLOT}`) &&
      observation.statement.includes(`with commitment ${F.COMMITMENT_LEVEL}`),
    observation.statement,
  );
  check(
    'and claims nothing about finality, settlement or funds',
    !/\bfinal\b|\bfinality\b|\bconfirmed that\b|\bproves\b|\bfunds\b/i.test(observation.statement),
    observation.statement,
  );

  // In the document: separate from the facilitator's account, and bound to the same transaction.
  const settled = observeSettlement({
    requirements: F.PAYMENT_REQUIREMENTS,
    paymentPayload: F.PAYMENT_PAYLOAD,
    settleResponse: F.SETTLEMENT_RESPONSE,
    lifecycle: { states: [], terminalState: 'response_write_attempted' },
    observationSource: { kind: 'facilitator', reference: 'https://facilitator.example.test/' },
    rpcObservation: observation,
    observedAtUnixSeconds: OBSERVED_AT,
    assetDecimals: F.TOKEN_DECIMALS,
  });
  check(
    'the chain observation carries both accounts, kept apart',
    settled.observationSource.kind === 'facilitator' &&
      settled.rpcObservation?.source.kind === 'rpc' &&
      settled.rpcObservation.transactionSignature === settled.transactionSignature,
    `${settled.observationSource.kind}, ${String(settled.rpcObservation?.source.kind)}`,
  );

  // A run that settled nothing has no transaction, so a node's account cannot be attached to it.
  const notSettled = observeSettlement({
    requirements: F.PAYMENT_REQUIREMENTS,
    paymentPayload: F.PAYMENT_PAYLOAD,
    lifecycle: { states: [], terminalState: 'verification_rejected' },
    observationSource: { kind: 'facilitator', reference: 'https://facilitator.example.test/' },
    rpcObservation: observation,
    observedAtUnixSeconds: OBSERVED_AT,
    assetDecimals: F.TOKEN_DECIMALS,
  });
  check(
    'a refused settlement carries no node observation, because it has no transaction',
    notSettled.rpcObservation === undefined && notSettled.transactionSignature === undefined,
  );
}

/**
 * SVM-RPC-002. The node could not answer.
 *
 * Recorded as an observation that could not be made, with a reason from a fixed vocabulary rather
 * than from whatever the endpoint returned. The settlement already happened and the facilitator's
 * account of it is recorded either way, so this must not cost the run its evidence.
 */
recordExecution('SVM-RPC-002');
{
  const unreachable: TransactionStatusSource = {
    reference: 'https://api.devnet.example.test/rpc',
    status: () => Promise.reject(new Error('connect ECONNREFUSED 203.0.113.7:443 <server text>')),
  };
  const silent: TransactionStatusSource = {
    reference: 'https://api.devnet.example.test/rpc',
    status: () => Promise.resolve(undefined),
  };

  const failedCall = await observeTransaction({
    source: unreachable,
    transactionSignature: TRANSACTION,
    observedAtUnixSeconds: OBSERVED_AT,
  });
  const noStatus = await observeTransaction({
    source: silent,
    transactionSignature: TRANSACTION,
    observedAtUnixSeconds: OBSERVED_AT,
  });

  check(
    'an endpoint that could not be reached is recorded as unavailable, not as absent',
    failedCall.status === 'unavailable' && (failedCall.unavailableReason ?? '').length > 0,
    String(failedCall.unavailableReason),
  );
  check(
    'an endpoint that knows no status for the transaction is recorded as such',
    noStatus.status === 'unavailable' && noStatus.unavailableReason !== failedCall.unavailableReason,
    `${String(noStatus.unavailableReason)}`,
  );
  check(
    'neither records a slot or a commitment it was never given',
    failedCall.observedSlot === undefined &&
      failedCall.commitment === undefined &&
      noStatus.observedSlot === undefined,
  );
  check(
    'the reason retains no text the endpoint supplied',
    !failedCall.unavailableReason!.includes('server text') &&
      !failedCall.unavailableReason!.includes('203.0.113.7'),
    failedCall.unavailableReason!,
  );
  check(
    'the sentence still says who was asked and what came back',
    failedCall.statement.startsWith(`RPC ${unreachable.reference} did not report a status`) &&
      failedCall.statement.includes(TRANSACTION),
    failedCall.statement,
  );

  // The evidence is still emitted, and still verifies, with the unavailable observation in it.
  const run = await runOnce();
  const layout = await buildEvidence(run, { ...FIXTURE_EVIDENCE_OPTIONS, rpcObservation: failedCall });
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-rpc-'));
  writeEvidence(directory, layout);
  const report = await verifyEvidence(directory, fixtureKey.publicKey);
  check(
    'evidence carrying an unavailable node observation still verifies',
    report.ok,
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'and the verifier reports the node observation as its own check',
    report.checks.some((c) => c.name === 'rpc observation' && c.ok),
    report.checks.map((c) => c.name).join(', '),
  );

  // A node observation naming a different transaction is inconsistent evidence, and is refused.
  const observationDocument = JSON.parse(
    new TextDecoder().decode(layout.files.get('chain-observation.json')),
  ) as Record<string, unknown>;
  const mismatched = new Map(layout.files).set(
    'chain-observation.json',
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          ...observationDocument,
          rpcObservation: { ...failedCall, transactionSignature: 'AnotherTransaction11111111' },
        },
        null,
        2,
      )}\n`,
    ),
  );
  const tamperedDirectory = mkdtempSync(join(tmpdir(), 'peac-evidence-rpc-'));
  writeEvidence(tamperedDirectory, { jws: layout.jws, files: mismatched });
  const tamperedReport = await verifyEvidence(tamperedDirectory, fixtureKey.publicKey);
  check(
    'a node observation naming another transaction is refused as inconsistent',
    tamperedReport.checks.some((c) => c.name === 'rpc observation' && !c.ok),
    tamperedReport.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 'nothing failed',
  );

  rmSync(directory, { recursive: true, force: true });
  rmSync(tamperedDirectory, { recursive: true, force: true });
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
