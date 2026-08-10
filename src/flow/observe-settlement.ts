/**
 * The network-specific observation seam.
 *
 * One function turns the artifacts a settlement produced into a chain observation. Everything
 * upstream of it is the generic evidence path: request binding, result binding, record issuance
 * and verification know nothing about Solana. Everything network-specific is here, which is what
 * makes a second network an additional observer rather than a second evidence model.
 *
 * WHAT A CHAIN OBSERVATION SAYS. The service records the transaction it was given and the
 * conditions under which it treated the payment as settled. It does not assert that funds moved,
 * that a transaction is final, or that any chain agrees: those are properties of the network, and
 * anyone can check them against the transaction reference recorded here. Reading this document as
 * proof of payment is a misreading, and the field names avoid inviting it.
 */
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { computeJsonDocumentDigestJcs } from '@peac/protocol';
import type { JsonValue } from '@peac/kernel';
import { coerceDigest, type Sha256Digest } from '../digest.ts';
import { paymentWasSettled, type LifecycleObservation, type TerminalState } from './lifecycle.ts';

export const PROFILE_CHAIN_OBSERVATION =
  'org.peacprotocol.examples.payment-evidence/solana-chain-observation/1';

/** Where the observation came from, so a reader knows who was asked. */
export interface ObservationSource {
  /** `facilitator` when a settlement service reported it; `rpc` when a node was queried. */
  readonly kind: 'facilitator' | 'rpc' | 'in_process_fixture';
  /** Endpoint or component that answered. Never a credential. */
  readonly reference: string;
}

/** How settlement ended, kept separate from the transaction facts it may or may not carry. */
export type SettlementOutcome = 'succeeded' | 'refused' | 'not_reached';

export interface SolanaChainObservationV1 {
  readonly profile: typeof PROFILE_CHAIN_OBSERVATION;
  /** CAIP-2 identifier of the network the payment named. */
  readonly network: string;
  readonly scheme: string;
  /** Token mint the payment was denominated in. */
  readonly asset: string;
  /** Amount in the asset's smallest unit, as a string, so no precision is lost. */
  readonly amountBaseUnits: string;
  readonly assetDecimals: number;
  readonly recipient: string;
  readonly payer?: string;
  /** Present only when settlement succeeded and reported one. */
  readonly transactionSignature?: string;
  /** Blockhash the challenge embedded, when the scheme supplied one. */
  readonly recentBlockhash?: string;
  /** Slot at which the transaction was observed, when a node was asked. */
  readonly observedSlot?: number;
  /** Commitment level the observation was made at, when a node was asked. */
  readonly commitment?: string;
  readonly observationSource: ObservationSource;
  /** Digest of the settlement response exactly as observed. */
  readonly settlementResponseDigest?: Sha256Digest;
  /** Digest of the origin result this payment was for, linking payment to work. */
  readonly serviceResultDigest?: Sha256Digest;
  readonly observedAtUnixSeconds: number;
  /** Where the run ended, so a reader can tell which artifacts should exist. */
  readonly terminalState: TerminalState;
  readonly settlementOutcome: SettlementOutcome;
  /** Reason settlement refused, when it did. */
  readonly settlementFailureReason?: string;
}

/** The native artifacts one run produced, before anything network-specific is read out of them. */
export interface NativeSettlementArtifacts {
  readonly requirements: PaymentRequirements;
  readonly paymentPayload: PaymentPayload;
  /** Present when settlement ran, whether it succeeded or refused. */
  readonly settleResponse?: SettleResponse;
  /** Digest of the observed settlement field value, when one was emitted. */
  readonly settlementResponseDigest?: Sha256Digest;
  /** Digest of the origin result the payment was for, when the handler produced one. */
  readonly serviceResultDigest?: Sha256Digest;
  readonly lifecycle: LifecycleObservation;
  readonly observationSource: ObservationSource;
  readonly observedAtUnixSeconds: number;
  readonly assetDecimals: number;
  /** Slot and commitment, when a node was queried. Absent offline and absent when unasked. */
  readonly observedSlot?: number;
  readonly commitment?: string;
}

/**
 * Read a chain observation out of the native artifacts.
 *
 * The transaction reference is recorded only when settlement actually succeeded. A reference
 * carried alongside a failure would read as a payment that happened, so a refused settlement
 * records the refusal and no transaction facts at all.
 */
export function observeSettlement(
  artifacts: NativeSettlementArtifacts,
): SolanaChainObservationV1 {
  const { requirements, lifecycle, settleResponse } = artifacts;
  const settled = paymentWasSettled(lifecycle.terminalState) && settleResponse?.success === true;
  const outcome: SettlementOutcome =
    settled ? 'succeeded' : settleResponse !== undefined || lifecycle.terminalState === 'settlement_failed'
      ? 'refused'
      : 'not_reached';

  const recentBlockhash = requirements.extra['recentBlockhash'];

  return {
    profile: PROFILE_CHAIN_OBSERVATION,
    network: requirements.network,
    scheme: requirements.scheme,
    asset: requirements.asset,
    amountBaseUnits: requirements.amount,
    assetDecimals: artifacts.assetDecimals,
    recipient: requirements.payTo,
    ...(lifecycle.payer !== undefined ? { payer: lifecycle.payer } : {}),
    ...(settled && settleResponse?.transaction
      ? { transactionSignature: settleResponse.transaction }
      : {}),
    ...(typeof recentBlockhash === 'string' ? { recentBlockhash } : {}),
    ...(settled && artifacts.observedSlot !== undefined
      ? { observedSlot: artifacts.observedSlot }
      : {}),
    ...(settled && artifacts.commitment !== undefined ? { commitment: artifacts.commitment } : {}),
    observationSource: artifacts.observationSource,
    ...(artifacts.settlementResponseDigest !== undefined
      ? { settlementResponseDigest: artifacts.settlementResponseDigest }
      : {}),
    ...(artifacts.serviceResultDigest !== undefined
      ? { serviceResultDigest: artifacts.serviceResultDigest }
      : {}),
    observedAtUnixSeconds: artifacts.observedAtUnixSeconds,
    terminalState: lifecycle.terminalState,
    settlementOutcome: outcome,
    ...(outcome === 'refused' && lifecycle.failureReason !== undefined
      ? { settlementFailureReason: lifecycle.failureReason }
      : {}),
  };
}

/** Digest of a chain observation, over its canonical JSON bytes. */
export async function chainObservationDigest(
  observation: SolanaChainObservationV1,
): Promise<Sha256Digest> {
  return coerceDigest(await computeJsonDocumentDigestJcs(observation as unknown as JsonValue));
}
