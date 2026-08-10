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
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import * as F from '../fixtures/deterministic.ts';
import {
  createFixtureFacilitatorClient,
  DUPLICATE_SETTLEMENT_REASON,
} from './flow/fixture-facilitator.ts';
import { buildEvidence, FIXTURE_EVIDENCE_OPTIONS, runOnce } from './flow/fixture-e2e.ts';
import { createPaidResource } from './flow/server.ts';
import {
  EvidenceCollisionError,
  EXPECTED_EVIDENCE_DIR,
  EXPECTED_EVIDENCE_DISPLAY,
  prepareRunOutputs,
  writeEvidence,
  writeEvidenceTransactionally,
} from './flow/issue-record.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
import { FAILURE_REASONS, persistableFailureReason } from './flow/failure-vocabulary.ts';
import { checkFacilitatorSupport } from './flow/preflight.ts';
import { observeSettlement } from './flow/observe-settlement.ts';
import {
  observeTransaction,
  publicEndpointReference,
  solanaRpcSource,
  type TransactionStatus,
  type TransactionStatusSource,
} from './flow/observe-transaction.ts';
import { facilitatorReference } from './flow/devnet-demo.ts';
import {
  InvalidPublicKeyFileError,
  readIssuerPublicKeyFile,
  writeIssuerPublicKeyFile,
  type LoadedIssuerPublicKey,
} from './flow/public-key-file.ts';
import {
  formatReport,
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
// What a key file says about itself, against what the record says.
// ---------------------------------------------------------------------------------------------

console.log('\nSupplied key metadata, against the signed record\n');

{
  /** Write a key file carrying the fixture key bytes under whatever description is asked for. */
  const describedAs = (name: string, kid: string, iss: string): LoadedIssuerPublicKey => {
    const path = join(workspace, name);
    writeIssuerPublicKeyFile(path, { publicKey: fixtureKey.publicKey, kid, iss });
    return readIssuerPublicKeyFile(path);
  };
  const metadataOf = (key: LoadedIssuerPublicKey) => ({
    algorithm: key.algorithm,
    kid: key.kid,
    issuer: key.issuer,
  });
  const named = (report: EvidenceVerificationReport, name: string) =>
    report.checks.find((c) => c.name === name);

  const KID_CHECK = 'supplied key identifier matches the record';
  const ISSUER_CHECK = 'supplied key issuer matches the record';
  const ALGORITHM_CHECK = 'supplied key algorithm';

  recordExecution('KEYMETA-001');
  {
    const key = describedAs('wrong-kid.pub.json', 'a-key-identifier-the-record-does-not-name', fixtureKey.iss);
    const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, key.publicKey, metadataOf(key));

    check('the signature still verifies, because the bytes are right', named(report, 'record signature and schema')?.ok === true);
    check('but the declared key identifier is reported as inconsistent', named(report, KID_CHECK)?.ok === false);
    check('and the issuer, which does agree, is reported as agreeing', named(report, ISSUER_CHECK)?.ok === true);
    check('so the directory does not verify overall', report.ok === false);
  }

  recordExecution('KEYMETA-002');
  {
    const key = describedAs('wrong-issuer.pub.json', fixtureKey.kid, 'https://elsewhere.example.test');
    const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, key.publicKey, metadataOf(key));

    check('the signature still verifies, because the bytes are right', named(report, 'record signature and schema')?.ok === true);
    check('but the declared issuer is reported as inconsistent', named(report, ISSUER_CHECK)?.ok === false);
    check('and the key identifier, which does agree, is reported as agreeing', named(report, KID_CHECK)?.ok === true);
    check('so the directory does not verify overall', report.ok === false);
  }

  recordExecution('KEYMETA-003');
  {
    const key = describedAs('matching.pub.json', fixtureKey.kid, fixtureKey.iss);
    const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, key.publicKey, metadataOf(key));

    check('a key file that describes the signing key verifies', report.ok, failedChecks(report).join(', ') || 'nothing failed');
    check('the algorithm is reported as its own check', named(report, ALGORITHM_CHECK)?.ok === true);
    check('the key identifier is reported as its own check', named(report, KID_CHECK)?.ok === true);
    check('the issuer is reported as its own check', named(report, ISSUER_CHECK)?.ok === true);

    // A key file declaring an algorithm this example does not verify under is refused as a file,
    // so the report's own check is exercised directly to prove it is live rather than decorative.
    const wrongAlgorithm = await verifyEvidence(EXPECTED_EVIDENCE_DIR, key.publicKey, {
      ...metadataOf(key),
      algorithm: 'RSA',
    });
    check('a declared algorithm this example does not verify under fails its check', named(wrongAlgorithm, ALGORITHM_CHECK)?.ok === false);
    check('and that alone stops the directory verifying', wrongAlgorithm.ok === false);
  }

  recordExecution('KEYMETA-004');
  {
    const other = await generateKeypair();
    const path = join(workspace, 'other-bytes.pub.json');
    writeIssuerPublicKeyFile(path, {
      publicKey: other.publicKey,
      kid: fixtureKey.kid,
      iss: fixtureKey.iss,
    });
    const key = readIssuerPublicKeyFile(path);
    const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, key.publicKey, metadataOf(key));

    // Metadata that agrees changes nothing: the bytes did not sign this record, and that is
    // reported at the signature stage with nothing downstream claimed to have been checked.
    check('key bytes that did not sign the record fail at the signature stage', named(report, 'record signature and schema')?.ok === false);
    check('and no metadata check is reported as having run', report.checks.length === 1, report.checks.map((c) => c.name).join(', '));
  }
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

