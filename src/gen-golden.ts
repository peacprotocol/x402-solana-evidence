/**
 * Regenerate fixtures/golden-v1.json.
 *
 * Run only when the binding structures intentionally change, and review the diff. Vectors that
 * regenerate silently are not conformance vectors; the tests compare against the committed file.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRequestBinding, buildOriginResultBinding, bindingDigest } from './binding.ts';
import { componentsFromAbsoluteUri } from './components.ts';
import { captureObservedX402Artifact, SETTLE_RESPONSE_LOCAL_AUTHORITY } from './x402-header.ts';
import { canonicalizeIndependent } from './jcs-independent.ts';
import { digestBytes } from './digest.ts';
import * as F from '../fixtures/deterministic.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const req = await captureObservedX402Artifact({
  name: 'Payment-Required',
  observedValue: F.OBSERVED_CHALLENGE_HEADERS['payment-required'],
  capturePoint: 'client_response_after_http_parsing',
  httpVersion: F.HTTP_VERSION,
});
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
const requestBinding = buildRequestBinding({
  components,
  body: F.REQUEST_BODY,
  selectedHeaders: [sig],
});
const originResultBinding = buildOriginResultBinding({
  status: 200,
  contentType: 'application/json',
  body: F.ORIGIN_RESULT_BODY,
});

const golden = {
  _comment:
    'Conformance vectors with hard-coded expected bytes and digests. Regenerate via pnpm gen:golden and review the diff.',
  profileRequestBinding: requestBinding.profile,
  profileOriginResultBinding: originResultBinding.profile,
  requestBinding,
  requestBindingJcsUtf8Hex: Buffer.from(canonicalizeIndependent(requestBinding), 'utf8').toString('hex'),
  requestBindingDigest: await bindingDigest(requestBinding),
  originResultBinding,
  originResultBindingJcsUtf8Hex: Buffer.from(canonicalizeIndependent(originResultBinding), 'utf8').toString('hex'),
  originResultBindingDigest: await bindingDigest(originResultBinding),
  originResultBodyDigest: digestBytes(F.ORIGIN_RESULT_BODY),
  requestBodyDigest: digestBytes(F.REQUEST_BODY),
  settleResponseLocalStructuralAuthority: SETTLE_RESPONSE_LOCAL_AUTHORITY,
  observedHeaders: {
    'payment-required': req,
    'payment-signature': sig,
    'payment-response': resp,
  },
};

const out = join(HERE, '..', 'fixtures', 'golden-v1.json');
writeFileSync(out, JSON.stringify(golden, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`  requestBindingDigest      ${golden.requestBindingDigest}`);
console.log(`  originResultBindingDigest ${golden.originResultBindingDigest}`);
