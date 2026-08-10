/**
 * The offline end-to-end run.
 *
 * A real express server, the real x402 payment middleware, the real resource server and the real
 * upstream client, wired to an in-process facilitator and a wallet stand-in so the whole lifecycle
 * executes without a network. The server listens on the loopback interface only; nothing resolves
 * a name, dials a remote host or reaches a chain, which is why the same run passes in a job with
 * no network interface at all.
 *
 * Determinism comes from fixed inputs rather than from suppressing outputs: a fixed clock, fixed
 * account identifiers and a fixed payment identifier. The port is the one thing that cannot be
 * fixed, so the origin binds to an ephemeral port and no observed value derives from it: the
 * resource identity that reaches the evidence is the configured resource URL, not the loopback
 * address the process happened to receive.
 *
 * WHAT THIS RUN DOES NOT SHOW. No payment occurs. The facilitator settles nothing, the transaction
 * reference is fixed placeholder text, and no output of this run may be presented as a payment
 * having been made.
 */
import type { AddressInfo } from 'node:net';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
} from '@x402/extensions/payment-identifier';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginAcceptanceSuite, recordExecution } from '../acceptance-ids.ts';
import { captureObservedX402Artifact, requireValidX402Artifact } from '../x402-header.ts';
import { buildOriginResultBinding, buildRequestBinding } from '../binding.ts';
import { componentsFromAbsoluteUri } from '../components.ts';
import type { Sha256Digest } from '../digest.ts';
import * as F from '../../fixtures/deterministic.ts';
import { resolveIssuerKey, type RunMode } from './issuer-key.ts';
import { observeSettlement, type ObservationSource } from './observe-settlement.ts';
import {
  EXPECTED_EVIDENCE_DIR,
  EXPECTED_EVIDENCE_DISPLAY,
  issueEvidence,
  writeEvidence,
  type EvidenceLayout,
  type ObservedFieldDigests,
} from './issue-record.ts';
import { formatReport, verifyEvidence } from './verify-evidence.ts';
import { createFixtureFacilitatorClient, type FixtureFacilitatorBehavior } from './fixture-facilitator.ts';
import { FixtureExactWallet } from './fixture-wallet.ts';
import { createPaidResource, type OriginResult, type RequestObservation } from './server.ts';
import { fetchPaidResource, type PaidFetchResult } from './client.ts';
import type { TerminalState } from './lifecycle.ts';

/** Path of the paid resource, matching the fixture resource URL. */
export const RESOURCE_PATH = '/v1/forecast';
export const RESOURCE_QUERY = '?region=alpha&units=metric';

/** How the origin handler should behave, so the failure branches can be reached deliberately. */
export type HandlerBehavior = 'succeed' | 'throw' | 'error_status';

export interface RunOptions {
  readonly facilitator?: FixtureFacilitatorBehavior;
  readonly handler?: HandlerBehavior;
}

export interface RunResult {
  readonly client: PaidFetchResult;
  /** The origin's view of the unpaid request, which is where the challenge was emitted. */
  readonly challenge: RequestObservation;
  /** The origin's view of the paid retry, which is what the evidence describes. */
  readonly origin: RequestObservation;
  readonly terminalState: TerminalState;
}

/**
 * The paid result.
 *
 * Deliberately synthetic and free of anything sensitive, so a run can be published whole: the
 * record, the sidecar documents and the body itself, rather than digests standing in for content
 * nobody may see.
 */
function originResultFor(behavior: HandlerBehavior): OriginResult {
  if (behavior === 'throw') throw new Error('synthetic handler failure');
  if (behavior === 'error_status') {
    return {
      status: 503,
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify({ error: 'synthetic upstream unavailable' })),
    };
  }
  return {
    status: 200,
    contentType: 'application/json',
    body: F.ORIGIN_RESULT_BODY,
  };
}