// ---------------------------------------------------------------------------------------------
// Two observers of the same transaction, saying different things.
// ---------------------------------------------------------------------------------------------

console.log('\nTwo observers of the same transaction\n');

/**
 * Build a real evidence directory carrying one node observation, and verify it.
 *
 * The observation is produced by the same function the live run uses, through an injected status
 * source, and then written into evidence the same way: what is being exercised is the verifier
 * reading a signed document, not a hand-written fixture that happens to have the right fields.
 */
async function verifiedWithObservation(
  status: TransactionStatus | 'unavailable',
): Promise<{ readonly report: EvidenceVerificationReport; readonly rendered: string }> {
  const source: TransactionStatusSource = {
    reference: 'https://api.devnet.example.test/rpc',
    status: () => Promise.resolve(status === 'unavailable' ? undefined : status),
  };
  const run = await runOnce();
  const observation = await observeTransaction({
    source,
    transactionSignature: run.origin.lifecycle.transaction ?? TRANSACTION,
    observedAtUnixSeconds: OBSERVED_AT,
  });
  const layout = await buildEvidence(run, {
    ...FIXTURE_EVIDENCE_OPTIONS,
    rpcObservation: observation,
  });
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-agree-'));
  writeEvidence(directory, layout);
  const report = await verifyEvidence(directory, fixtureKey.publicKey);
  rmSync(directory, { recursive: true, force: true });
  return { report, rendered: formatReport('evidence', report) };
}

/**
 * OBS-AGREE-001. Both observers reported the same thing, so there is nothing to report.
 *
 * Stated as its own case because a warning that fires on agreement is worse than no warning: it
 * would train a reader to ignore the one that matters.
 */
recordExecution('OBS-AGREE-001');
{
  const { report, rendered } = await verifiedWithObservation({
    slot: F.OBSERVED_SLOT,
    commitment: F.COMMITMENT_LEVEL,
    reportedTransactionError: false,
  });
  check('agreeing observers verify', report.ok, failedChecks(report).join(', ') || 'nothing failed');
  check('and raise no warning', report.warnings.length === 0, report.warnings.map((w) => w.name).join(', '));
  check('and the printed report shows no warning line', !rendered.includes('warn  '), rendered);
}

/**
 * OBS-AGREE-002. The facilitator reported success and the node reported an execution error.
 *
 * The record is intact and says exactly what each observer said, so the signature is valid and the
 * digests recompute: failing here would be reporting a cryptographic problem that does not exist.
 * What the reader gets is the disagreement, unreconciled, and a verdict that still stands.
 */
recordExecution('OBS-AGREE-002');
{
  const { report, rendered } = await verifiedWithObservation({
    slot: F.OBSERVED_SLOT,
    commitment: F.COMMITMENT_LEVEL,
    reportedTransactionError: true,
  });

  check(
    'the disagreement is reported as a warning',
    report.warnings.some((w) => w.name === 'observer disagreement'),
    report.warnings.map((w) => w.name).join(', ') || 'no warning',
  );
  check(
    'the warning names both accounts without deciding between them',
    report.warnings.some(
      (w) =>
        w.detail.includes('the facilitator reported settlement success') &&
        w.detail.includes('execution error') &&
        w.detail.includes('have not been reconciled'),
    ),
    report.warnings.map((w) => w.detail).join(' | '),
  );
  check(
    'integrity still passes: the evidence verifies',
    report.ok,
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'and the signature check in particular is not failed by a disagreement',
    report.checks.some((c) => c.name === 'record signature and schema' && c.ok),
  );
  check('no check is reported as failing', failedChecks(report).length === 0, failedChecks(report).join(', '));
  check('the printed report marks it as a warning, distinctly from ok and FAIL', rendered.includes('  warn  observer disagreement:'), rendered);
  check('and still prints the verdict as verified', rendered.includes('Verified. Contents are intact'), rendered);
  check(
    'and says plainly that a warning is not part of the verdict',
    rendered.includes('not part of this verdict'),
    rendered,
  );
}

