/**
 * The client-side scheme implementation used by the offline path.
 *
 * On the live devnet path the client registers the upstream SVM exact scheme, which builds and
 * signs a real Solana transaction with a real keypair. Offline there is no keypair and no chain to
 * build against, so this stands in for the wallet: it returns the fixed synthetic transaction the
 * interoperability fixtures already use, through the upstream `SchemeNetworkClient` interface, so the
 * payload still travels the real client, encoder, middleware and resource-server path.
 *
 * The substitution is confined to one interface with one method. Everything the reference flow
 * claims about the lifecycle is produced by upstream code on both paths; only the origin of the
 * transaction bytes differs, and offline those bytes are placeholder text that decodes to no
 * Solana transaction at all.
 */
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';
import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
import * as F from '../../fixtures/deterministic.ts';

/**
 * A wallet stand-in for the exact scheme.
 *
 * The payment identifier is appended with the upstream extension API rather than written by hand,
 * so the declaration the server advertised decides whether it appears and the structure is
 * whatever x402 defines rather than whatever this example assumed.
 */
export class FixtureExactWallet implements SchemeNetworkClient {
  readonly scheme = 'exact';

  /** Fixed so a repeated offline run produces identical bytes. */
  private readonly paymentId: string;

  constructor(paymentId: string = F.PAYMENT_ID) {
    this.paymentId = paymentId;
  }

  async createPaymentPayload(
    x402Version: number,
    _paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    // The upstream helper appends only when the server declared the extension, and it writes into
    // the declaration object it is given. A copy is passed so the server's own declaration is not
    // mutated by a client running in the same process.
    const declared = structuredClone(context?.extensions ?? {}) as Record<string, unknown>;
    const extensions = appendPaymentIdentifierToExtensions(declared, this.paymentId);
    return {
      x402Version,
      payload: { transaction: F.EXACT_SVM_TRANSACTION },
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  }
}