/** Run one full request/challenge/pay/retry exchange against a freshly built origin. */
export async function runOnce(options: RunOptions = {}): Promise<RunResult> {
  const handlerBehavior = options.handler ?? 'succeed';
  const resource = await createPaidResource({
    facilitatorClient: createFixtureFacilitatorClient(SOLANA_DEVNET_CAIP2, options.facilitator ?? {}),
    registerSchemes: (server) => {
      // The genuine upstream SVM exact scheme server. With no RPC endpoint configured it embeds no
      // blockhash and performs no lookups, so the offline run uses the real scheme rather than a
      // stand-in on the side that matters most.
      registerExactSvmScheme(server, { networks: [SOLANA_DEVNET_CAIP2] });
    },
    network: SOLANA_DEVNET_CAIP2,
    payTo: F.PAY_TO,
    price: { asset: F.ASSET_MINT, amount: F.AMOUNT_BASE_UNITS },
    method: 'GET',
    path: RESOURCE_PATH,
    resourceUrl: F.RESOURCE_URL,
    maxTimeoutSeconds: F.MAX_TIMEOUT_SECONDS,
    declaredExtensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    handler: () => originResultFor(handlerBehavior),
  });

  const server = resource.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const client = await fetchPaidResource(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        network: SOLANA_DEVNET_CAIP2,
        registerSchemes: (c) => {
          c.register(SOLANA_DEVNET_CAIP2, new FixtureExactWallet(F.PAYMENT_ID));
        },
      },
      `${RESOURCE_PATH}${RESOURCE_QUERY}`,
    );
    // Two requests reach the protected route: the unpaid challenge, which carries the
    // payment-required value, and the paid retry, which is what the evidence describes.
    if (resource.observations.length !== 2) {
      throw new Error(`expected two origin observations, recorded ${resource.observations.length}`);
    }
    const [challenge, origin] = resource.observations as readonly [
      RequestObservation,
      RequestObservation,
    ];
    return { client, challenge, origin, terminalState: origin.lifecycle.terminalState };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Fixed record identifier, so a repeated offline run produces the same record bytes. */
const FIXTURE_JTI = '01984000-0000-7000-8000-0000a1b20201';

export const DETERMINISM_NOTE = 'determinism-note.txt';

/**
 * What makes the committed evidence reproducible, and what had to be pinned to get there.
 *
 * Written by the run rather than by hand, so it cannot describe an arrangement that has since
 * changed.
 */
function determinismNote(): string {
  return [
    'Reproducibility of this directory',
    '',
    'Every file here is byte-identical across runs of `pnpm demo:fixture`.',
    '',
    'Inputs that would otherwise vary are pinned, not suppressed:',
    `  record identifier (jti)   supplied to issuance: ${FIXTURE_JTI}`,
    `  occurred-at and observed-at fixed at Unix ${F.FIXED_NOW_UNIX_SECONDS}`,
    '  payer, recipient, fee payer, blockhash and transaction reference are the fixed',
    '    synthetic values from the conformance fixtures',
    `  payment identifier        ${F.PAYMENT_ID}`,
    '  issuer key                the clearly labelled test-only key in src/flow/issuer-key.ts',
    '',
    'One input is derived from the process clock and cannot be supplied:',
    '  the issued-at claim (iat). PEAC issuance stamps it from the clock and exposes no option',
    '  to set it, so the offline run fixes the process clock around the issuance call and',
    '  restores it immediately afterwards. Nothing in the issuance path is patched or replaced.',
    '  The signature covers iat, so without this the record bytes, and only the record bytes,',
    '  would differ between runs.',
    '',
    'The listening port is not fixed and does not need to be: no bound value derives from it.',
    'The resource is identified by its configured URL, not by the loopback address.',
    '',
    'This evidence describes an offline run. No payment occurred, no facilitator or node was',
    'contacted, and the transaction reference is placeholder text.',
    '',
  ].join('\n');
}

/**
 * What differs between an offline run and a live one.
 *
 * Only these values. The capture, binding, issuance and verification path below is the same code in
 * both modes, so a live run cannot drift into a second evidence model: it supplies its own issuer
 * key, resource identity, observation source and clock, and nothing else changes.
 */
