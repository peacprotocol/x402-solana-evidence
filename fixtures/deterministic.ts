/**
 * Deterministic fixture data.
 *
 * Every artifact here is built against the upstream x402 v2 types and accepted by the upstream
 * runtime validators, so the conformance vectors describe real x402 objects rather than shapes
 * invented locally. Nothing is cast: if an upstream type changes, these fixtures stop compiling,
 * which is the point.
 *
 * SYNTHETIC ONLY. Network and asset identifiers are the public Solana devnet constants exported by
 * the upstream package. Every payer, recipient, fee payer, transaction and signature value is
 * fabricated placeholder text: no wallet, key, real transaction or payer identity appears here, and
 * the encoded "transaction" is not a decodable Solana transaction.
 */
import {
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  SettleResponse,
  ResourceInfo,
} from '@x402/core/types';
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from '@x402/svm';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  appendPaymentIdentifierToExtensions,
} from '@x402/extensions/payment-identifier';

/** Fixed instant so binding digests are reproducible across runs. */
export const FIXED_NOW_UNIX_SECONDS = 1_785_000_000;

/**
 * The fixed SYNTHETIC resource identity the deterministic fixture binds.
 *
 * It corresponds to no socket, no listener and no deployment. It exists so the fixture reproduces
 * byte for byte against an ephemeral port, and it is never an observation: a live run binds the
 * request components its origin actually served instead.
 */
export const RESOURCE_URL = 'https://api.example.test/v1/forecast?region=alpha&units=metric';

/** CAIP-2 for Solana devnet, taken from the upstream constant rather than transcribed. */
export const NETWORK = SOLANA_DEVNET_CAIP2;
export const SCHEME = 'exact';
/** The public devnet USDC mint, from the upstream constant. */
export const ASSET_MINT = USDC_DEVNET_ADDRESS;
export const AMOUNT_BASE_UNITS = '250000';
export const TOKEN_DECIMALS = 6;
export const MAX_TIMEOUT_SECONDS = 60;

// Placeholder account identifiers. They follow the base58 alphabet so they look like what they
// stand for, and they correspond to no account on any network.
export const PAY_TO = 'SyntheticRecipient11111111111111111111111111';
export const PAYER = 'SyntheticPayer111111111111111111111111111111';
export const FEE_PAYER = 'SyntheticFeePayer11111111111111111111111111';
export const RECENT_BLOCKHASH = 'SyntheticBlockhash111111111111111111111111111';
export const TX_SIGNATURE =
  'SyntheticTxSig1111111111111111111111111111111111111111111111111111111111111111111111';
export const OBSERVED_SLOT = 300_000_000;
export const COMMITMENT_LEVEL = 'confirmed';

/** Fixed identifier matching the upstream grammar: 16 to 128 chars of [A-Za-z0-9_-]. */
export const PAYMENT_ID = 'pay_0000000000000000000000000000f1x2';

/**
 * The scheme-specific payload member for exact on SVM, whose shape upstream defines as a single
 * base64 wire transaction. The content is fixed placeholder text so digests are reproducible.
 */
export const EXACT_SVM_TRANSACTION = Buffer.from(
  'synthetic-placeholder-not-a-solana-transaction',
  'utf8',
).toString('base64');

export const RESOURCE_INFO: ResourceInfo = {
  url: RESOURCE_URL,
  description: 'Synthetic forecast resource used by the deterministic fixtures',
  mimeType: 'application/json',
};

export const PAYMENT_REQUIREMENTS: PaymentRequirements = {
  scheme: SCHEME,
  network: NETWORK,
  asset: ASSET_MINT,
  amount: AMOUNT_BASE_UNITS,
  payTo: PAY_TO,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  // The facilitator advertises its fee payer here; the value is synthetic.
  extra: { feePayer: FEE_PAYER, recentBlockhash: RECENT_BLOCKHASH },
};

/** Extensions as a resource server would declare them, built with the upstream declaration API. */
export const DECLARED_EXTENSIONS: Record<string, unknown> = {
  [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
};

export const PAYMENT_REQUIRED: PaymentRequired = {
  x402Version: 2,
  resource: RESOURCE_INFO,
  accepts: [PAYMENT_REQUIREMENTS],
  extensions: DECLARED_EXTENSIONS,
};

/**
 * Extensions as a client would send them: the server's declaration with the client's identifier
 * appended by the upstream client API, so the structure is whatever x402 actually defines.
 */
export const PAYLOAD_EXTENSIONS: Record<string, unknown> = appendPaymentIdentifierToExtensions(
  { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
  PAYMENT_ID,
);

export const PAYMENT_PAYLOAD: PaymentPayload = {
  x402Version: 2,
  resource: RESOURCE_INFO,
  accepted: PAYMENT_REQUIREMENTS,
  payload: { transaction: EXACT_SVM_TRANSACTION },
  extensions: PAYLOAD_EXTENSIONS,
};

/** Settlement response as the origin observed it, in the shape upstream declares for it. */
export const SETTLEMENT_RESPONSE: SettleResponse = {
  success: true,
  transaction: TX_SIGNATURE,
  network: NETWORK,
  payer: PAYER,
};

/** The x402 signed offer, shaped like the offer-receipt extension's offer object. */
export const SIGNED_OFFER = {
  resourceUrl: RESOURCE_URL,
  network: NETWORK,
  scheme: SCHEME,
  asset: ASSET_MINT,
  amount: AMOUNT_BASE_UNITS,
  decimals: TOKEN_DECIMALS,
  payTo: PAY_TO,
  validUntilUnixSeconds: FIXED_NOW_UNIX_SECONDS + 300,
  paymentId: PAYMENT_ID,
} as const;

/** The x402 signed receipt: resource, payer, network, issuance time, optional tx hash. */
export const SIGNED_RECEIPT = {
  resourceUrl: RESOURCE_URL,
  payer: PAYER,
  network: NETWORK,
  issuedAtUnixSeconds: FIXED_NOW_UNIX_SECONDS + 12,
  transactionSignature: TX_SIGNATURE,
  paymentId: PAYMENT_ID,
} as const;

/** The request body the customer sent (empty for a GET). */
export const REQUEST_BODY = new Uint8Array(0);

/** The bytes the origin application handed to its response API. */
export const ORIGIN_RESULT_BODY_TEXT = JSON.stringify({
  region: 'alpha',
  units: 'metric',
  generatedAtUnixSeconds: FIXED_NOW_UNIX_SECONDS + 13,
  forecast: [
    { hour: 0, tempC: 17.4 },
    { hour: 1, tempC: 17.1 },
    { hour: 2, tempC: 16.8 },
  ],
});

/** Bodies are bound as bytes, never as strings with an implied encoding. */
export const ORIGIN_RESULT_BODY = new TextEncoder().encode(ORIGIN_RESULT_BODY_TEXT);

/**
 * Field values are produced by the installed x402 encoders, so the fixtures carry the real
 * transport encoding rather than one assumed locally.
 *
 * Names are lowercased, as an origin application observes them after HTTP parsing.
 */
export const OBSERVED_CHALLENGE_HEADERS = {
  'payment-required': encodePaymentRequiredHeader(PAYMENT_REQUIRED),
} as const;

export const OBSERVED_REQUEST_HEADERS = {
  'payment-signature': encodePaymentSignatureHeader(PAYMENT_PAYLOAD),
} as const;

export const OBSERVED_RESPONSE_HEADERS = {
  'payment-response': encodePaymentResponseHeader(SETTLEMENT_RESPONSE),
} as const;

export const HTTP_VERSION = '2.0';
