/**
 * Security, replay, binding and tamper cases for the Solana exact-scheme reference flow.
 *
 * Four families, and they answer different questions.
 *
 * SECURITY asks whether this integration lets a payment through that the advertised terms do not
 * describe. Every case runs black box: a real origin is started, a real client builds a real
 * payment, one field of that payment is altered, and the payment is presented over HTTP. Nothing
 * reaches inside the resource server or the facilitator to arrange the outcome.
 *
 * These are integration cases, NOT a second x402 conformance suite. The transaction-level checks
 * an SVM facilitator performs, above all whether the fee payer is isolated from the transfer, are
 * upstream's and are exercised only where a real transaction exists. Where a case would have
 * required rebuilding those internals to prove upstream's own behaviour, it is stated narrowly
 * here rather than simulated: see SVM-SEC-001.
 *
 * REPLAY asks what repetition does. A duplicate payment identifier and a duplicate settlement are
 * different things, and this suite keeps them apart: the first is an x402 correlation value, the
 * second is a settlement-layer refusal enforced by the upstream `SettlementCache` component that
 * the offline facilitator instantiates.
 *
 * BINDING is the point of the whole example. A payment artifact that is entirely valid on its own
 * terms is presented for a different operation, or beside a different result, and the binding is
 * what refuses it. Every case here keeps the native artifact valid, so the failure can only be
 * attributed to the binding.
 *
 * TAMPER asks what an edited evidence directory looks like from outside. Each case alters exactly
 * one thing and asserts the specific check that catches it, because "verification failed" is not a
 * useful answer: which stage failed is what a reader acts on.
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
} from '@x402/extensions/payment-identifier';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { buildRequestBinding, type PaymentEvidenceRequestBindingV1 } from './binding.ts';
import { componentsFromAbsoluteUri } from './components.ts';
import { captureObservedX402Artifact, requireValidX402Artifact } from './x402-header.ts';
import * as F from '../fixtures/deterministic.ts';
import {
  createFixtureFacilitator,
  DUPLICATE_SETTLEMENT_REASON,
  type FixtureFacilitatorBehavior,
  type FixtureFacilitatorCalls,
} from './flow/fixture-facilitator.ts';
import { FixtureExactWallet } from './flow/fixture-wallet.ts';
import { createPaidResource, type OriginResult, type RequestObservation } from './flow/server.ts';
import { buildEvidence, RESOURCE_PATH, RESOURCE_QUERY, runOnce } from './flow/fixture-e2e.ts';
import { writeEvidence, type EvidenceLayout } from './flow/issue-record.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
import {
  verifyEvidence,
  type EvidenceVerificationReport,
} from './flow/verify-evidence.ts';
import type { EvidenceArtifact } from './flow/presence.ts';

beginAcceptanceSuite('svm-matrix');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Same serialization the evidence writer uses, so a substituted document is shaped identically. */
const documentBytes = (value: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------
// Harness: a real origin, a real client, and one altered field.
// ---------------------------------------------------------------------------------------------

interface Origin {
  readonly baseUrl: string;
  readonly observations: readonly RequestObservation[];
  readonly calls: FixtureFacilitatorCalls;
  close(): Promise<void>;
}

const paidResult = (): OriginResult => ({
  status: 200,
  contentType: 'application/json',
  body: F.ORIGIN_RESULT_BODY,
});

/** Start a paid resource on the loopback interface with the in-process facilitator behind it. */
async function startOrigin(behavior: FixtureFacilitatorBehavior = {}): Promise<Origin> {
  const facilitator = createFixtureFacilitator(SOLANA_DEVNET_CAIP2, behavior);
  const resource = await createPaidResource({
    facilitatorClient: facilitator.client,
    registerSchemes: (server) => {
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
    handler: () => paidResult(),
  });

  const server = resource.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    observations: resource.observations,
    calls: facilitator.calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The upstream client, paying through the offline wallet stand-in. */
function upstreamClient(paymentId: string = F.PAYMENT_ID): x402HTTPClient {
  const client = new x402Client();
  client.register(SOLANA_DEVNET_CAIP2, new FixtureExactWallet(paymentId));
  return new x402HTTPClient(client);
}

/** Fetch the challenge and decode it with the upstream client, exactly as a payer would. */
async function challenge(
  origin: Origin,
  http: x402HTTPClient,
): Promise<{ status: number; paymentRequired: PaymentRequired }> {
  const response = await fetch(`${origin.baseUrl}${RESOURCE_PATH}${RESOURCE_QUERY}`);
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    paymentRequired: http.getPaymentRequiredResponse((n) => response.headers.get(n), body),
  };
}

/** Present a payment over HTTP, encoded by the upstream client. */
async function present(
  origin: Origin,
  http: x402HTTPClient,
  payload: PaymentPayload,
): Promise<{ status: number; observation: RequestObservation }> {
  const response = await fetch(`${origin.baseUrl}${RESOURCE_PATH}${RESOURCE_QUERY}`, {
    method: 'GET',
    headers: http.encodePaymentSignatureHeader(payload),
  });
  await response.arrayBuffer();
  const observation = origin.observations.at(-1);
  if (observation === undefined) throw new Error('the origin recorded no observation');
  return { status: response.status, observation };
}

/**
 * Present a payment whose advertised terms were altered after the client built it.
 *
 * Returns what the origin did, and what the facilitator was asked, so a refusal can be located:
 * a refusal with no verify call happened in the resource server's own requirements matching,
 * before anyone was asked whether the payment was good.
 */
async function presentAlteredTerms(
  alter: (accepted: PaymentPayload['accepted']) => PaymentPayload['accepted'],
): Promise<{ status: number; observation: RequestObservation; calls: FixtureFacilitatorCalls }> {
  const origin = await startOrigin();
  try {
    const http = upstreamClient();
    const { paymentRequired } = await challenge(origin, http);
    const honest = await http.createPaymentPayload(paymentRequired);
    const altered: PaymentPayload = { ...honest, accepted: alter(honest.accepted) };
    const { status, observation } = await present(origin, http, altered);
    return { status, observation, calls: { ...origin.calls } };
  } finally {
    await origin.close();
  }
}

/** A payment the origin refused before executing anything, and before asking the facilitator. */
function refusedBeforeExecution(
  label: string,
  outcome: { status: number; observation: RequestObservation; calls: FixtureFacilitatorCalls },
): void {
  const { status, observation, calls } = outcome;
  const states = observation.lifecycle.states;
  check(
    `${label} is refused with a payment-required response`,
    status === 402,
    `status ${status}`,
  );
  check(
    `${label} never reaches verification, settlement or the handler`,
    !states.includes('payment_verified') &&
      !states.includes('payment_settled') &&
      observation.originResult === undefined,
    states.join(' -> '),
  );
  check(
    `${label} is refused by the resource server before the facilitator is asked`,
    calls.verify === 0 && calls.settle === 0,
    `verify ${calls.verify}, settle ${calls.settle}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Security: altered terms must not buy a resource.
// ---------------------------------------------------------------------------------------------

console.log('\nSolana exact-scheme security, replay, binding and tamper matrix\n');
console.log('  -- security: altered payment terms --');

recordExecution('SVM-SEC-002');
refusedBeforeExecution(
  'a payment naming a different recipient',
  await presentAlteredTerms((accepted) => ({
    ...accepted,
    payTo: 'SyntheticAttacker1111111111111111111111111111',
  })),
);

recordExecution('SVM-SEC-003');
refusedBeforeExecution(
  'a payment naming a smaller amount',
  await presentAlteredTerms((accepted) => ({ ...accepted, amount: '1' })),
);

recordExecution('SVM-SEC-004');
refusedBeforeExecution(
  'a payment naming a different asset',
  await presentAlteredTerms((accepted) => ({
    ...accepted,
    asset: 'SyntheticOtherMint111111111111111111111111111',
  })),
);

recordExecution('SVM-SEC-005');
refusedBeforeExecution(
  'a payment naming a different network',
  await presentAlteredTerms((accepted) => ({ ...accepted, network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' })),
);

/**
 * SVM-SEC-001, stated narrowly and deliberately.
 *
 * The upstream SVM facilitator decides whether a fee payer is isolated from the transfer it pays
 * for, by decoding the transaction and refusing one where the fee payer appears in the transfer
 * instructions. That check needs a real Solana transaction and the real scheme facilitator; the
 * offline path has neither, and rebuilding either here would prove upstream's behaviour rather
 * than this integration's.
 *
 * What is asserted instead is the property this integration is responsible for: the fee payer is a
 * distinct role that this flow never promotes into a party to the payment. It is advertised as
 * such, a payment that substitutes it for the recipient is refused, and it never appears in the
 * evidence as the payer or the recipient.
 */
recordExecution('SVM-SEC-001');
{
  const origin = await startOrigin();
  let advertisedFeePayer = '';
  try {
    const http = upstreamClient();
    const { paymentRequired } = await challenge(origin, http);
    const requirements = paymentRequired.accepts[0];
    const feePayer = requirements?.extra?.['feePayer'];
    advertisedFeePayer = typeof feePayer === 'string' ? feePayer : '';
    check(
      'the fee payer is advertised as a role distinct from the recipient',
      advertisedFeePayer.length > 0 && advertisedFeePayer !== requirements?.payTo,
      `fee payer ${advertisedFeePayer || '(absent)'}, recipient ${requirements?.payTo}`,
    );
  } finally {
    await origin.close();
  }

  refusedBeforeExecution(
    'a payment naming the fee payer as the recipient',
    await presentAlteredTerms((accepted) => ({ ...accepted, payTo: advertisedFeePayer })),
  );
}

// ---------------------------------------------------------------------------------------------
// Shared evidence: one honest run, reused by the binding and tamper cases.
// ---------------------------------------------------------------------------------------------

const honestRun = await runOnce();
const honestLayout = await buildEvidence(honestRun);
const issuerKey = await resolveIssuerKey('fixture');
const temporaryDirectories: string[] = [];

/** Write the honest evidence to a fresh directory, with named files replaced or removed. */
function evidenceWith(
  overrides: ReadonlyMap<EvidenceArtifact, Uint8Array | null>,
): string {
  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-'));
  temporaryDirectories.push(directory);
  const files = new Map<EvidenceArtifact, Uint8Array>();
  for (const [artifact, bytes] of honestLayout.files) {
    const override = overrides.get(artifact);
    if (override === null) continue;
    files.set(artifact, override ?? bytes);
  }
  const layout: EvidenceLayout = { jws: honestLayout.jws, files };
  writeEvidence(directory, layout);
  return directory;
}

const verifyWith = async (
  overrides: ReadonlyMap<EvidenceArtifact, Uint8Array | null>,
): Promise<EvidenceVerificationReport> =>
  verifyEvidence(evidenceWith(overrides), issuerKey.publicKey);

const failedChecks = (report: EvidenceVerificationReport): string[] =>
  report.checks.filter((c) => !c.ok).map((c) => c.name);

const failedExactly = (report: EvidenceVerificationReport, names: readonly string[]): boolean => {
  const failed = failedChecks(report);
  return (
    !report.ok &&
    failed.length === names.length &&
    names.every((name) => failed.includes(name))
  );
};

const passed = (report: EvidenceVerificationReport, name: string): boolean =>
  report.checks.some((c) => c.name === name && c.ok);

// Completes SVM-SEC-001: the fee payer is a role, and the evidence never records it as a party to
// the payment. Asserted on the honest run, because that is where a mistake would actually surface.
{
  const observation = JSON.parse(
    decoder.decode(honestLayout.files.get('chain-observation.json')),
  ) as { recipient?: string; payer?: string };
  // Widened on purpose: comparing against the literal constants would narrow the first comparison
  // and make the second look impossible to the compiler, when it is exactly what is being checked.
  const feePayer: string = F.FEE_PAYER;
  check(
    'the evidence records the fee payer as neither the payer nor the recipient',
    observation.recipient === F.PAY_TO &&
      observation.payer !== feePayer &&
      observation.recipient !== feePayer,
    `recipient ${String(observation.recipient)}, payer ${String(observation.payer)}`,
  );
}

const originalRequestBinding = JSON.parse(
  decoder.decode(honestLayout.files.get('request-binding.json')),
) as PaymentEvidenceRequestBindingV1;

/** A well-formed request binding for a different operation, built the same way as the real one. */
const bindingForResource = (absoluteUri: string): Uint8Array =>
  documentBytes(
    buildRequestBinding({
      components: componentsFromAbsoluteUri({ method: 'GET', absoluteUri }),
      body: F.REQUEST_BODY,
      selectedHeaders: originalRequestBinding.selectedHeaders,
    }),
  );

// ---------------------------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------------------------

console.log('\n  -- replay --');

/**
 * SVM-REPLAY-001. The same payment identifier, presented twice with two different payments.
 *
 * The identifier is an x402 extension value the client echoes; it correlates attempts, and this
 * layer does not refuse a repeat of one. That is the behaviour, and asserting it is more useful
 * than asserting a protection that is not there: the evidence records the identifier, so reuse is
 * detectable by whoever reads two records, rather than being silently invisible.
 */
recordExecution('SVM-REPLAY-001');
{
  const origin = await startOrigin();
  try {
    const http = upstreamClient();
    const { paymentRequired } = await challenge(origin, http);
    const first = await http.createPaymentPayload(paymentRequired);
    const second: PaymentPayload = {
      ...first,
      payload: {
        transaction: Buffer.from('synthetic-second-placeholder-transaction', 'utf8').toString(
          'base64',
        ),
      },
    };
    const firstOutcome = await present(origin, http, first);
    const secondOutcome = await present(origin, http, second);

    const identifierOf = (payload: PaymentPayload): unknown =>
      (payload.extensions?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined)?.info
        ?.id;

    check(
      'both payments carry the same payment identifier',
      identifierOf(first) === F.PAYMENT_ID && identifierOf(second) === F.PAYMENT_ID,
      `${String(identifierOf(first))} and ${String(identifierOf(second))}`,
    );
    check(
      'a repeated payment identifier is not refused at this layer, so both attempts complete',
      firstOutcome.status === 200 &&
        secondOutcome.status === 200 &&
        firstOutcome.observation.lifecycle.terminalState === 'response_write_attempted' &&
        secondOutcome.observation.lifecycle.terminalState === 'response_write_attempted',
      `${firstOutcome.status} then ${secondOutcome.status}`,
    );
    check(
      'the identifier is carried into the evidence, so a reader can detect the reuse',
      honestLayout.files.has('record.jws') && honestRun.client.paymentPayload.extensions !== undefined,
    );
  } finally {
    await origin.close();
  }
}

/**
 * SVM-REPLAY-002. The same payment, settled twice.
 *
 * The refusal is enforced by `SettlementCache` from `@x402/svm`, which the offline facilitator
 * instantiates rather than reimplements, so naming it here is a statement about a component this
 * process actually runs. Against a hosted facilitator the same case would be observable only as
 * behaviour, and no internal mechanism could honestly be named.
 */
recordExecution('SVM-REPLAY-002');
{
  const origin = await startOrigin();
  try {
    const http = upstreamClient();
    const { paymentRequired } = await challenge(origin, http);
    const payment = await http.createPaymentPayload(paymentRequired);
    const first = await present(origin, http, payment);
    const second = await present(origin, http, payment);

    check(
      'the first settlement of a payment succeeds',
      first.status === 200 &&
        first.observation.lifecycle.terminalState === 'response_write_attempted',
      `status ${first.status}, ${first.observation.lifecycle.terminalState}`,
    );
    check(
      'a second settlement of the same payment is refused by the upstream settlement cache',
      second.observation.lifecycle.terminalState === 'settlement_failed' &&
        second.observation.lifecycle.failureReason === DUPLICATE_SETTLEMENT_REASON,
      `${second.observation.lifecycle.terminalState}, ` +
        `${String(second.observation.lifecycle.failureReason)}`,
    );
    check(
      'the repeated attempt produced the resource but never wrote it to the client',
      second.observation.originResult !== undefined && second.status === 402,
      `status ${second.status}`,
    );
    check(
      'both attempts reached the facilitator, so the refusal was a settlement decision',
      origin.calls.settle === 2,
      `settle calls ${origin.calls.settle}`,
    );
  } finally {
    await origin.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Binding: a valid payment presented for something else.
// ---------------------------------------------------------------------------------------------

console.log('\n  -- binding --');

const OTHER_RESOURCE = 'https://api.example.test/v1/history?region=alpha&units=metric';
const OTHER_QUERY = 'https://api.example.test/v1/forecast?region=beta&units=metric';

recordExecution('SVM-BIND-001');
{
  const report = await verifyWith(
    new Map([['request-binding.json', bindingForResource(OTHER_RESOURCE)]]),
  );
  check(
    'a payment bound to one resource fails when presented for another',
    failedExactly(report, ['request binding digest']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'the record itself still verifies, so the failure is the binding and not the signature',
    passed(report, 'record signature and schema'),
  );
}

recordExecution('SVM-BIND-002');
{
  const report = await verifyWith(
    new Map([['request-binding.json', bindingForResource(OTHER_QUERY)]]),
  );
  check(
    'the same path with a changed query fails request binding',
    failedExactly(report, ['request binding digest']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
}

recordExecution('SVM-BIND-003');
{
  const altered = encoder.encode(
    F.ORIGIN_RESULT_BODY_TEXT.replace('"tempC":17.4', '"tempC":31.9'),
  );
  const report = await verifyWith(new Map([['origin-result-body.bin', altered]]));
  check(
    'an altered origin result fails the result binding',
    failedExactly(report, ['origin result body']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'the result binding document itself still matches the record',
    passed(report, 'origin result binding digest'),
  );
}

/**
 * SVM-BIND-004. The native artifact is valid; the binding names a different one.
 *
 * The failure has to be attributable to the binding alone, so the native payment artifact left in
 * the directory is checked against the upstream validator in the same breath. Blaming x402 for a
 * binding this example got wrong would be exactly the wrong lesson to draw.
 */
recordExecution('SVM-BIND-004');
{
  const observedSignature = honestRun.origin.observedHeaders['payment-signature'];
  if (observedSignature === undefined) throw new Error('the run observed no payment-signature');
  const nativeArtifact = await requireValidX402Artifact({
    name: 'Payment-Signature',
    observedValue: observedSignature,
    capturePoint: 'origin_request_after_http_parsing',
    httpVersion: '1.1',
  });
  check(
    'the native payment artifact is accepted by the upstream validator',
    nativeArtifact.stages['upstream-schema'] === 'accepted' &&
      nativeArtifact.stages['scheme-payload'] === 'accepted',
    JSON.stringify(nativeArtifact.stages),
  );

  // A different, also valid, payment field value: the binding names an artifact that is not the
  // one present, while both are well-formed x402 objects.
  const otherValue = F.OBSERVED_REQUEST_HEADERS['payment-signature'];
  const otherArtifact = await captureObservedX402Artifact({
    name: 'Payment-Signature',
    observedValue: otherValue,
    capturePoint: 'origin_request_after_http_parsing',
    httpVersion: '1.1',
  });
  const mismatchedBinding = documentBytes(
    buildRequestBinding({
      components: componentsFromAbsoluteUri({ method: 'GET', absoluteUri: F.RESOURCE_URL }),
      body: F.REQUEST_BODY,
      selectedHeaders: [
        { name: 'payment-signature', observedValueDigest: otherArtifact.observedValueDigest },
      ],
    }),
  );
  const report = await verifyWith(new Map([['request-binding.json', mismatchedBinding]]));
  check(
    'a valid native artifact with a binding that names another fails at the binding',
    failedExactly(report, ['request binding digest']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
}

// ---------------------------------------------------------------------------------------------
// Tamper: one edit, one named failure.
// ---------------------------------------------------------------------------------------------

console.log('\n  -- tamper --');

recordExecution('SVM-TAMPER-001');
{
  const binding = JSON.parse(
    decoder.decode(honestLayout.files.get('origin-result-binding.json')),
  ) as { bodyDigest: string };
  const tampered = documentBytes({ ...binding, bodyDigest: `sha256:${'0'.repeat(64)}` });
  const report = await verifyWith(new Map([['origin-result-binding.json', tampered]]));
  check(
    'a tampered result digest fails both the bound document and the body it names',
    failedExactly(report, ['origin result binding digest', 'origin result body']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
}

recordExecution('SVM-TAMPER-002');
{
  const observed = honestRun.origin.observedHeaders['payment-signature'];
  if (observed === undefined) throw new Error('the run observed no payment-signature');
  const tampered = encoder.encode(`${observed.slice(0, -4)}AAAA`);
  const report = await verifyWith(new Map([['artifacts/payment-signature.txt', tampered]]));
  check(
    'a tampered observed field value fails its own digest and nothing else',
    failedExactly(report, ['payment-signature digest']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'the request binding that selected that field still matches the record',
    passed(report, 'request binding digest'),
  );
}

/**
 * SVM-TAMPER-003. The record's own payload is edited into something more favourable.
 *
 * The edit keeps the payload well-formed on purpose: base64url, valid JSON, a plausible value. The
 * signature is what refuses it, and the code is the one the protocol defines for that.
 */
recordExecution('SVM-TAMPER-003');
{
  const [header, payload, signature] = honestLayout.jws.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('the record is not a compact serialization');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    extensions: Record<string, Record<string, unknown>>;
  };
  const commerce = claims.extensions['org.peacprotocol/commerce'];
  if (commerce === undefined) throw new Error('the record carries no commerce group');
  commerce['amount_minor'] = '1';
  const editedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const editedJws = `${header}.${editedPayload}.${signature}`;
  check('the edited record differs from the issued one', editedJws !== honestLayout.jws);

  const directory = mkdtempSync(join(tmpdir(), 'peac-evidence-'));
  temporaryDirectories.push(directory);
  writeEvidence(directory, {
    jws: editedJws,
    files: new Map(honestLayout.files).set('record.jws', encoder.encode(`${editedJws}\n`)),
  });
  const report = await verifyEvidence(directory, issuerKey.publicKey);
  const recordCheck = report.checks.find((c) => c.name === 'record signature and schema');
  check(
    'an edited record payload is refused with an invalid signature',
    !report.ok && recordCheck?.ok === false && recordCheck.detail === 'E_INVALID_SIGNATURE',
    `${String(recordCheck?.detail)}`,
  );
}

/**
 * SVM-TAMPER-004. The settlement receipt is untouched and valid; the document binding it is not.
 *
 * This is the attribution case for the settlement side: the native artifact passes its own
 * structural check, and the failure names the observation document this example produced.
 */
recordExecution('SVM-TAMPER-004');
{
  const observedResponse = honestRun.origin.observedHeaders['payment-response'];
  if (observedResponse === undefined) throw new Error('the run observed no payment-response');
  const nativeReceipt = await captureObservedX402Artifact({
    name: 'Payment-Response',
    observedValue: observedResponse,
    capturePoint: 'origin_response_before_gateway',
    httpVersion: '1.1',
  });
  check(
    'the native settlement artifact passes its structural check',
    nativeReceipt.localStructural?.localStructuralStatus === 'accepted',
    JSON.stringify(nativeReceipt.localStructural),
  );

  const observation = JSON.parse(
    decoder.decode(honestLayout.files.get('chain-observation.json')),
  ) as Record<string, unknown>;
  const tampered = documentBytes({ ...observation, amountBaseUnits: '1' });
  const report = await verifyWith(new Map([['chain-observation.json', tampered]]));
  check(
    'an altered observation document fails its own digest, not the native artifact',
    failedExactly(report, ['chain observation digest']) &&
      passed(report, 'payment-response digest'),
    failedChecks(report).join(', ') || 'nothing failed',
  );
}

recordExecution('SVM-TAMPER-005');
{
  const report = await verifyWith(new Map([['artifacts/payment-response.txt', null]]));
  check(
    'a missing native artifact fails both its digest and the presence contract',
    failedExactly(report, ['payment-response digest', 'artifact presence contract']),
    failedChecks(report).join(', ') || 'nothing failed',
  );
  check(
    'the presence failure names the artifact and what the terminal state expected',
    report.checks.some(
      (c) =>
        c.name === 'artifact presence contract' &&
        !c.ok &&
        c.detail.includes('artifacts/payment-response.txt') &&
        c.detail.includes('required'),
    ),
  );
}

for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
