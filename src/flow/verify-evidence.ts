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
  PUBLIC_KEY_ALGORITHM,
  readIssuerPublicKeyFile,
  SUPPLIED_KEY_CAVEAT,
  type LoadedIssuerPublicKey,
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

/**
 * What reading one artifact produced.
 *
 * Three outcomes, not two, and the third is the point. "Absent" is a fact about the evidence and
 * feeds the presence contract; "unreadable" is a fact about this machine and must never be
 * reported as absence, because a directory whose files cannot be read would otherwise verify as a
 * smaller, consistent one.
 */
type ArtifactRead =
  | { readonly kind: 'present'; readonly bytes: Uint8Array }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Read one artifact, without deciding anything about what its state means.
 *
 * Only `ENOENT` is absence. Every other error, including a path that is a directory or one this
 * process may not open, is reported as unreadable: the caller cannot tell those apart from a
 * missing file by looking at the directory, so this refuses to guess on its behalf.
 */
function readArtifact(directory: string, artifact: EvidenceArtifact): ArtifactRead {
  try {
    return { kind: 'present', bytes: new Uint8Array(readFileSync(join(directory, artifact))) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: code ?? 'unreadable' };
  }
}

/** What parsing one JSON sidecar produced. Malformed is a result, never an exception. */
type JsonRead =
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'absent' };

/** A JSON object, as opposed to an array, a null, or a bare scalar wearing the same file name. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A bounded rendering of a value read out of a document.
 *
 * Report text is the one place attacker-controlled content could reach a reader's terminal at
 * whatever length it likes, so a value taken from a file is described rather than reproduced.
 */
function describeBound(value: unknown): string {
  if (typeof value === 'string') return value.length <= 80 ? value : `${value.slice(0, 80)}...`;
  if (typeof value === 'object' && value !== null) return 'a value that is not a string';
  return String(value).slice(0, 80);
}

function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === 'string' && (TERMINAL_STATES as readonly string[]).includes(value);
}

/**
 * What a supplied key file said about itself, beyond the bytes verification actually uses.
 *
 * Only the bytes decide whether a signature is valid. The rest of the file is a description of
 * those bytes, and a description that disagrees with the record is worth reporting: it means the
 * file and the evidence were not produced for each other, whatever the signature says.
 */
export interface SuppliedKeyMetadata {
  readonly algorithm: string;
  readonly kid: string;
  readonly issuer: string;
}

/**
 * Verify an evidence directory.
 *
 * @param directory - Directory holding the record and the documents it binds.
 * @param publicKey - Ed25519 public key the record is expected to verify under.
 * @param suppliedKey - What a supplied key file declared, when the key came from one. Reported as
 *   its own checks; it is never treated as an identity claim.
 */