export interface EvidenceOptions {
  /** Selects the issuer key: the fixed test key, or the local devnet demonstration key. */
  readonly mode: RunMode;
  /** Resource identity that reaches the binding. Always the configured URL, never a socket address. */
  readonly resourceUrl: string;
  readonly requestBody: Uint8Array;
  /** Supplied offline so the record bytes reproduce; omitted live, where issuance generates one. */
  readonly jti?: string;
  /** Observation time, and the instant the record reports the interaction occurred. */
  readonly observedAtUnixSeconds: number;
  /** Pins the issued-at claim. Offline only: a live run stamps it from the real clock. */
  readonly issuedAtUnixSeconds?: number;
  readonly observationSource: ObservationSource;
  readonly assetDecimals: number;
  /** Payment identifier the client sent, when the payment-identifier extension was in play. */
  readonly paymentReference?: string;
  readonly currency: string;
  readonly environment: 'live' | 'test';
}

/** The offline run's inputs: fixed key, fixed clock, fixed identifiers, no network contacted. */
export const FIXTURE_EVIDENCE_OPTIONS: EvidenceOptions = {
  mode: 'fixture',
  resourceUrl: F.RESOURCE_URL,
  requestBody: F.REQUEST_BODY,
  jti: FIXTURE_JTI,
  observedAtUnixSeconds: F.FIXED_NOW_UNIX_SECONDS,
  issuedAtUnixSeconds: F.FIXED_NOW_UNIX_SECONDS,
  observationSource: {
    kind: 'in_process_fixture',
    reference: 'offline run, no facilitator and no node were contacted',
  },
  assetDecimals: F.TOKEN_DECIMALS,
  paymentReference: F.PAYMENT_ID,
  currency: 'USDC',
  environment: 'test',
};

/**
 * Turn one run into an evidence layout.
 *
 * Every observed field value goes through the same staged capture the rest of the profile uses, so
 * the digest that reaches the record is over a value that was accepted at the capture boundary
 * rather than over whatever bytes happened to arrive.
 */
