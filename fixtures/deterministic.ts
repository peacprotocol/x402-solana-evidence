import { encodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import {
  PAYMENT_IDENTIFIER as PAYMENT_IDENTIFIER_KEY,
  declarePaymentIdentifierExtension,
  appendPaymentIdentifierToExtensions,
} from '@x402/extensions/payment-identifier';

/**
 * Deterministic fixture data.
 *
 * Synthetic x402-shaped artifacts with fixed values, so every run produces identical digests without
 * a network, chain, facilitator or key.
 *
 * SYNTHETIC ONLY: no value here is a real wallet, key, transaction or payer identity.
 */

/** Fixed instant so binding digests are reproducible across runs. */
export const FIXED_NOW_UNIX_SECONDS = 1_785_000_000;

export const RESOURCE_URL = 'https://api.example.test/v1/forecast?region=alpha&units=metric';

/** CAIP-2 for Solana devnet. Passed through unchanged, never re-mapped. */
export const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SCHEME = 'exact';
export const ASSET_MINT = 'SyntheticMint1111111111111111111111111111111';
export const AMOUNT_BASE_UNITS = '250000';
export const TOKEN_DECIMALS = 6;
export const PAY_TO = 'SyntheticRecipient11111111111111111111111111';
export const PAYER = 'SyntheticPayer111111111111111111111111111111';
/** Fixed identifier matching the upstream grammar: at least 16 chars of [a-zA-Z0-9_-]. */
export const PAYMENT_ID = 'pay_0000000000000000000000000000f1x2';
export const TX_SIGNATURE = 'SyntheticTxSig1111111111111111111111111111111111111111111111111111111111111111111111';
export const OBSERVED_SLOT = 300_000_000;
export const COMMITMENT_LEVEL = 'confirmed';
export const RECENT_BLOCKHASH = 'SyntheticBlockhash111111111111111111111111111';

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

/** Settlement response as the origin observed it. */
export const SETTLEMENT_RESPONSE = {
  success: true,
  network: NETWORK,
  transactionSignature: TX_SIGNATURE,
  slot: OBSERVED_SLOT,
  commitment: COMMITMENT_LEVEL,
  recentBlockhash: RECENT_BLOCKHASH,
  source: 'synthetic-facilitator',
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
 * Headers are produced by the installed x402 encoders, so fixtures match the real transport
 * (standard Base64 JSON) rather than a locally assumed encoding.
 */

/**
 * Headers as the ORIGIN APPLICATION observes them after HTTP parsing.
 * Lowercased field names, as an HTTP/2 origin would see them.
 */
/**
 * A PaymentPayload as x402 v2 defines it. The payment identifier travels inside `extensions`,
 * which is where the resource server extracts it from; it is not a separate HTTP header.
 */
export const PAYMENT_PAYLOAD = {
  x402Version: 2,
  scheme: SCHEME,
  network: NETWORK,
  payload: {
    payer: PAYER,
    amount: AMOUNT_BASE_UNITS,
    asset: ASSET_MINT,
    payTo: PAY_TO,
  },
  // Built with the upstream extension APIs so the shape is whatever x402 actually defines
  // ({ info: { required, id }, schema }), not a locally guessed structure.
  extensions: appendPaymentIdentifierToExtensions(
    { [PAYMENT_IDENTIFIER_KEY]: declarePaymentIdentifierExtension(true as never) } as never,
    PAYMENT_ID as never,
  ),
} as const;

export const OBSERVED_REQUEST_HEADERS = {
  'payment-signature': encodePaymentSignatureHeader(PAYMENT_PAYLOAD as never),
} as const;

export const OBSERVED_RESPONSE_HEADERS = {
  'payment-response': encodePaymentResponseHeader(SETTLEMENT_RESPONSE as never),
} as const;

export const HTTP_VERSION = '2.0';
