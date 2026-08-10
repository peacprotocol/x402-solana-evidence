/**
 * Independent verification of an evidence directory.
 *
 * Given the directory and a public key, and nothing else: no access to the origin, no network, no
 * shared state with whatever produced it. That is the property the whole example exists to
 * demonstrate, so this file deliberately reads only files and the supplied key.
 *
 * Four things are checked, and the order is the point:
 *   1. the record's signature, so nothing downstream is trusted before it is intact
 *   2. every digest recomputed from the document beside it, so the record's claims about those
 *      documents are checked rather than believed
 *   3. the origin result body against the digest inside the result binding, because a binding that
 *      names a body nobody can check is decoration
 *   4. the artifact set against the presence contract for the terminal state the record itself
 *      carries, so removing an inconvenient file is a failure and not a smaller directory
 *
 * WHAT SUCCESS MEANS. The contents are intact relative to the key material supplied to this
 * verifier, and the documents match what the record says about them. It does not establish that
 * the key belongs to any particular organization, that the payment settled, or that any statement
 * inside the documents is true. Those are separate questions, and this reports on none of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyLocal, computeJsonDocumentDigestJcs } from '@peac/protocol';
import type { JsonValue } from '@peac/kernel';
import { coerceDigest, digestBytes, type Sha256Digest } from '../digest.ts';
import { checkPresence, EVIDENCE_ARTIFACTS, type EvidenceArtifact } from './presence.ts';
import {
  COMMERCE_GROUP,
  EXPECTED_EVIDENCE_DIR,
  EXPECTED_EVIDENCE_DISPLAY,
  PAYMENT_EVIDENCE_GROUP,
  RECORD_TYPE,
} from './issue-record.ts';
import { resolveIssuerKey } from './issuer-key.ts';
import { TERMINAL_STATES, type TerminalState } from './lifecycle.ts';
import {
  InvalidPublicKeyFileError,
  readIssuerPublicKeyFile,
  SUPPLIED_KEY_CAVEAT,
} from './public-key-file.ts';

export interface VerificationCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Bounded explanation. Never quotes attacker-controlled document text. */
  readonly detail: string;
}

export interface EvidenceVerificationReport {
  readonly ok: boolean;
  readonly checks: readonly VerificationCheck[];
}

const pass = (name: string, detail = ''): VerificationCheck => ({ name, ok: true, detail });
const fail = (name: string, detail: string): VerificationCheck => ({ name, ok: false, detail });

function readIfPresent(directory: string, artifact: EvidenceArtifact): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(join(directory, artifact)));
  } catch {
    return undefined;
  }
}

function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === 'string' && (TERMINAL_STATES as readonly string[]).includes(value);
}

/**
 * Verify an evidence directory.
 *
 * @param directory - Directory holding the record and the documents it binds.
 * @param publicKey - Ed25519 public key the record is expected to verify under.
 */
