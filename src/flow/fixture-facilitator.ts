/**
 * The facilitator used by the offline path.
 *
 * It is the upstream `x402Facilitator` driven by a scheme facilitator registered here, adapted to
 * the upstream `FacilitatorClient` interface and handed to the resource server through the
 * constructor. That is the supported injection point, so the offline run exercises the real
 * resource server, the real express middleware and the real settlement sequencing; only the thing
 * that would otherwise talk to a network is local.
 *
 * WHAT THIS IS NOT. It settles nothing. It performs no signature check, no simulation and no
 * chain lookup, and the transaction reference it returns is fixed placeholder text. It stands in
 * for a facilitator so the lifecycle can be exercised without a network; it is never evidence that
 * a payment occurred, and no output derived from it may be presented as a settled payment.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import * as F from '../../fixtures/deterministic.ts';

/** How the fixture facilitator should behave, so failure branches can be exercised on purpose. */
export interface FixtureFacilitatorBehavior {
  /** Refuse verification, as a facilitator would for an unacceptable payment. */
  readonly rejectVerification?: string;
  /** Accept verification and refuse settlement, which is the branch that produces state F4. */
  readonly rejectSettlement?: string;
}

/**
 * Checks a payment against the requirements the server advertised.
 *
 * These are the terms comparisons an integration must not get wrong: the network, scheme, asset,
 * amount and recipient a payment claims have to be the ones that were advertised. Everything a
 * real facilitator does beyond that, above all deciding whether the transaction is authentic and
 * spendable, is absent here by design and is not simulated.
 */
function checkTerms(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | undefined {
  const accepted = payload.accepted;
  if (accepted.network !== requirements.network) return 'network_mismatch';
  if (accepted.scheme !== requirements.scheme) return 'scheme_mismatch';
  if (accepted.asset !== requirements.asset) return 'asset_mismatch';
  if (accepted.amount !== requirements.amount) return 'amount_mismatch';
  if (accepted.payTo !== requirements.payTo) return 'recipient_mismatch';
  const transaction = payload.payload['transaction'];
  if (typeof transaction !== 'string' || transaction.length === 0) return 'missing_transaction';
  return undefined;
}

/**
 * A scheme facilitator for the exact scheme on Solana networks that produces fixed results.
 *
 * The class shape, including the CAIP family and the fee-payer advertisement, is the upstream
 * interface; only the bodies are local.
 */
class FixtureExactSvmFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = 'exact';
  readonly caipFamily = 'solana:*';

  constructor(private readonly behavior: FixtureFacilitatorBehavior) {}

  getExtra(): Record<string, unknown> {
    return { feePayer: F.FEE_PAYER };
  }

  getSigners(): string[] {
    return [F.FEE_PAYER];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (this.behavior.rejectVerification !== undefined) {
      return { isValid: false, invalidReason: this.behavior.rejectVerification };
    }
    const problem = checkTerms(payload, requirements);
    if (problem !== undefined) return { isValid: false, invalidReason: problem };
    return { isValid: true, payer: F.PAYER };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (this.behavior.rejectSettlement !== undefined) {
      return {
        success: false,
        errorReason: this.behavior.rejectSettlement,
        transaction: '',
        network: requirements.network,
        payer: F.PAYER,
      };
    }
    const problem = checkTerms(payload, requirements);
    if (problem !== undefined) {
      return {
        success: false,
        errorReason: problem,
        transaction: '',
        network: requirements.network,
        payer: F.PAYER,
      };
    }
    return {
      success: true,
      transaction: F.TX_SIGNATURE,
      network: requirements.network,
      payer: F.PAYER,
    };
  }
}

/**
 * Build the in-process facilitator client.
 *
 * `getSupported` is what the resource server calls during initialization to learn which
 * scheme and network combinations exist and which fee payer signs. Answering it locally is the
 * whole reason the offline run needs no socket.
 */
export function createFixtureFacilitatorClient(
  network: Network,
  behavior: FixtureFacilitatorBehavior = {},
): FacilitatorClient {
  const facilitator = new x402Facilitator().register(
    network,
    new FixtureExactSvmFacilitator(behavior),
  );
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async (): Promise<SupportedResponse> =>
      facilitator.getSupported() as SupportedResponse,
  };
}
