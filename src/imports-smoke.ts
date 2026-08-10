/**
 * Dependency import smoke test.
 *
 * Compiles and executes the exact x402 subpaths this profile depends on, and asserts the exact
 * symbols it uses. Checking only that a module loads would pass after an upstream rename removed
 * every symbol actually relied upon.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FacilitatorClient,
  HTTPAdapter,
  HTTPProcessResult,
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyResultContext,
} from '@x402/core/server';
import { X402_PINNED_VERSION, SETTLE_RESPONSE_LOCAL_AUTHORITY } from './x402-header.ts';

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read an installed package's version from disk.
 *
 * NOT via require.resolve('<pkg>/package.json'): the x402 packages define an "exports" map that
 * deliberately does not expose ./package.json, so resolution throws. Reading node_modules directly
 * reports what is actually installed, which is the thing under test.
 */
function installedVersion(pkg: string): string {
  try {
    const pj = JSON.parse(readFileSync(join(APP_ROOT, 'node_modules', pkg, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pj.version ?? 'missing-version-field';
  } catch (e) {
    return `ERROR ${(e as Error).message.split('\n')[0]}`;
  }
}

/**
 * Required subpaths AND the exact symbols this profile depends on. Asserting only that "some export
 * exists" would pass even after an upstream rename removed everything actually used.
 */
const REQUIRED_EXPORTS: Record<string, readonly string[]> = {
  '@x402/core': ['x402Version'],
  '@x402/core/http': [
    'decodePaymentRequiredHeader',
    'decodePaymentSignatureHeader',
    'decodePaymentResponseHeader',
    'encodePaymentRequiredHeader',
    'encodePaymentSignatureHeader',
    'encodePaymentResponseHeader',
  ],
  // The runtime validators this profile treats as the upstream schema authority.
  '@x402/core/schemas': [
    'PaymentRequiredV2Schema',
    'PaymentPayloadV2Schema',
    'isPaymentRequiredV2',
    'isPaymentPayloadV2',
    'validatePaymentRequired',
    'validatePaymentPayload',
  ],
  '@x402/svm': [
    'SOLANA_DEVNET_CAIP2',
    'USDC_DEVNET_ADDRESS',
    'SettlementCache',
    'assertFeePayerIsolated',
    // Used only by the live devnet path, to build a signer from a devnet keypair.
    'toClientSvmSigner',
  ],
  '@x402/svm/exact/server': ['ExactSvmScheme', 'registerExactSvmScheme'],
  '@x402/svm/exact/client': ['ExactSvmScheme', 'registerExactSvmScheme'],
  '@x402/svm/exact/facilitator': ['ExactSvmScheme', 'registerExactSvmScheme'],
  // The resource-server surface the reference flow builds on: the server itself, its HTTP
  // wrapper, and the facilitator client the flow injects rather than dialling out to.
  '@x402/core/server': ['x402ResourceServer', 'x402HTTPResourceServer', 'HTTPFacilitatorClient'],
  // The in-process facilitator used by the offline path is the upstream facilitator, driven by a
  // locally registered scheme facilitator; it is not a reimplementation of one.
  '@x402/core/facilitator': ['x402Facilitator'],
  '@x402/core/client': ['x402Client', 'x402HTTPClient'],
  '@x402/express': [
    'paymentMiddleware',
    'paymentMiddlewareFromConfig',
    'paymentMiddlewareFromHTTPServer',
    'x402ResourceServer',
    'x402HTTPResourceServer',
    'ExpressAdapter',
  ],
  '@x402/extensions/offer-receipt': ['OFFER_RECEIPT', 'createOfferReceiptExtension', 'canonicalize'],
  '@x402/extensions/payment-identifier': [
    'PAYMENT_IDENTIFIER',
    'declarePaymentIdentifierExtension',
    'appendPaymentIdentifierToExtensions',
    'extractAndValidatePaymentIdentifier',
    'validatePaymentIdentifier',
    'generatePaymentId',
  ],
  '@x402/extensions/builder-code': ['BUILDER_CODE', 'declareBuilderCodeExtension'],
};
const REQUIRED_SUBPATHS = Object.keys(REQUIRED_EXPORTS);

const PINNED = ['@x402/core', '@x402/express', '@x402/svm', '@x402/extensions'] as const;
const EXPECTED_VERSION = X402_PINNED_VERSION;

/**
 * Non-x402 packages the reference flow depends on, pinned individually.
 *
 * `express` is a peer dependency of `@x402/express`: the middleware intercepts the response
 * methods of this exact framework, so its major version is part of the surface under test rather
 * than an implementation detail. `@solana/kit` is a peer dependency of `@x402/svm` and is used
 * only on the live devnet path; it is pinned to the version the x402 package resolves so both
 * resolve to a single instance and signer types stay identical.
 */
const PINNED_PEERS: Record<string, string> = {
  express: '5.2.1',
  '@solana/kit': '5.5.1',
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

// 1. installed versions must equal the exact pins
for (const p of PINNED) {
  const v = installedVersion(p);
  check(`${p} installed at ${EXPECTED_VERSION}`, v === EXPECTED_VERSION, `got ${v}`);
}

// 1b. peer packages that are part of the surface, pinned individually
for (const [pkg, expected] of Object.entries(PINNED_PEERS)) {
  const v = installedVersion(pkg);
  check(`${pkg} installed at ${expected}`, v === expected, `got ${v}`);
}

// 2. every required subpath must resolve, load, AND expose the exact symbols relied upon
for (const sub of REQUIRED_SUBPATHS) {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(sub)) as Record<string, unknown>;
  } catch (e) {
    check(`import ${sub}`, false, (e as Error).message.split('\n')[0]);
    continue;
  }
  const missing = REQUIRED_EXPORTS[sub]!.filter((sym) => !(sym in mod));
  check(`${sub} exports ${REQUIRED_EXPORTS[sub]!.join(', ')}`, missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');
}

/**
 * 2b. Lifecycle observation depends on registration points, not just on the classes existing.
 *
 * The reference flow observes the payment lifecycle through the upstream hooks rather than by
 * wrapping or re-implementing the middleware. If a registration method disappears, the flow would
 * silently observe less while every import still resolved, so the methods are asserted by name.
 */
const serverModule = (await import('@x402/core/server')) as unknown as {
  x402ResourceServer: new (...args: never[]) => unknown;
  x402HTTPResourceServer: new (...args: never[]) => unknown;
};
const RESOURCE_SERVER_HOOKS = [
  'onBeforeVerify',
  'onAfterVerify',
  'onVerifyFailure',
  'onBeforeSettle',
  'onAfterSettle',
  'onSettleFailure',
  'onVerifiedPaymentCanceled',
] as const;
const HTTP_SERVER_METHODS = [
  'onProtectedRequest',
  'processHTTPRequest',
  'processSettlement',
  'requiresPayment',
  'initialize',
] as const;
const missingHooks = RESOURCE_SERVER_HOOKS.filter(
  (m) => typeof (serverModule.x402ResourceServer.prototype as Record<string, unknown>)[m] !== 'function',
);
check(`x402ResourceServer exposes ${RESOURCE_SERVER_HOOKS.join(', ')}`, missingHooks.length === 0,
  missingHooks.length ? `missing: ${missingHooks.join(', ')}` : '');
const missingHttp = HTTP_SERVER_METHODS.filter(
  (m) => typeof (serverModule.x402HTTPResourceServer.prototype as Record<string, unknown>)[m] !== 'function',
);
check(`x402HTTPResourceServer exposes ${HTTP_SERVER_METHODS.join(', ')}`, missingHttp.length === 0,
  missingHttp.length ? `missing: ${missingHttp.join(', ')}` : '');

// 2c. express is loaded as an application factory, which is how the flow uses it.
const expressModule = (await import('express')) as unknown as { default?: unknown };
const expressFactory = expressModule.default ?? expressModule;
check('express default export is callable', typeof expressFactory === 'function');

/**
 * 2d. Compile-time surface pins.
 *
 * The facilitator client interface and the lifecycle hook contexts are types: they have no runtime
 * representation to assert. Naming their members in code that must typecheck pins them anyway, so
 * an upstream reshape fails the typecheck gate rather than passing here and surfacing later as a
 * silently absent observation.
 */
const TYPE_PINS = {
  'FacilitatorClient.verify, .settle, .getSupported': (c: FacilitatorClient) =>
    [c.verify, c.settle, c.getSupported],
  'HTTPAdapter.getHeader, .getMethod, .getPath, .getUrl': (a: HTTPAdapter) =>
    [a.getHeader, a.getMethod, a.getPath, a.getUrl],
  'HTTPProcessResult.type': (r: HTTPProcessResult) => [r.type],
  'VerifyResultContext.paymentPayload, .requirements, .result': (c: VerifyResultContext) =>
    [c.paymentPayload, c.requirements, c.result],
  'SettleContext.paymentPayload, .requirements': (c: SettleContext) =>
    [c.paymentPayload, c.requirements],
  'SettleResultContext.result': (c: SettleResultContext) => [c.result],
  'SettleFailureContext.error': (c: SettleFailureContext) => [c.error],
  'VerifiedPaymentCanceledContext.reason, .responseStatus': (c: VerifiedPaymentCanceledContext) =>
    [c.reason, c.responseStatus],
} as const;
check(
  'upstream type surface pinned at compile time',
  Object.values(TYPE_PINS).every((accessor) => typeof accessor === 'function'),
);

// 3. the settle-response authority string must name the version actually installed, so a reported
//    structural verdict is always attributable to a known upstream shape
check(
  'settle response structural authority names the pinned version',
  SETTLE_RESPONSE_LOCAL_AUTHORITY === `@x402/core@${X402_PINNED_VERSION}-type-shape`,
  `got ${SETTLE_RESPONSE_LOCAL_AUTHORITY}`,
);

// 4. the reason this profile reports settle responses under a LOCAL structural authority is that
//    upstream ships no runtime validator for them. That is a measured claim, so it is measured:
//    every export path of the pinned packages is searched for one. If upstream ever adds one,
//    this fails and the local check must be replaced by the upstream authority.
const ALL_EXPORT_PATHS = [
  '@x402/core', '@x402/core/client', '@x402/core/facilitator', '@x402/core/http',
  '@x402/core/server', '@x402/core/types', '@x402/core/types/v1', '@x402/core/utils',
  '@x402/core/schemas',
  '@x402/svm', '@x402/svm/v1', '@x402/svm/exact/client', '@x402/svm/exact/server',
  '@x402/svm/exact/facilitator', '@x402/svm/exact/v1/client', '@x402/svm/exact/v1/facilitator',
  '@x402/extensions', '@x402/extensions/bazaar', '@x402/extensions/sign-in-with-x',
  '@x402/extensions/offer-receipt', '@x402/extensions/payment-identifier',
  '@x402/extensions/builder-code',
  '@x402/express',
] as const;
// A validator would be named like the predicates and schemas that do exist for the other types.
const VALIDATOR_SHAPE = /^(is|validate|parse)Settle|^Settle.*Schema$/;
const settleValidators: string[] = [];
for (const sub of ALL_EXPORT_PATHS) {
  try {
    const mod = (await import(sub)) as Record<string, unknown>;
    for (const key of Object.keys(mod)) if (VALIDATOR_SHAPE.test(key)) settleValidators.push(`${sub}:${key}`);
  } catch {
    // Unresolvable subpaths are reported by the required-subpath checks above.
  }
}
check('upstream still ships no runtime settle-response validator', settleValidators.length === 0,
  settleValidators.join(', '));

// 5. report what the installed packages actually export, so a future rename is visible in the diff
console.log('\n  installed export surface:');
for (const sub of REQUIRED_SUBPATHS) {
  try {
    const mod = (await import(sub)) as Record<string, unknown>;
    const keys = Object.keys(mod).filter((k) => k !== 'default').sort();
    console.log(`    ${sub}`);
    console.log(`      ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ` ... (+${keys.length - 12})` : ''}`);
  } catch {
    console.log(`    ${sub}  <unresolvable>`);
  }
}

console.log('\n  type surface pinned at compile time:');
for (const member of Object.keys(TYPE_PINS)) console.log(`    ${member}`);

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