export async function verifyEvidence(
  directory: string,
  publicKey: Uint8Array,
): Promise<EvidenceVerificationReport> {
  const checks: VerificationCheck[] = [];

  const present = new Map<EvidenceArtifact, Uint8Array>();
  for (const artifact of EVIDENCE_ARTIFACTS) {
    const bytes = readIfPresent(directory, artifact);
    if (bytes !== undefined) present.set(artifact, bytes);
  }

  const recordBytes = present.get('record.jws');
  if (recordBytes === undefined) {
    return { ok: false, checks: [fail('record present', 'record.jws is missing')] };
  }
  const jws = new TextDecoder().decode(recordBytes).trim();

  const verified = await verifyLocal(jws, publicKey);
  if (!verified.valid) {
    return {
      ok: false,
      checks: [fail('record signature and schema', `${verified.code}`)],
    };
  }
  checks.push(pass('record signature and schema', `verified under kid ${verified.kid}`));

  const claims = verified.claims as unknown as {
    type?: string;
    extensions?: Record<string, Record<string, unknown>>;
  };
  checks.push(
    claims.type === RECORD_TYPE
      ? pass('record type', RECORD_TYPE)
      : fail('record type', `expected ${RECORD_TYPE}, record carries ${String(claims.type)}`),
  );

  const commerce = claims.extensions?.[COMMERCE_GROUP];
  const evidence = claims.extensions?.[PAYMENT_EVIDENCE_GROUP];
  if (commerce === undefined || evidence === undefined) {
    checks.push(fail('extension groups', 'the record is missing a required extension group'));
    return { ok: false, checks };
  }
  checks.push(pass('extension groups', `${COMMERCE_GROUP}, ${PAYMENT_EVIDENCE_GROUP}`));

  /** Recompute one bound digest from the document that sits beside the record. */
  const recomputeJson = async (
    name: string,
    artifact: EvidenceArtifact,
    claimed: unknown,
  ): Promise<void> => {
    const bytes = present.get(artifact);
    if (claimed === undefined) {
      checks.push(
        bytes === undefined
          ? pass(name, 'not bound and not present')
          : fail(name, `${artifact} is present but the record binds no digest for it`),
      );
      return;
    }
    if (bytes === undefined) {
      checks.push(fail(name, `the record binds a digest but ${artifact} is missing`));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      checks.push(fail(name, `${artifact} is not readable as JSON`));
      return;
    }
    const recomputed = coerceDigest(await computeJsonDocumentDigestJcs(parsed as JsonValue));
    checks.push(
      recomputed === claimed
        ? pass(name, recomputed)
        : fail(name, `recomputed ${recomputed}, record binds ${String(claimed)}`),
    );
  };

  await recomputeJson(
    'request binding digest',
    'request-binding.json',
    evidence['request_binding_digest'],
  );
  await recomputeJson(
    'origin result binding digest',
    'origin-result-binding.json',
    evidence['origin_result_binding_digest'],
  );
  await recomputeJson(
    'chain observation digest',
    'chain-observation.json',
    evidence['chain_observation_digest'],
  );

  /** Recompute an observed field value digest from the bytes recorded beside the record. */
  const recomputeObserved = (name: string, artifact: EvidenceArtifact, claimed: unknown): void => {
    const bytes = present.get(artifact);
    if (claimed === undefined) {
      checks.push(
        bytes === undefined
          ? pass(name, 'not bound and not present')
          : fail(name, `${artifact} is present but the record binds no digest for it`),
      );
      return;
    }
    if (bytes === undefined) {
      checks.push(fail(name, `the record binds a digest but ${artifact} is missing`));
      return;
    }
    const recomputed = digestBytes(bytes);
    checks.push(
      recomputed === claimed
        ? pass(name, recomputed)
        : fail(name, `recomputed ${recomputed}, record binds ${String(claimed)}`),
    );
  };

  recomputeObserved(
    'payment-required digest',
    'artifacts/payment-required.txt',
    evidence['payment_required_digest'],
  );
  recomputeObserved(
    'payment-signature digest',
    'artifacts/payment-signature.txt',
    evidence['payment_signature_digest'],
  );
  recomputeObserved(
    'payment-response digest',
    'artifacts/payment-response.txt',
    evidence['payment_response_digest'],
  );

  // The result binding names the body by digest, so the body is checked against the binding rather
  // than against the record: that is where the claim about the bytes actually lives.
  const resultBindingBytes = present.get('origin-result-binding.json');
  const bodyBytes = present.get('origin-result-body.bin');
  if (resultBindingBytes !== undefined) {
    let boundBodyDigest: unknown;
    try {
      boundBodyDigest = (JSON.parse(new TextDecoder().decode(resultBindingBytes)) as {
        bodyDigest?: unknown;
      }).bodyDigest;
    } catch {
      boundBodyDigest = undefined;
    }
    if (bodyBytes === undefined) {
      checks.push(fail('origin result body', 'the result binding exists but the body is missing'));
    } else {
      const recomputed: Sha256Digest = digestBytes(bodyBytes);
      checks.push(
        recomputed === boundBodyDigest
          ? pass('origin result body', recomputed)
          : fail('origin result body', `recomputed ${recomputed}, binding names ${String(boundBodyDigest)}`),
      );
    }
  }

  // The terminal state comes from inside the signed record, so the expected artifact set cannot be
  // chosen after the fact to match whatever files happen to be there.
  const terminalState = evidence['terminal_state'];
  if (!isTerminalState(terminalState)) {
    checks.push(fail('terminal state', 'the record carries no recognised terminal state'));
    return { ok: false, checks };
  }
  const violations = checkPresence(terminalState, new Set(present.keys()));
  checks.push(
    violations.length === 0
      ? pass('artifact presence contract', `consistent with ${terminalState}`)
      : fail(
          'artifact presence contract',
          violations
            .map((v) => `${v.artifact} is ${v.present ? 'present' : 'missing'} but declared ${v.expectation}`)
            .join('; '),
        ),
  );

  // A refused or unreached settlement must carry no transaction facts, because a transaction
  // reference beside a failure reads as a payment that happened.
  const observationBytes = present.get('chain-observation.json');
  if (observationBytes !== undefined) {
    const observation = JSON.parse(new TextDecoder().decode(observationBytes)) as {
      settlementOutcome?: string;
      transactionSignature?: string;
      rpcObservation?: { transactionSignature?: string; status?: string };
    };
    const settled = observation.settlementOutcome === 'succeeded';
    const hasTransaction = typeof observation.transactionSignature === 'string';
    checks.push(
      settled === hasTransaction
        ? pass(
            'settlement facts match the outcome',
            settled ? 'settled, transaction recorded' : 'not settled, no transaction recorded',
          )
        : fail(
            'settlement facts match the outcome',
            settled
              ? 'settlement succeeded but no transaction reference is recorded'
              : 'a transaction reference is recorded for a settlement that did not succeed',
          ),
    );

    /**
     * A node's account of the settlement, when one is present.
     *
     * Optional by design: an offline run asks nobody, and a live run whose endpoint was unreachable
     * records an unavailable observation rather than none. What is not optional is that it describe
     * the same transaction the settlement did. A second observer attached to a different transaction
     * would read as corroboration of something this run never observed.
     */
    const rpc = observation.rpcObservation;
    if (rpc !== undefined) {
      const sameTransaction =
        typeof observation.transactionSignature === 'string' &&
        rpc.transactionSignature === observation.transactionSignature;
      checks.push(
        sameTransaction
          ? pass(
              'rpc observation',
              `${String(rpc.status)}, for the transaction the settlement recorded`,
            )
          : fail(
              'rpc observation',
              'it describes a transaction the settlement observation does not record',
            ),
      );
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** A command line this verifier cannot act on. Never raised for evidence that simply fails. */
export class UsageError extends Error {}

export const VERIFY_USAGE = [
  'Usage:',
  '  verify                                        verify the committed fixture evidence',
  '  verify --evidence <dir> --public-key <file>   verify any evidence directory',
].join('\n');

export interface VerifyRequest {
  /** Directory to read. */
  readonly directory: string;
  /** How that directory is named in output. Never an absolute machine-specific path. */
  readonly display: string;
  /** Public key file to verify under. Absent means the committed fixture and its test key. */
  readonly publicKeyFile?: string;
}

/**
 * Decide what to verify, from arguments alone.
 *
 * The two options are required together on purpose. `--evidence` without a key would fall back to
 * the fixture's test key, and a directory that failed for that reason would look like tampering
 * rather than like the wrong key. `--public-key` without a directory would verify the committed
 * fixture under someone else's key, which answers a question nobody asked.
 *
 * @param argv - Arguments after the script name.
 * @throws UsageError for anything this verifier cannot act on.
 */
export function parseVerifyArguments(argv: readonly string[]): VerifyRequest {
  let evidence: string | undefined;
  let publicKeyFile: string | undefined;

  // A leading `--` is the package manager's argument separator. Some versions consume it and some
  // forward it verbatim, so it is accepted and dropped here rather than making the documented
  // command depend on which one is installed.
  const start = argv[0] === '--' ? 1 : 0;

  for (let index = start; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== '--evidence' && argument !== '--public-key') {
      throw new UsageError(`unrecognised argument: ${argument.slice(0, 40)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${argument} needs a value`);
    }
    if (argument === '--evidence') {
      if (evidence !== undefined) throw new UsageError('--evidence was given more than once');
      evidence = value;
    } else {
      if (publicKeyFile !== undefined) throw new UsageError('--public-key was given more than once');
      publicKeyFile = value;
    }
    index += 1;
  }

  if (evidence === undefined && publicKeyFile === undefined) {
    return { directory: EXPECTED_EVIDENCE_DIR, display: EXPECTED_EVIDENCE_DISPLAY };
  }
  if (evidence === undefined) {
    throw new UsageError('--public-key needs --evidence: it cannot verify the committed fixture');
  }
  if (publicKeyFile === undefined) {
    throw new UsageError('--evidence needs --public-key: the fixture key verifies only the fixture');
  }
  return { directory: evidence, display: evidence, publicKeyFile };
}

function requestFrom(argv: readonly string[]): VerifyRequest {
  try {
    return parseVerifyArguments(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`\n${e.message}\n\n${VERIFY_USAGE}\n`);
    process.exit(2);
  }
}

function keyFrom(path: string): Uint8Array {
  try {
    return readIssuerPublicKeyFile(path).publicKey;
  } catch (e) {
    if (!(e instanceof InvalidPublicKeyFileError)) throw e;
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }
}

/**
 * Entry point for `pnpm verify`.
 *
 * With no arguments it verifies the committed fixture under the test key, which is the position a
 * reader of this repository is in. With `--evidence` and `--public-key` it verifies any directory
 * under any supplied key, which is the position someone handed a live run's output is in. Both read
 * files and a key and nothing else: no network, no origin, no state shared with whatever produced
 * the directory.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const request = requestFrom(argv);
  const publicKey =
    request.publicKeyFile === undefined
      ? (await resolveIssuerKey('fixture')).publicKey
      : keyFrom(request.publicKeyFile);

  const report = await verifyEvidence(request.directory, publicKey);
  console.log(formatReport(request.display, report));
  // Stated on every run under a supplied key, including a successful one, because success is
  // exactly where the claim is easiest to overstate.
  if (request.publicKeyFile !== undefined) console.log(`  ${SUPPLIED_KEY_CAVEAT}\n`);
  if (!report.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

/** Render a report. The text is not bound by anything; it is a reading of the files. */
export function formatReport(directory: string, report: EvidenceVerificationReport): string {
  const lines = ['', `Evidence verification: ${directory}`, ''];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
  }
  lines.push('');
  lines.push(
    report.ok
      ? 'Verified. Contents are intact relative to the supplied key, and every bound digest recomputes.'
      : 'Not verified. See the failures above.',
  );
  lines.push('');
  return lines.join('\n');
}
