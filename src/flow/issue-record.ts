/**
 * One PEAC record per run, and the evidence directory around it.
 *
 * ONE RECORD, NOT A BUNDLE. The record carries digests; the documents those digests cover sit
 * beside it as ordinary files. No archive format, manifest or container is invented here: a
 * directory of files and a signed record that names them by digest is enough, and anything more
 * would be a format this example is in no position to define.
 *
 * WHAT GOES WHERE. The registered commerce group carries the registered payment fields and nothing
 * else, because it validates strictly and rejects unknown keys, which is what makes it a shared
 * vocabulary rather than a bag. Everything observational lives in an example-local group whose key
 * is namespaced to this example, so it cannot be mistaken for a registered PEAC field.
 *
 * DETERMINISM. Issuance stamps an issued-at time from the process clock and there is no option to
 * supply one, so the offline path pins the clock for the duration of the call. That is the whole
 * of the determinism arrangement: the record identifier is supplied, every other input is fixed,
 * and no part of the issuance path is patched or reimplemented.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issue } from '@peac/protocol';
import type { Sha256Digest } from '../digest.ts';
import type {
  PaymentEvidenceOriginResultBindingV1,
  PaymentEvidenceRequestBindingV1,
} from '../binding.ts';
import { bindingDigest } from '../binding.ts';
import type { IssuerKey } from './issuer-key.ts';
import type { LifecycleObservation } from './lifecycle.ts';
import { chainObservationDigest, type SolanaChainObservationV1 } from './observe-settlement.ts';
import type { EvidenceArtifact } from './presence.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Where the deterministic offline evidence is committed, so it can be verified without a run. */
export const EXPECTED_EVIDENCE_DIR = join(APP_ROOT, 'fixtures', 'expected-evidence');
/** Repository-relative name, used in output so no machine-specific path is ever printed. */
export const EXPECTED_EVIDENCE_DISPLAY = 'fixtures/expected-evidence';
/** Where a live run writes its evidence. Gitignored: it describes one run, not a fixture. */
export const runEvidenceDir = (runId: string): string => join(APP_ROOT, 'out', runId);
/** Repository-relative name for a live run's directory, so no machine-specific path is printed. */
export const runEvidenceDisplay = (runId: string): string => `out/${runId}`;

/** Registered PEAC record type for commerce evidence. */
export const RECORD_TYPE = 'org.peacprotocol/payment';
/** Registered extension group this record type requires. */
export const COMMERCE_GROUP = 'org.peacprotocol/commerce';
/** Example-local group. Namespaced, unregistered, and never presented as a PEAC field set. */
export const PAYMENT_EVIDENCE_GROUP = 'com.example/payment_evidence';

/** Observed x402 field values, each already accepted at the capture boundary. */
export interface ObservedFieldDigests {
  readonly 'payment-required': { readonly value: string; readonly digest: Sha256Digest };
  readonly 'payment-signature'?: { readonly value: string; readonly digest: Sha256Digest };
  readonly 'payment-response'?: { readonly value: string; readonly digest: Sha256Digest };
}

export interface EvidenceInputs {
  readonly issuerKey: IssuerKey;
  /**
   * Record identifier. Supplied so an offline run reproduces byte for byte. A live run omits it
   * and issuance generates one, because a run that happened once has nothing to reproduce.
   */
  readonly jti?: string;
  /** When the interaction happened, as an RFC 3339 timestamp. */
  readonly occurredAt: string;
  /** Pinned issued-at time, in Unix seconds. Offline only; a live run uses the real clock. */
  readonly issuedAtUnixSeconds?: number;
  readonly requestBinding: PaymentEvidenceRequestBindingV1;
  readonly originResultBinding?: PaymentEvidenceOriginResultBindingV1;
  readonly originResultBody?: Uint8Array;
  readonly observedFields: ObservedFieldDigests;
  readonly chainObservation: SolanaChainObservationV1;
  readonly lifecycle: LifecycleObservation;
  /** Payment reference the client used, when the payment-identifier extension was in play. */
  readonly paymentReference?: string;
  /** Currency or asset symbol for the registered commerce group. */
  readonly currency: string;
  readonly environment: 'live' | 'test';
}

export interface EvidenceLayout {
  readonly jws: string;
  /** Relative path to file bytes, exactly as written. */
  readonly files: ReadonlyMap<EvidenceArtifact, Uint8Array>;
}

const encoder = new TextEncoder();