/**
 * OBS-AGREE-003. The node had nothing to say.
 *
 * An observation that could not be made is a fact about the run, not a disagreement, and above all
 * not agreement: silence must never be written up as a second observer confirming the first.
 */
recordExecution('OBS-AGREE-003');
{
  const { report, rendered } = await verifiedWithObservation('unavailable');
  check('an unavailable node still verifies', report.ok, failedChecks(report).join(', ') || 'nothing failed');
  check('and raises no warning, because nobody disagreed', report.warnings.length === 0, report.warnings.map((w) => w.name).join(', '));
  check(
    'it is recorded as an informational check saying no status was reported',
    report.checks.some((c) => c.name === 'rpc observation' && c.ok && c.detail.includes('no status')),
    report.checks.find((c) => c.name === 'rpc observation')?.detail ?? 'no such check',
  );
  check(
    'and nothing in the report reads as corroboration',
    !/\bagree|\bconfirm|\bcorroborat|\bprove/i.test(rendered),
    rendered,
  );
}

// ---------------------------------------------------------------------------------------------
// Endpoint references, against URLs built to leak.
// ---------------------------------------------------------------------------------------------

console.log('\nEndpoint references, against URLs built to leak\n');

/** Every file under a directory, so a scan cannot miss one by not knowing it exists. */
function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/**
 * Everything an evidence directory would show a reader, as text.
 *
 * The record is a compact JWS, so its payload is decoded as well: a value that reached the record
 * would otherwise sit behind base64 and pass a plain substring scan.
 */
function emittedText(directory: string): string {
  const parts: string[] = [];
  for (const file of filesUnder(directory)) {
    const text = readFileSync(file, 'utf8');
    parts.push(text);
    if (file.endsWith('record.jws')) {
      const payload = text.trim().split('.')[1];
      if (payload !== undefined) parts.push(Buffer.from(payload, 'base64url').toString('utf8'));
    }
  }
  return parts.join('\n');
}

{
  const leakyRun = await runOnce();

  const cases = [
    {
      id: 'RED-URL-001' as const,
      label: 'userinfo and password',
      url: 'https://ruser:PASSWORDSECRET1@rpc.example.test/',
      forbidden: ['ruser', 'PASSWORDSECRET1'],
    },
    {
      id: 'RED-URL-002' as const,
      label: 'a token in the path',
      url: 'https://rpc.example.test/PATHSEGMENTSECRET/PATHTOKENSECRET2',
      forbidden: ['PATHTOKENSECRET2', 'PATHSEGMENTSECRET'],
    },
    {
      id: 'RED-URL-003' as const,
      label: 'an API key in the query',
      url: 'https://rpc.example.test/?apiKey=QUERYSECRET3',
      forbidden: ['QUERYSECRET3', 'apiKey'],
    },
    {
      id: 'RED-URL-004' as const,
      label: 'a fragment',
      url: 'https://rpc.example.test/#FRAGMENTSECRET4',
      forbidden: ['FRAGMENTSECRET4'],
    },
  ];

  const ORIGIN = 'https://rpc.example.test';

  for (const { id, label, url, forbidden } of cases) {
    recordExecution(id);

    // The reference is derived by the same constructor the live run uses. Building the source
    // opens nothing: only calling `status` would, and this never does.
    const derived = solanaRpcSource(url).reference;
    check(`${label}: the node reference is the origin alone`, derived === ORIGIN, derived);
    check(
      `${label}: the facilitator reference is the origin alone`,
      facilitatorReference(url) === ORIGIN,
      facilitatorReference(url),
    );

    const source: TransactionStatusSource = {
      reference: derived,
      status: async () => ({
        slot: F.OBSERVED_SLOT,
        commitment: F.COMMITMENT_LEVEL,
        reportedTransactionError: false,
      }),
    };
    const observation = await observeTransaction({
      source,
      transactionSignature: TRANSACTION,
      observedAtUnixSeconds: OBSERVED_AT,
    });

    const layout = await buildEvidence(leakyRun, {
      ...FIXTURE_EVIDENCE_OPTIONS,
      observationSource: { kind: 'facilitator', reference: facilitatorReference(url) },
      rpcObservation: observation,
    });
    const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-redaction-'));
    writeEvidence(directory, layout);
    const emitted = emittedText(directory);

    for (const secret of forbidden) {
      check(`${label}: the evidence carries no ${secret}`, !emitted.includes(secret));
    }
    check(
      `${label}: the evidence still names the endpoint by its origin`,
      emitted.includes(ORIGIN),
    );
    const report = await verifyEvidence(directory, fixtureKey.publicKey);
    check(
      `${label}: and the evidence still verifies`,
      report.ok,
      failedChecks(report).join(', ') || 'nothing failed',
    );

    rmSync(directory, { recursive: true, force: true });
  }

  // A value that is not an endpoint publishes nothing, rather than publishing a guess at one.
  check(
    'a non-HTTP scheme has no publishable origin',
    publicEndpointReference('file:///etc/passwd') === undefined,
    String(publicEndpointReference('file:///etc/passwd')),
  );
  check('a value that is not a URL publishes nothing', publicEndpointReference('rpc') === undefined);
  check('an absent value publishes nothing', publicEndpointReference(undefined) === undefined);

  // A more specific identity is stated by a caller, never derived from the configured value.
  check(
    'an explicitly supplied label is published as given',
    publicEndpointReference('https://rpc.example.test/v1/TOKEN', 'devnet node, operator supplied') ===
      'devnet node, operator supplied',
  );
  check(
    'a label that is not plainly safe is refused rather than reshaped',
    publicEndpointReference(undefined, 'https://rpc.example.test/v1/TOKEN?k=1') === undefined,
  );
}