export async function verifyEvidence(
  directory: string,
  publicKey: Uint8Array,
  suppliedKey?: SuppliedKeyMetadata,
): Promise<EvidenceVerificationReport> {
  const checks: VerificationCheck[] = [];

  // Read every artifact once, before anything is decided. A file that exists but cannot be read is
  // reported as exactly that and stops the run: treating it as absent would let an unreadable
  // directory verify as a smaller, self-consistent one.
  const present = new Map<EvidenceArtifact, Uint8Array>();
  const unreadable: string[] = [];
  for (const artifact of EVIDENCE_ARTIFACTS) {
    const read = readArtifact(directory, artifact);
    if (read.kind === 'present') present.set(artifact, read.bytes);
    else if (read.kind === 'unreadable') unreadable.push(`${artifact} (${read.reason})`);
  }
  if (unreadable.length > 0) {
    return {
      ok: false,
      checks: [
        fail(
          'every artifact is readable',
          `could not be read, and absence must not be assumed: ${unreadable.join('; ')}`,
        ),
      ],
    };
  }

  /**
   * Parse one JSON sidecar, once.
   *
   * Every reader of a sidecar goes through here and reuses the parsed value, so a document cannot
   * be parsed safely in one place and unsafely in another, and a malformed file produces a result
   * rather than an exception out of the middle of verification.
   */
  const parsedJson = new Map<EvidenceArtifact, JsonRead>();
  const readJsonArtifact = (artifact: EvidenceArtifact): JsonRead => {
    const cached = parsedJson.get(artifact);
    if (cached !== undefined) return cached;
    const bytes = present.get(artifact);
    let read: JsonRead;
    if (bytes === undefined) read = { kind: 'absent' };
    else {
      try {
        read = { kind: 'parsed', value: JSON.parse(new TextDecoder().decode(bytes)) };
      } catch {
        read = { kind: 'malformed' };
      }
    }
    parsedJson.set(artifact, read);
    return read;
  };

  const recordBytes = present.get('record.jws');
  if (recordBytes === undefined) {
    return { ok: false, checks: [fail('record present', 'record.jws is missing')] };
  }
  const jws = new TextDecoder().decode(recordBytes).trim();

  // The record is attacker-controlled bytes like everything else here, so a refusal from the
  // verification primitive is a result and a throw from it is still a verification failure.
  let verified: Awaited<ReturnType<typeof verifyLocal>>;
  try {
    verified = await verifyLocal(jws, publicKey);
  } catch {
    return {
      ok: false,
      checks: [fail('record signature and schema', 'the record could not be read as a PEAC record')],
    };
  }
  if (!verified.valid) {
    return {
      ok: false,
      checks: [fail('record signature and schema', `${verified.code}`)],
    };
  }
  checks.push(pass('record signature and schema', `verified under kid ${verified.kid}`));

  const claims = verified.claims as unknown as {
    iss?: unknown;
    type?: string;
    extensions?: Record<string, Record<string, unknown>>;
  };

  /**
   * What the key file said, against what the record says.
   *
   * Reported as three separate checks rather than one, because they answer different questions: an
   * algorithm this example does not verify under, a key identifier naming a different key, and an
   * issuer naming a different party are three distinct disagreements and a reader should be told
   * which one occurred. None of them is an identity check: a matching description of a key is
   * still a description, and the caveat printed alongside says so.
   */
  if (suppliedKey !== undefined) {
    checks.push(
      suppliedKey.algorithm === PUBLIC_KEY_ALGORITHM
        ? pass('supplied key algorithm', PUBLIC_KEY_ALGORITHM)
        : fail(
            'supplied key algorithm',
            `the key file declares ${describeBound(suppliedKey.algorithm)}, ` +
              `and this example verifies only ${PUBLIC_KEY_ALGORITHM}`,
          ),
    );
    checks.push(
      suppliedKey.kid === verified.kid
        ? pass('supplied key identifier matches the record', verified.kid)
        : fail(
            'supplied key identifier matches the record',
            `the key file names ${describeBound(suppliedKey.kid)}, ` +
              `the record names ${describeBound(verified.kid)}`,
          ),
    );
    checks.push(
      suppliedKey.issuer === claims.iss
        ? pass('supplied key issuer matches the record', suppliedKey.issuer)
        : fail(
            'supplied key issuer matches the record',
            `the key file names ${describeBound(suppliedKey.issuer)}, ` +
              `the record names ${describeBound(claims.iss)}`,
          ),
    );
  }
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
    const parsed = readJsonArtifact(artifact);
    if (parsed.kind !== 'parsed') {
      checks.push(fail(name, `${artifact} is not readable as JSON`));
      return;
    }
    const recomputed = coerceDigest(await computeJsonDocumentDigestJcs(parsed.value as JsonValue));
    checks.push(
      recomputed === claimed
        ? pass(name, recomputed)
        : fail(name, `recomputed ${recomputed}, record binds ${describeBound(claimed)}`),
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
        : fail(name, `recomputed ${recomputed}, record binds ${describeBound(claimed)}`),
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
  const resultBinding = readJsonArtifact('origin-result-binding.json');
  const bodyBytes = present.get('origin-result-body.bin');
  if (resultBinding.kind !== 'absent') {
    if (resultBinding.kind === 'malformed') {
      checks.push(fail('origin result body', 'the result binding is not readable as JSON'));
    } else if (!isJsonObject(resultBinding.value)) {
      checks.push(fail('origin result body', 'the result binding is not a JSON object'));
    } else if (bodyBytes === undefined) {
      checks.push(fail('origin result body', 'the result binding exists but the body is missing'));
    } else {
      const boundBodyDigest = resultBinding.value['bodyDigest'];
      const recomputed: Sha256Digest = digestBytes(bodyBytes);
      checks.push(
        recomputed === boundBodyDigest
          ? pass('origin result body', recomputed)
          : fail(
              'origin result body',
              `recomputed ${recomputed}, binding names ${describeBound(boundBodyDigest)}`,
            ),
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
  const observationRead = readJsonArtifact('chain-observation.json');
  if (observationRead.kind === 'malformed') {
    checks.push(fail('chain observation', 'chain-observation.json is not readable as JSON'));
  } else if (observationRead.kind === 'parsed' && !isJsonObject(observationRead.value)) {
    checks.push(fail('chain observation', 'chain-observation.json is not a JSON object'));
  } else if (observationRead.kind === 'parsed') {
    const observation = observationRead.value as {
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
              `${describeBound(rpc.status)}, for the transaction the settlement recorded`,
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

function keyFrom(path: string): LoadedIssuerPublicKey {
  try {
    return readIssuerPublicKeyFile(path);
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
  const supplied = request.publicKeyFile === undefined ? undefined : keyFrom(request.publicKeyFile);
  const publicKey = supplied?.publicKey ?? (await resolveIssuerKey('fixture')).publicKey;

  const report = await verifyEvidence(
    request.directory,
    publicKey,
    supplied === undefined
      ? undefined
      : { algorithm: supplied.algorithm, kid: supplied.kid, issuer: supplied.issuer },
  );
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
