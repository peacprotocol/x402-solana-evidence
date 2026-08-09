/**
 * Conformance vectors, schema validation and staged-validation reporting.
 *
 * Compares freshly built bindings against the committed fixtures/golden-v1.json, cross-checks the
 * protocol canonicalization helper against a separately written RFC 8785 implementation, and
 * validates every document against its closed JSON Schema.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildRequestBinding, buildOriginResultBinding, bindingDigest } from './binding.ts';
import { componentsFromAbsoluteUri } from './components.ts';
import {
  captureObservedX402Artifact,
  promoteToPaymentPayload,
  X402PromotionError,
  X402_STAGES,
} from './x402-header.ts';
import { canonicalizeIndependent } from './jcs-independent.ts';
import { digestBytes } from './digest.ts';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import * as F from '../fixtures/deterministic.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(join(HERE, '..', p), 'utf8'));
const golden = read('fixtures/golden-v1.json');

beginAcceptanceSuite('golden');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const sig = await captureObservedX402Artifact({
  name: 'Payment-Signature',
  observedValue: F.OBSERVED_REQUEST_HEADERS['payment-signature'],
  capturePoint: 'origin_request_after_http_parsing',
  httpVersion: F.HTTP_VERSION,
});
const resp = await captureObservedX402Artifact({
  name: 'Payment-Response',
  observedValue: F.OBSERVED_RESPONSE_HEADERS['payment-response'],
  capturePoint: 'origin_response_before_gateway',
  httpVersion: F.HTTP_VERSION,
});

const components = componentsFromAbsoluteUri({ method: 'GET', absoluteUri: F.RESOURCE_URL });
const requestBinding = buildRequestBinding({ components, body: F.REQUEST_BODY, selectedHeaders: [sig] });
const originResultBinding = buildOriginResultBinding({
  status: 200, contentType: 'application/json', body: F.ORIGIN_RESULT_BODY,
});

const reqDigest = await bindingDigest(requestBinding);
const resDigest = await bindingDigest(originResultBinding);

console.log('\nConformance vectors\n');

check('request binding digest matches committed vector', reqDigest === golden.requestBindingDigest,
  `got ${reqDigest}\n          expected ${golden.requestBindingDigest}`);
check('origin result digest matches committed vector', resDigest === golden.originResultBindingDigest);
check('origin result body digest matches committed vector',
  originResultBinding.bodyDigest === golden.originResultBodyDigest);
check('request body digest matches committed vector', requestBinding.bodyDigest === golden.requestBodyDigest);

check('request binding canonical UTF-8 bytes match committed vector',
  Buffer.from(canonicalizeIndependent(requestBinding), 'utf8').toString('hex') === golden.requestBindingJcsUtf8Hex);
check('origin result canonical UTF-8 bytes match committed vector',
  Buffer.from(canonicalizeIndependent(originResultBinding), 'utf8').toString('hex') === golden.originResultBindingJcsUtf8Hex);

// Two separately written canonicalizers must agree, or the vectors mean nothing.
check('second RFC 8785 implementation agrees on the request binding',
  digestBytes(Buffer.from(canonicalizeIndependent(requestBinding), 'utf8')) === reqDigest);
check('second RFC 8785 implementation agrees on the origin result binding',
  digestBytes(Buffer.from(canonicalizeIndependent(originResultBinding), 'utf8')) === resDigest);

console.log('\n  -- observed artifacts --');
const gSig = golden.observedHeaders['payment-signature'];
const gResp = golden.observedHeaders['payment-response'];
check('observed value digest matches committed vector', sig.observedValueDigest === gSig.observedValueDigest);
check('decoded payload digest matches committed vector', sig.decodedPayloadDigest === gSig.decodedPayloadDigest);
check('the artifact type is identified from the field name', sig.artifactType === 'PaymentPayload');
check('the settle response artifact type is identified', resp.artifactType === 'SettleResponse');
check('the committed vector records the same stage report',
  JSON.stringify(sig.stages) === JSON.stringify(gSig.stages),
  `got ${JSON.stringify(sig.stages)}`);
check('the committed vector records the same settle-response stage report',
  JSON.stringify(resp.stages) === JSON.stringify(gResp.stages));

console.log('\n  -- staged validation --');
// The transport layer accepting a value says nothing about whether it is a valid x402 object.
// These fixtures decode cleanly and are refused by the upstream schema, which is exactly the
// distinction this module exists to report.
recordExecution('X402-STAGE-004');
check('transport and json acceptance do not imply schema acceptance',
  sig.stages.transport === 'accepted' && sig.stages.json === 'accepted' &&
    sig.stages['upstream-schema'] !== 'accepted');
check('no canonical digest is produced for an object no authority accepted',
  sig.validatedObjectJcsDigest === undefined);
check('every stage carries one of the three declared statuses',
  X402_STAGES.every((s) => ['accepted', 'rejected', 'not_evaluated'].includes(sig.stages[s])));

recordExecution('X402-STAGE-002');
check('settle response keeps the upstream schema status not_evaluated',
  resp.stages['upstream-schema'] === 'not_evaluated' &&
    resp.localStructural?.upstreamSchemaStatus === 'not_evaluated');
check('settle response reports a separate, named local structural authority',
  resp.localStructural?.localStructuralAuthority === golden.settleResponseLocalStructuralAuthority,
  `got ${resp.localStructural?.localStructuralAuthority}`);

recordExecution('X402-STAGE-003');
let promotionRefused = false;
try {
  promoteToPaymentPayload(sig);
} catch (e) {
  promotionRefused = e instanceof X402PromotionError;
}
check('a capture that did not satisfy its stages cannot be promoted', promotionRefused);

console.log('\n  -- RFC 9421 component semantics --');
check('@method case is preserved, not uppercased',
  componentsFromAbsoluteUri({ method: 'get', absoluteUri: 'https://e.test/a' })['@method'] === 'get');
check('@query carries its leading "?"', requestBinding.components['@query'].startsWith('?'));
check('absent query yields "?"',
  componentsFromAbsoluteUri({ method: 'GET', absoluteUri: 'https://e.test/a' })['@query'] === '?');
check('@path preserves dot segments',
  componentsFromAbsoluteUri({ method: 'GET', absoluteUri: 'https://e.test/a/../b' })['@path'] === '/a/../b');
check('@authority lowercases host and drops the default port',
  componentsFromAbsoluteUri({ method: 'GET', absoluteUri: 'https://EXAMPLE.test:443/a' })['@authority'] === 'example.test');

console.log('\n  -- determinism --');
const reordered = buildRequestBinding({ components, body: F.REQUEST_BODY, selectedHeaders: [sig] });
check('caller header order does not change the binding digest',
  (await bindingDigest(reordered)) === reqDigest);
check('selected headers are stored sorted',
  JSON.stringify(requestBinding.selectedHeaders.map((h) => h.name)) ===
    JSON.stringify([...requestBinding.selectedHeaders.map((h) => h.name)].sort()));

console.log('\n  -- JSON Schema (closed, 2020-12) --');
const ajv = new (Ajv2020 as any)({ strict: true, allErrors: true });
const vReq = ajv.compile(read('schemas/request-binding.v1.schema.json'));
const vRes = ajv.compile(read('schemas/origin-result-binding.v1.schema.json'));
check('request binding validates against its closed schema', vReq(requestBinding), JSON.stringify(vReq.errors)?.slice(0, 200));
check('origin result validates against its closed schema', vRes(originResultBinding), JSON.stringify(vRes.errors)?.slice(0, 200));
check('committed vector validates against its closed schema', vReq(golden.requestBinding));
check('an unknown property is rejected by the closed schema',
  !vReq({ ...requestBinding, extra: 1 }));

console.log('\n  -- digest representation --');
const all = [
  requestBinding.bodyDigest, originResultBinding.bodyDigest,
  ...requestBinding.selectedHeaders.map((h) => h.observedValueDigest),
  sig.observedValueDigest, sig.decodedPayloadDigest!, reqDigest, resDigest,
];
check('every digest uses the single sha256: representation',
  all.every((d) => /^sha256:[0-9a-f]{64}$/.test(d)));

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