// ---------------------------------------------------------------------------------------------
// Verification against a directory built to break it.
// ---------------------------------------------------------------------------------------------

console.log('\nVerification against a directory built to break it\n');

/** A private copy of the committed evidence, so a case can damage it without damaging the fixture. */
function hostileCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-hostile-'));
  cpSync(EXPECTED_EVIDENCE_DIR, directory, { recursive: true });
  return directory;
}

/**
 * Verify a directory and report what came back, treating a throw as the failure it would be.
 *
 * The whole point of these cases is that verification returns a verdict, so a thrown exception is
 * captured and reported rather than allowed to end the suite: that would hide the failure behind a
 * crash, which is exactly the behaviour being tested against.
 */
async function verdictFor(
  directory: string,
): Promise<{ readonly report?: EvidenceVerificationReport; readonly thrown?: string }> {
  try {
    return { report: await verifyEvidence(directory, fixtureKey.publicKey) };
  } catch (e) {
    return { thrown: `${(e as Error).constructor.name}: ${(e as Error).message}` };
  }
}

/** One damaged-file case: the report must exist, must fail, and must name the expected checks. */
async function hostileCase(input: {
  readonly label: string;
  readonly damage: (directory: string) => void;
  readonly expectFailing: readonly string[];
}): Promise<void> {
  const directory = hostileCopy();
  input.damage(directory);
  const verdict = await verdictFor(directory);

  check(`${input.label}: verification returns a verdict rather than throwing`, verdict.thrown === undefined, verdict.thrown ?? '');
  check(`${input.label}: the verdict is a failure`, verdict.report?.ok === false);
  for (const name of input.expectFailing) {
    check(
      `${input.label}: the failure is reported as "${name}"`,
      verdict.report?.checks.some((c) => c.name === name && !c.ok) === true,
      (verdict.report?.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(', ') || 'nothing failed',
    );
  }
  rmSync(directory, { recursive: true, force: true });
}

recordExecution('HOSTILE-EV-001');
await hostileCase({
  label: 'a malformed request binding',
  damage: (d) => writeFileSync(join(d, 'request-binding.json'), '{"components": '),
  expectFailing: ['request binding digest'],
});

recordExecution('HOSTILE-EV-002');
await hostileCase({
  label: 'a malformed origin result binding',
  damage: (d) => writeFileSync(join(d, 'origin-result-binding.json'), 'not json at all'),
  expectFailing: ['origin result binding digest', 'origin result body'],
});

recordExecution('HOSTILE-EV-003');
await hostileCase({
  label: 'a malformed chain observation',
  damage: (d) => writeFileSync(join(d, 'chain-observation.json'), '{"settlementOutcome":'),
  expectFailing: ['chain observation digest', 'chain observation'],
});

recordExecution('HOSTILE-EV-004');
await hostileCase({
  label: 'a chain observation that is an array',
  damage: (d) => writeFileSync(join(d, 'chain-observation.json'), '[]'),
  expectFailing: ['chain observation digest', 'chain observation'],
});
await hostileCase({
  label: 'a result binding that is an array',
  damage: (d) => writeFileSync(join(d, 'origin-result-binding.json'), '[1,2,3]'),
  expectFailing: ['origin result binding digest', 'origin result body'],
});

/**
 * HOSTILE-EV-005. An artifact that is there but cannot be read.
 *
 * The failure mode this guards against is silent: read it, catch everything, call it missing, and
 * a directory whose files are unreadable verifies as a smaller and perfectly consistent one. Two
 * shapes are attempted, because not every platform expresses the first.
 */
recordExecution('HOSTILE-EV-005');
{
  const unreadableName = 'every artifact is readable';

  // A path that is a directory. Expressible everywhere, and never mistaken for absence.
  {
    const directory = hostileCopy();
    rmSync(join(directory, 'chain-observation.json'));
    mkdirSync(join(directory, 'chain-observation.json'));
    const verdict = await verdictFor(directory);
    check('an artifact replaced by a directory returns a verdict', verdict.thrown === undefined, verdict.thrown ?? '');
    check('and the verdict is a failure', verdict.report?.ok === false);
    check(
      'and it says the artifact could not be read, not that it is missing',
      verdict.report?.checks.some((c) => c.name === unreadableName && !c.ok) === true,
      (verdict.report?.checks ?? []).map((c) => c.name).join(', '),
    );
    rmSync(directory, { recursive: true, force: true });
  }

  // Permissions. Attempted rather than assumed: a platform or a privileged user may not express it.
  {
    const directory = hostileCopy();
    const target = join(directory, 'chain-observation.json');
    let expressible = false;
    try {
      chmodSync(target, 0o000);
      readFileSync(target);
    } catch {
      expressible = true;
    }
    if (!expressible) {
      console.log('  note  file permissions do not deny this process a read here; case not expressible');
    } else {
      const verdict = await verdictFor(directory);
      check('an artifact this process may not open returns a verdict', verdict.thrown === undefined, verdict.thrown ?? '');
      check('and it is reported as unreadable rather than missing', verdict.report?.checks.some((c) => c.name === unreadableName && !c.ok) === true);
    }
    chmodSync(target, 0o600);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A record that is not a record at all. Refused at the signature stage, never thrown. */
{
  const directory = hostileCopy();
  writeFileSync(join(directory, 'record.jws'), 'this is not a compact JWS\n');
  const verdict = await verdictFor(directory);
  check('a record that is arbitrary bytes returns a verdict', verdict.thrown === undefined, verdict.thrown ?? '');
  check(
    'and it is refused at the signature stage',
    verdict.report?.ok === false &&
      verdict.report.checks.some((c) => c.name === 'record signature and schema' && !c.ok),
    (verdict.report?.checks ?? []).map((c) => c.name).join(', '),
  );
  rmSync(directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// What a remote party says, against what this flow writes down.
// ---------------------------------------------------------------------------------------------

console.log('\nRemote failure text, against what is persisted\n');

/**
 * SAN-ERR-001. A facilitator whose every failure carries a token and a URL.
 *
 * The reasons this flow persists come from a fixed vocabulary, so none of that text can reach a
 * lifecycle reason, the chain observation, or a diagnostic that outlives the run. What the
 * facilitator actually sent is not discarded: it stays in the captured x402 field value, which is
 * an observed wire artifact bound by its own digest, and this case states that distinction rather
 * than implying the bytes went away.
 */
recordExecution('SAN-ERR-001');
{
  const SECRET_TOKEN = 'tokenLEAKCANARY7';
  const SECRET_URL = 'https://facilitator.example.test/abc?key=QUERYCANARY9';
  const REMOTE_TEXT = `${SECRET_TOKEN} ${SECRET_URL}`;
  const canaries = [SECRET_TOKEN, 'QUERYCANARY9', 'facilitator.example.test'];

  const vocabulary = new Set<string>(FAILURE_REASONS);

  const branches = [
    { label: 'a refused verification', options: { facilitator: { rejectVerification: REMOTE_TEXT } }, reason: 'verification_rejected' },
    { label: 'a raised verification', options: { facilitator: { throwOnVerify: REMOTE_TEXT } }, reason: 'verification_exception' },
    { label: 'a refused settlement', options: { facilitator: { rejectSettlement: REMOTE_TEXT } }, reason: 'settlement_rejected' },
    { label: 'a raised settlement', options: { facilitator: { throwOnSettle: REMOTE_TEXT } }, reason: 'settlement_exception' },
  ] as const;

  for (const branch of branches) {
    const run = await runOnce(branch.options);
    const reason = run.origin.lifecycle.failureReason;
    check(`${branch.label} is recorded as ${branch.reason}`, reason === branch.reason, String(reason));
    check(`${branch.label} records a term from the fixed vocabulary`, vocabulary.has(String(reason)));
    check(
      `${branch.label} retains nothing the facilitator supplied`,
      canaries.every((c) => !String(reason).includes(c)),
      String(reason),
    );
  }

  // The refused settlement is the branch that reaches signed evidence, so it is emitted in full and
  // everything written is scanned.
  const refused = await runOnce({ facilitator: { rejectSettlement: REMOTE_TEXT } });
  const layout = await buildEvidence(refused, FIXTURE_EVIDENCE_OPTIONS);
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-sanitized-'));
  writeEvidence(directory, layout);

  const observation = JSON.parse(
    readFileSync(join(directory, 'chain-observation.json'), 'utf8'),
  ) as { settlementFailureReason?: string; settlementOutcome?: string };
  check(
    'the chain observation records the refusal in the fixed vocabulary',
    observation.settlementOutcome === 'refused' &&
      observation.settlementFailureReason === 'settlement_rejected',
    `${String(observation.settlementOutcome)}, ${String(observation.settlementFailureReason)}`,
  );

  const documents = filesUnder(directory)
    .filter((f) => !f.includes(`artifacts${sep}`))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const recordPayload = Buffer.from(
    readFileSync(join(directory, 'record.jws'), 'utf8').trim().split('.')[1] ?? '',
    'base64url',
  ).toString('utf8');
  for (const canary of canaries) {
    check(`no derived document carries ${canary}`, !documents.includes(canary) && !recordPayload.includes(canary));
  }

  /**
   * The other half of the same statement, said plainly.
   *
   * The captured settlement field value is the facilitator's own response, recorded as observed and
   * bound by digest. That is what an observed artifact is for, and removing content from it would
   * be falsifying the wire. The boundary this case establishes is that the reasons this flow
   * derives and writes in its own words carry none of it.
   */
  const capturedResponse = readFileSync(join(directory, 'artifacts/payment-response.txt'), 'utf8');
  const decodedResponse = Buffer.from(capturedResponse, 'base64').toString('utf8');
  check(
    'the captured settlement field value is the response as sent, recorded verbatim',
    decodedResponse.includes(REMOTE_TEXT),
    'the observed artifact no longer matches what the facilitator sent',
  );
  check(
    'and it is bound by its own digest rather than restated in a derived field',
    !documents.includes(REMOTE_TEXT),
  );

  rmSync(directory, { recursive: true, force: true });

  // A supported machine code still survives, so the vocabulary bounds the reasons without erasing
  // the ones this integration deliberately understands.
  check(
    'a supported machine code is kept as it was',
    persistableFailureReason(DUPLICATE_SETTLEMENT_REASON, 'settlement_rejected') ===
      DUPLICATE_SETTLEMENT_REASON,
  );
  check(
    'a well-formed code nobody declared is not adopted',
    persistableFailureReason('some_undeclared_code', 'settlement_rejected') === 'settlement_rejected',
  );
  check(
    'and a value that is not a string becomes the derived term',
    persistableFailureReason({ reason: 'object' }, 'verification_rejected') === 'verification_rejected',
  );

  // The preflight's own diagnostic is durable output too: it is printed and pasted into run notes.
  const throwing = {
    getSupported: async () => {
      throw new Error(REMOTE_TEXT);
    },
  } as unknown as Parameters<typeof checkFacilitatorSupport>[0];
  const facilitatorCheck = await checkFacilitatorSupport(throwing, SOLANA_DEVNET_CAIP2);
  check('an unreachable facilitator is reported in stable words', facilitatorCheck.status === 'failed');
  check(
    'and the diagnostic echoes nothing the facilitator supplied',
    canaries.every((c) => !facilitatorCheck.detail.includes(c)),
    facilitatorCheck.detail,
  );
}

// ---------------------------------------------------------------------------------------------
// Emission: the destination is complete, or it is not there.
// ---------------------------------------------------------------------------------------------

console.log('\nTransactional evidence emission\n');

const emissionLayout = await buildEvidence(await runOnce());

/** Names of the staging directories left beside a destination. */
const staged = (parent: string): string[] =>
  readdirSync(parent).filter((entry) => entry.startsWith('.tmp-'));

/**
 * EVID-TX-001. An emission that fails part way through.
 *
 * The fault is injected after the artifacts are staged and before the move, which is exactly where
 * a verification failure or a crash would land. What must not exist afterwards is the destination:
 * a reader who finds it has to be able to treat it as complete.
 */
recordExecution('EVID-TX-001');
{
  const parent = mkdtempSync(join(tmpdir(), 'peac-emission-'));
  const destination = join(parent, 'devnet-run');

  let thrown: Error | undefined;
  try {
    await writeEvidenceTransactionally({
      finalDirectory: destination,
      layout: emissionLayout,
      finalize: async (stagedDirectory) => {
        // Proves the fault happened after the artifacts were written, not before.
        check(
          'artifacts are staged before anything is finalized',
          existsSync(join(stagedDirectory, 'record.jws')),
        );
        throw new Error('synthetic failure during finalization');
      },
    });
  } catch (e) {
    thrown = e as Error;
  }

  check('an interrupted emission reports the failure', thrown?.message.includes('synthetic failure') === true);
  check('and leaves no final evidence directory', !existsSync(destination));
  check(
    'what it wrote stays under a name that says it is incomplete',
    staged(parent).length === 1,
    staged(parent).join(', ') || 'nothing',
  );
  check(
    'nothing partial is reachable under the destination name',
    !existsSync(join(destination, 'record.jws')),
  );

  rmSync(parent, { recursive: true, force: true });
}

/**
 * EVID-TX-002. A destination that already exists.
 *
 * Refused before anything is written, and the existing directory is not read, merged into or
 * touched. A previous run's evidence is that run's.
 */
recordExecution('EVID-TX-002');
{
  const parent = mkdtempSync(join(tmpdir(), 'peac-emission-'));
  const destination = join(parent, 'devnet-run');
  mkdirSync(destination);
  const sentinel = join(destination, 'record.jws');
  writeFileSync(sentinel, 'an earlier run wrote this');

  let reachedFinalize = false;
  let thrown: unknown;
  try {
    await writeEvidenceTransactionally({
      finalDirectory: destination,
      layout: emissionLayout,
      finalize: async () => {
        reachedFinalize = true;
      },
    });
  } catch (e) {
    thrown = e;
  }

  check('a colliding destination is refused', thrown instanceof EvidenceCollisionError, String(thrown));
  check('nothing was staged, because it stopped before writing', staged(parent).length === 0);
  check('and nothing was verified either', reachedFinalize === false);
  check(
    'the existing directory is byte for byte what it was',
    readFileSync(sentinel, 'utf8') === 'an earlier run wrote this',
  );

  rmSync(parent, { recursive: true, force: true });
}

/**
 * EVID-KEY-001. An output path that is already taken.
 *
 * Both paths are checked before anything is written, and the fault is injected into each in turn.
 * Reaching a payment with a path already occupied is the failure worth preventing: the run would
 * spend funds and then have nowhere to put what a reviewer needs.
 */
recordExecution('EVID-KEY-001');
{
  const parent = mkdtempSync(join(tmpdir(), 'peac-run-outputs-'));
  const evidenceDirectory = join(parent, 'devnet-run');
  const publicKeyFile = join(parent, 'devnet-run-issuer.pub.json');

  // The key path is taken, by something that must survive untouched.
  writeFileSync(publicKeyFile, 'an earlier run wrote this');
  let thrown: unknown;
  try {
    prepareRunOutputs({ evidenceDirectory, publicKeyFile, issuerKey: fixtureKey });
  } catch (e) {
    thrown = e;
  }
  check('a taken verification key path is refused', thrown instanceof EvidenceCollisionError, String(thrown));
  check('the message names the key file rather than the evidence', String(thrown).includes('verification key file'), String(thrown));
  check('the existing file is byte for byte what it was', readFileSync(publicKeyFile, 'utf8') === 'an earlier run wrote this');
  check('and no evidence directory was created', !existsSync(evidenceDirectory));

  // The evidence path is taken, and the key file must not be written for a run that cannot finish.
  const second = mkdtempSync(join(tmpdir(), 'peac-run-outputs-'));
  const takenDirectory = join(second, 'devnet-run');
  const freeKeyFile = join(second, 'devnet-run-issuer.pub.json');
  mkdirSync(takenDirectory);
  let secondThrown: unknown;
  try {
    prepareRunOutputs({ evidenceDirectory: takenDirectory, publicKeyFile: freeKeyFile, issuerKey: fixtureKey });
  } catch (e) {
    secondThrown = e;
  }
  check('a taken evidence path is refused', secondThrown instanceof EvidenceCollisionError, String(secondThrown));
  check('and no key file is written for a run that cannot finish', !existsSync(freeKeyFile));

  rmSync(parent, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
}

/**
 * EVID-KEY-002. The devnet-shaped ordering, offline.
 *
 * The same two steps a live run performs, in the same order and through the same functions, with a
 * payment that never happens. What is asserted is the invariant the ordering exists for: a
 * finalized evidence directory implies the key file beside it, and an emission that fails leaves
 * no directory at all.
 */
recordExecution('EVID-KEY-002');
{
  const parent = mkdtempSync(join(tmpdir(), 'peac-run-outputs-'));

  // The complete path.
  {
    const evidenceDirectory = join(parent, 'devnet-complete');
    const publicKeyFile = join(parent, 'devnet-complete-issuer.pub.json');
    const reviewerKey = prepareRunOutputs({ evidenceDirectory, publicKeyFile, issuerKey: fixtureKey });

    check('the verification key exists before any evidence does', existsSync(publicKeyFile) && !existsSync(evidenceDirectory));
    check(
      'and it round-trips to the key the run will sign with',
      Buffer.from(reviewerKey.publicKey).equals(Buffer.from(fixtureKey.publicKey)) &&
        reviewerKey.kid === fixtureKey.kid &&
        reviewerKey.issuer === fixtureKey.iss,
    );

    await writeEvidenceTransactionally({
      finalDirectory: evidenceDirectory,
      layout: emissionLayout,
      finalize: async (stagedDirectory) => {
        const report = await verifyEvidence(stagedDirectory, reviewerKey.publicKey, {
          algorithm: reviewerKey.algorithm,
          kid: reviewerKey.kid,
          issuer: reviewerKey.issuer,
        });
        if (!report.ok) throw new Error('the staged evidence did not verify');
      },
    });

    check('a completed run leaves both artifacts', existsSync(evidenceDirectory) && existsSync(publicKeyFile));
    const report = await verifyEvidence(
      evidenceDirectory,
      readIssuerPublicKeyFile(publicKeyFile).publicKey,
      { algorithm: reviewerKey.algorithm, kid: reviewerKey.kid, issuer: reviewerKey.issuer },
    );
    check(
      'and the directory verifies under the key file written before the payment',
      report.ok,
      failedChecks(report).join(', ') || 'nothing failed',
    );
  }

  // The interrupted path: the key exists, the directory does not, and the implication still holds.
  {
    const evidenceDirectory = join(parent, 'devnet-interrupted');
    const publicKeyFile = join(parent, 'devnet-interrupted-issuer.pub.json');
    prepareRunOutputs({ evidenceDirectory, publicKeyFile, issuerKey: fixtureKey });

    let thrown: Error | undefined;
    try {
      await writeEvidenceTransactionally({
        finalDirectory: evidenceDirectory,
        layout: emissionLayout,
        finalize: async () => {
          throw new Error('synthetic failure during finalization');
        },
      });
    } catch (e) {
      thrown = e as Error;
    }

    check('an interrupted emission reports the failure', thrown?.message.includes('synthetic failure') === true);
    check('it leaves no evidence directory', !existsSync(evidenceDirectory));
    check(
      'so an evidence directory never exists without its verification key',
      !existsSync(evidenceDirectory) || existsSync(publicKeyFile),
    );
    check('and what it does leave is public key material only', existsSync(publicKeyFile));
  }

  rmSync(parent, { recursive: true, force: true });
}

/** The successful path: everything staged, everything finalized, one directory in place. */
{
  const parent = mkdtempSync(join(tmpdir(), 'peac-emission-'));
  const destination = join(parent, 'devnet-run');

  await writeEvidenceTransactionally({
    finalDirectory: destination,
    layout: emissionLayout,
    finalize: async (stagedDirectory) => {
      writeFileSync(join(stagedDirectory, 'verification-report.txt'), 'verified\n');
    },
  });

  check('a completed emission puts the directory in place', existsSync(join(destination, 'record.jws')));
  check(
    'and whatever finalization wrote arrived with it',
    existsSync(join(destination, 'verification-report.txt')),
  );
  check('leaving no staging directory behind', staged(parent).length === 0);

  const report = await verifyEvidence(destination, fixtureKey.publicKey);
  check('the directory it left verifies', report.ok, failedChecks(report).join(', ') || 'nothing failed');

  rmSync(parent, { recursive: true, force: true });
}

/** The origin does not advertise its framework on every response. */
{
  const resource = await createPaidResource({
    facilitatorClient: createFixtureFacilitatorClient(SOLANA_DEVNET_CAIP2, {}),
    registerSchemes: (server) => {
      registerExactSvmScheme(server, { networks: [SOLANA_DEVNET_CAIP2] });
    },
    network: SOLANA_DEVNET_CAIP2,
    payTo: F.PAY_TO,
    price: { asset: F.ASSET_MINT, amount: F.AMOUNT_BASE_UNITS },
    method: 'GET',
    path: '/v1/forecast',
    resourceUrl: F.RESOURCE_URL,
    maxTimeoutSeconds: F.MAX_TIMEOUT_SECONDS,
    handler: () => ({ status: 200, contentType: 'application/json', body: F.ORIGIN_RESULT_BODY }),
  });
  check('the origin does not advertise the framework it runs on', resource.app.enabled('x-powered-by') === false);
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