/** Canonical JSON serialization for the sidecar documents, so a reader can recompute digests. */
function documentBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run a function with the process clock pinned.
 *
 * Issuance derives the issued-at claim from `Date.now`. Rather than patch or fork that path, the
 * offline run fixes the clock around the call and restores it immediately, which is the same thing
 * a fixed clock means anywhere else. A live run never uses this.
 */
async function withPinnedClock<T>(unixSeconds: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (unixSeconds === undefined) return fn();
  const realNow = Date.now;
  Date.now = () => unixSeconds * 1000;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Issue the record and assemble the evidence layout.
 *
 * Digests are computed before issuance because they are what the record binds; the record cannot
 * be issued and then have the documents chosen to match it.
 */
export async function issueEvidence(inputs: EvidenceInputs): Promise<EvidenceLayout> {
  const requestBindingDigest = await bindingDigest(inputs.requestBinding);
  const originResultBindingDigest =
    inputs.originResultBinding !== undefined
      ? await bindingDigest(inputs.originResultBinding)
      : undefined;
  const observationDigest = await chainObservationDigest(inputs.chainObservation);

  // Only the registered fields, because the group validates strictly. The lifecycle phase is
  // recorded only when settlement actually succeeded: `settlement` on a refused payment would be
  // exactly the overstatement this example exists to avoid.
  const commerce: Record<string, unknown> = {
    payment_rail: 'x402',
    amount_minor: inputs.chainObservation.amountBaseUnits,
    currency: inputs.currency,
    asset: inputs.chainObservation.asset,
    env: inputs.environment,
    ...(inputs.paymentReference !== undefined ? { reference: inputs.paymentReference } : {}),
    ...(inputs.chainObservation.settlementOutcome === 'succeeded' ? { event: 'settlement' } : {}),
  };

  const paymentEvidence: Record<string, unknown> = {
    terminal_state: inputs.lifecycle.terminalState,
    lifecycle_states: [...inputs.lifecycle.states],
    network: inputs.chainObservation.network,
    request_binding_digest: requestBindingDigest,
    ...(originResultBindingDigest !== undefined
      ? { origin_result_binding_digest: originResultBindingDigest }
      : {}),
    payment_required_digest: inputs.observedFields['payment-required'].digest,
    ...(inputs.observedFields['payment-signature'] !== undefined
      ? { payment_signature_digest: inputs.observedFields['payment-signature'].digest }
      : {}),
    ...(inputs.observedFields['payment-response'] !== undefined
      ? { payment_response_digest: inputs.observedFields['payment-response'].digest }
      : {}),
    chain_observation_digest: observationDigest,
  };

  const result = await withPinnedClock(inputs.issuedAtUnixSeconds, () =>
    issue({
      iss: inputs.issuerKey.iss,
      kind: 'evidence',
      type: RECORD_TYPE,
      privateKey: inputs.issuerKey.privateKey,
      kid: inputs.issuerKey.kid,
      jti: inputs.jti,
      pillars: ['commerce'],
      occurred_at: inputs.occurredAt,
      extensions: {
        [COMMERCE_GROUP]: commerce,
        [PAYMENT_EVIDENCE_GROUP]: paymentEvidence,
      },
    }),
  );

  const files = new Map<EvidenceArtifact, Uint8Array>();
  files.set('record.jws', encoder.encode(`${result.jws}\n`));
  files.set('request-binding.json', documentBytes(inputs.requestBinding));
  files.set('chain-observation.json', documentBytes(inputs.chainObservation));
  files.set(
    'artifacts/payment-required.txt',
    encoder.encode(inputs.observedFields['payment-required'].value),
  );
  if (inputs.observedFields['payment-signature'] !== undefined) {
    files.set(
      'artifacts/payment-signature.txt',
      encoder.encode(inputs.observedFields['payment-signature'].value),
    );
  }
  if (inputs.observedFields['payment-response'] !== undefined) {
    files.set(
      'artifacts/payment-response.txt',
      encoder.encode(inputs.observedFields['payment-response'].value),
    );
  }
  if (inputs.originResultBinding !== undefined) {
    files.set('origin-result-binding.json', documentBytes(inputs.originResultBinding));
  }
  if (inputs.originResultBody !== undefined) {
    files.set('origin-result-body.bin', inputs.originResultBody);
  }

  return { jws: result.jws, files };
}

/** Write an evidence layout to a directory, creating it if needed. */
export function writeEvidence(directory: string, layout: EvidenceLayout): void {
  for (const [relativePath, bytes] of layout.files) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
