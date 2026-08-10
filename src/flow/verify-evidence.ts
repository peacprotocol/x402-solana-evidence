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
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Entry point for `pnpm verify`: verify the committed offline evidence.
 *
 * It takes the directory and the test-only public key and reads nothing else, which is the same
 * position a reader of this repository is in.
 */
export async function main(): Promise<void> {
  const issuerKey = await resolveIssuerKey('fixture');
  const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, issuerKey.publicKey);
  console.log(formatReport(EXPECTED_EVIDENCE_DISPLAY, report));
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