export async function buildEvidence(
  run: RunResult,
  options: EvidenceOptions = FIXTURE_EVIDENCE_OPTIONS,
): Promise<EvidenceLayout> {
  const issuerKey = await resolveIssuerKey(options.mode);

  const observedRequired = run.challenge.observedHeaders['payment-required'];
  if (observedRequired === undefined) throw new Error('no payment-required field was observed');
  const requiredArtifact = await captureObservedX402Artifact({
    name: 'Payment-Required',
    observedValue: observedRequired,
    capturePoint: 'origin_response_before_gateway',
    httpVersion: '1.1',
  });

  const observedSignature = run.origin.observedHeaders['payment-signature'];
  const signatureArtifact =
    observedSignature === undefined
      ? undefined
      : await captureObservedX402Artifact({
          name: 'Payment-Signature',
          observedValue: observedSignature,
          capturePoint: 'origin_request_after_http_parsing',
          httpVersion: '1.1',
        });

  const observedResponse = run.origin.observedHeaders['payment-response'];
  const responseArtifact =
    observedResponse === undefined
      ? undefined
      : await captureObservedX402Artifact({
          name: 'Payment-Response',
          observedValue: observedResponse,
          capturePoint: 'origin_response_before_gateway',
          httpVersion: '1.1',
        });

  const observedFields: ObservedFieldDigests = {
    'payment-required': {
      value: requiredArtifact.observedValue,
      digest: requiredArtifact.observedValueDigest,
    },
    ...(signatureArtifact !== undefined
      ? {
          'payment-signature': {
            value: signatureArtifact.observedValue,
            digest: signatureArtifact.observedValueDigest,
          },
        }
      : {}),
    ...(responseArtifact !== undefined
      ? {
          'payment-response': {
            value: responseArtifact.observedValue,
            digest: responseArtifact.observedValueDigest,
          },
        }
      : {}),
  };

  // The resource is identified by its configured URL, not by the loopback address the process
  // happened to be given, so the binding describes the resource rather than the test harness.
  const requestBinding = buildRequestBinding({
    components: componentsFromAbsoluteUri({ method: 'GET', absoluteUri: options.resourceUrl }),
    body: options.requestBody,
    selectedHeaders:
      signatureArtifact === undefined
        ? []
        : [{ name: 'payment-signature', observedValueDigest: signatureArtifact.observedValueDigest }],
  });

  const originResultBinding =
    run.origin.originResult === undefined
      ? undefined
      : buildOriginResultBinding({
          status: run.origin.originResult.status,
          contentType: run.origin.originResult.contentType,
          body: run.origin.originResult.body,
        });

  const serviceResultDigest: Sha256Digest | undefined = originResultBinding?.bodyDigest;

  const chainObservation = observeSettlement({
    requirements: run.client.paymentPayload.accepted,
    paymentPayload: run.client.paymentPayload,
    ...(run.client.parsed.header !== undefined && 'success' in run.client.parsed.header
      ? { settleResponse: run.client.parsed.header }
      : {}),
    ...(responseArtifact !== undefined
      ? { settlementResponseDigest: responseArtifact.observedValueDigest }
      : {}),
    ...(serviceResultDigest !== undefined ? { serviceResultDigest } : {}),
    lifecycle: run.origin.lifecycle,
    observationSource: options.observationSource,
    observedAtUnixSeconds: options.observedAtUnixSeconds,
    assetDecimals: options.assetDecimals,
  });

  return issueEvidence({
    issuerKey,
    ...(options.jti !== undefined ? { jti: options.jti } : {}),
    occurredAt: new Date(options.observedAtUnixSeconds * 1000).toISOString(),
    ...(options.issuedAtUnixSeconds !== undefined
      ? { issuedAtUnixSeconds: options.issuedAtUnixSeconds }
      : {}),
    requestBinding,
    ...(originResultBinding !== undefined ? { originResultBinding } : {}),
    ...(run.origin.originResult !== undefined
      ? { originResultBody: run.origin.originResult.body }
      : {}),
    observedFields,
    chainObservation,
    lifecycle: run.origin.lifecycle,
    ...(options.paymentReference !== undefined
      ? { paymentReference: options.paymentReference }
      : {}),
    currency: options.currency,
    environment: options.environment,
  });
}

