/**
 * The network-specific observation seam.
 *
 * One function turns the artifacts a settlement produced into a chain observation. Everything
 * upstream of it is the generic evidence path: request binding, result binding, record issuance
 * and verification know nothing about Solana. Everything network-specific is here, which is what
 * makes a second network an additional observer rather than a second evidence model.
 *
 * TWO OBSERVERS, KEPT APART. The facilitator is a party to the payment, so its account of the
 * settlement is recorded as its account. A node, when one is asked, is a separate observer, and
 * what it reported is recorded separately again rather than folded into the first. Neither replaces
 * the other and neither is promoted to a fact about the network.
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
import type { RpcTransactionObservationV1 } from './observe-transaction.ts';

export const PROFILE_CHAIN_OBSERVATION =
  'org.peacprotocol.examples.payment-evidence/solana-chain-observation/1';

/** Where the observation came from, so a reader knows who was asked. */
export interface ObservationSource {
  /** `facilitator` when a settlement service reported it; `rpc` when a node was queried. */
  readonly kind: 'facilitator' | 'rpc' | 'in_process_fixture';
  /**
   * Endpoint origin, or the component that answered.
   *
   * Never a path, query, fragment or credential: an endpoint is named by its origin alone, so a
   * token carried in any other part of a configured URL cannot reach this document.
   */
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
  /** Who reported the settlement itself: the facilitator, or the in-process fixture. */
  readonly observationSource: ObservationSource;
  /**
   * A node's separate account of the same transaction, when one was asked.
   *
   * Structurally apart from `observationSource` and never merged into it. Slot and commitment are
   * things only a node can report, so they exist here and nowhere else: a reader can always tell
   * which observer supplied which fact. Absent whenever no node was asked, which is every offline
   * run and any live run that settled nothing.
   */
  readonly rpcObservation?: RpcTransactionObservationV1;
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
  /** A node's account of the settlement transaction, when one was asked. */
  readonly rpcObservation?: RpcTransactionObservationV1;
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
    observationSource: artifacts.observationSource,
    // Carried only alongside a settlement that succeeded and reported a transaction, so a node's
    // account can never appear beside a payment this run did not observe settling.
    ...(settled && settleResponse?.transaction && artifacts.rpcObservation !== undefined
      ? { rpcObservation: artifacts.rpcObservation }
      : {}),
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