/** Entry point for `demo:fixture`. Prints the run and records the cases it exercised. */
export async function main(): Promise<void> {
  beginAcceptanceSuite('flow');

  const success = await runOnce();

  console.log('\nSolana exact-scheme reference flow: offline run\n');
  console.log(`  network             : ${SOLANA_DEVNET_CAIP2}`);
  console.log(`  resource            : ${F.RESOURCE_URL}`);
  console.log(`  unpaid status       : ${success.client.unpaidStatus}`);
  console.log(`  paid status         : ${success.client.paidStatus}`);
  console.log(`  payment status      : ${success.client.parsed.paymentStatus}`);
  console.log(`  lifecycle           : ${success.origin.lifecycle.states.join(' -> ')}`);
  console.log(`  terminal state      : ${success.terminalState}`);
  console.log(`  settlement reference: ${success.origin.lifecycle.transaction ?? '(none)'}`);

  if (success.terminalState !== 'response_write_attempted') {
    throw new Error(`expected response_write_attempted, observed ${success.terminalState}`);
  }
  recordExecution('SVM-FLOW-001');

  // The challenge the origin emitted has to be a valid x402 payment-required value, checked by the
  // upstream validator through the staged capture rather than by inspecting the object here.
  const challenge = success.challenge.observedHeaders['payment-required'];
  if (challenge === undefined) throw new Error('the origin emitted no payment-required field');
  const validated = await requireValidX402Artifact({
    name: 'Payment-Required',
    observedValue: challenge,
    capturePoint: 'origin_response_before_gateway',
    httpVersion: '1.1',
  });
  console.log(`  challenge stages    : ${Object.entries(validated.stages).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  recordExecution('SVM-FLOW-002');

  /**
   * Each failure branch is a state the evidence has to be able to describe, so each is run and its
   * terminal state and response status asserted.
   *
   * A handler that throws and a handler that returns an error status reach the same terminal
   * state, because express converts the throw into an error response before the middleware sees
   * it. They are told apart by the status, and both cancel the verified payment without settling,
   * which is the property that matters.
   */
  const branches: ReadonlyArray<{
    readonly label: string;
    readonly options: RunOptions;
    readonly terminal: TerminalState;
    readonly status?: number;
  }> = [
    {
      label: 'verification rejected',
      options: { facilitator: { rejectVerification: 'synthetic_verification_refusal' } },
      terminal: 'verification_rejected',
    },
    { label: 'handler threw', options: { handler: 'throw' }, terminal: 'handler_error_status', status: 500 },
    {
      label: 'handler error status',
      options: { handler: 'error_status' },
      terminal: 'handler_error_status',
      status: 503,
    },
    {
      label: 'settlement failed',
      options: { facilitator: { rejectSettlement: 'synthetic_settlement_refusal' } },
      terminal: 'settlement_failed',
    },
  ];
  console.log('\n  failure branches');
  for (const branch of branches) {
    const run = await runOnce(branch.options);
    const lifecycle = run.origin.lifecycle;
    console.log(
      `    ${branch.label.padEnd(22)}: ${run.terminalState}` +
        `${lifecycle.cancellationReason ? ` (${lifecycle.cancellationReason})` : ''}` +
        `${lifecycle.responseStatus !== undefined ? ` status ${lifecycle.responseStatus}` : ''}`,
    );
    if (run.terminalState !== branch.terminal) {
      throw new Error(`expected ${branch.terminal}, observed ${run.terminalState}`);
    }
    if (branch.status !== undefined && lifecycle.responseStatus !== branch.status) {
      throw new Error(`expected status ${branch.status}, observed ${lifecycle.responseStatus}`);
    }
    if (lifecycle.states.includes('payment_settled')) {
      throw new Error(`${branch.label} settled the payment, which it must not`);
    }
  }
  recordExecution('SVM-LIFE-001');
  recordExecution('SVM-LIFE-002');
  recordExecution('SVM-LIFE-003');
  recordExecution('SVM-LIFE-004');

  // The settlement failure branch is the one worth stating plainly: the resource was produced and
  // the payment did not settle, so the result was never written to the client.
  const settlementFailed = await runOnce({
    facilitator: { rejectSettlement: 'synthetic_settlement_refusal' },
  });
  const wrote = settlementFailed.client.body.byteLength > 0;
  const capturedResponseField = settlementFailed.origin.observedHeaders['payment-response'];
  console.log('\n  settlement-failure detail');
  console.log(`    origin result produced : ${settlementFailed.origin.originResult !== undefined}`);
  console.log(`    origin result written  : false`);
  console.log(`    client received bytes  : ${wrote ? 'an error response' : 'nothing'}`);
  console.log(`    payment-response field : ${capturedResponseField === undefined ? 'absent' : 'present'}`);

  // The evidence for the successful run is written to the committed directory, then verified from
  // that directory alone: the verifier is handed files and a public key, and nothing else.
  const layout = await buildEvidence(success);
  writeEvidence(EXPECTED_EVIDENCE_DIR, layout);
  writeFileSync(join(EXPECTED_EVIDENCE_DIR, DETERMINISM_NOTE), determinismNote());

  const issuerKey = await resolveIssuerKey('fixture');
  const report = await verifyEvidence(EXPECTED_EVIDENCE_DIR, issuerKey.publicKey);
  writeFileSync(
    join(EXPECTED_EVIDENCE_DIR, 'verification-report.txt'),
    formatReport(EXPECTED_EVIDENCE_DISPLAY, report).trimStart(),
  );
  console.log(formatReport(EXPECTED_EVIDENCE_DISPLAY, report));
  if (!report.ok) throw new Error('the committed evidence did not verify');
  recordExecution('SVM-FLOW-003');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
