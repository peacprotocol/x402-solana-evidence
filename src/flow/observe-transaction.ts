/**
 * A second observer of the same settlement: a Solana node, asked directly.
 *
 * WHY A SECOND ONE. Everything else the evidence records about settlement comes from the
 * facilitator, which is a party to the payment. Asking a node as well does not make the payment
 * more true; it records that a different observer was asked and what it said, so a reader can see
 * two accounts instead of one and check either against the network themselves.
 *
 * WHAT IT IS NOT. This reports what an endpoint said at a moment. It is not a finality claim, not a
 * consensus claim and not proof that funds moved. The recorded sentence says who was asked and what
 * they reported, and the field names avoid inviting any stronger reading. A commitment level is
 * repeated as reported, never asserted.
 *
 * FAILING SOFT, ON PURPOSE. An endpoint that is unreachable, slow, or does not know the transaction
 * must not cost a run its evidence: the settlement already happened, and the facilitator's account
 * of it is recorded either way. So an observation that could not be made is recorded as one that
 * could not be made, with the reason drawn from a fixed vocabulary rather than from server text.
 *
 * The status source is an interface so a test can supply one without a socket. Only the live run
 * ever constructs the Solana-backed implementation.
 */

/** What a node reported about one transaction. */
export interface TransactionStatus {
  /** The slot the endpoint said the transaction was processed in. */
  readonly slot: number;
  /** Confirmation level as reported. Absent when the endpoint reported none. */
  readonly commitment?: string;
  /** The endpoint reported that the transaction itself failed. */
  readonly reportedTransactionError: boolean;
}

export interface TransactionStatusSource {
  /**
   * Endpoint identity, safe to publish: the origin only.
   *
   * Never a path, query, fragment or userinfo component, because any of them can carry a
   * credential and this value is signed into a document meant to be handed to someone else.
   */
  readonly reference: string;
  /**
   * Ask about one transaction.
   *
   * @returns What the endpoint reported, or `undefined` when it knows no status for it.
   */
  status(transactionSignature: string): Promise<TransactionStatus | undefined>;
}

export interface RpcTransactionObservationV1 {
  /** Kept distinct from the facilitator's account of the same settlement, never merged with it. */
  readonly source: { readonly kind: 'rpc'; readonly reference: string };
  readonly transactionSignature: string;
  readonly status: 'observed' | 'unavailable';
  readonly observedSlot?: number;
  readonly commitment?: string;
  /** Present only when the endpoint reported the transaction itself as failed. */
  readonly reportedTransactionError?: boolean;
  /** Why nothing could be observed. Fixed vocabulary; never text an endpoint supplied. */
  readonly unavailableReason?: string;
  readonly observedAtUnixSeconds: number;
  /** The observation in one sentence, phrased as a report and never as a finding. */
  readonly statement: string;
}

/**
 * A label a caller states outright, rather than one derived from a configured value.
 *
 * Bounded to characters that cannot be mistaken for structure, so a label can never smuggle in the
 * part of a URL this function exists to drop.
 */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ,.:_-]{0,79}$/;

/**
 * An endpoint named without anything that could be a credential.
 *
 * ONLY THE ORIGIN SURVIVES. Scheme, host and port, and nothing else. Userinfo, password, path,
 * query and fragment are all dropped rather than judged: hosted endpoint providers routinely put
 * an API token in the path, so a path is not a safer thing to publish than a query string, and
 * this value is signed into a document meant to be handed to someone else.
 *
 * A more specific human-readable identity is therefore never derived. It has to be supplied, as
 * `safeLabel`, by a caller stating what it wants published; a label that is not plainly safe is
 * refused rather than trimmed into shape.
 *
 * @param configured - The configured endpoint, exactly as it arrived.
 * @param safeLabel - An explicitly supplied identity to publish instead of the derived origin.
 * @returns The publishable form, or `undefined` when there is nothing safe to publish.
 */
export function publicEndpointReference(
  configured: string | undefined,
  safeLabel?: string,
): string | undefined {
  if (safeLabel !== undefined) return SAFE_LABEL.test(safeLabel) ? safeLabel : undefined;
  if (configured === undefined || configured.trim().length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return undefined;
  }
  // A non-HTTP scheme has no meaningful origin: `URL` reports it as the string "null", which would
  // be published as though it were an endpoint identity.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.origin;
}

/** Fixed reasons. An endpoint's own message is never retained: it can embed anything. */
const UNREACHABLE = 'the endpoint could not be reached or did not answer in time';
const UNKNOWN_TRANSACTION = 'the endpoint reported no status for this transaction';

function isoOf(observedAtUnixSeconds: number): string {
  return new Date(observedAtUnixSeconds * 1000).toISOString();
}

/**
 * Observe one transaction through a status source.
 *
 * Never throws: an observation that could not be made is a result, not a failure of the run.
 *
 * @param input.source - Who to ask.
 * @param input.transactionSignature - The transaction the settlement reported.
 * @param input.observedAtUnixSeconds - When the question was asked.
 */
export async function observeTransaction(input: {
  readonly source: TransactionStatusSource;
  readonly transactionSignature: string;
  readonly observedAtUnixSeconds: number;
}): Promise<RpcTransactionObservationV1> {
  const { source, transactionSignature, observedAtUnixSeconds } = input;
  const at = isoOf(observedAtUnixSeconds);

  const unavailable = (reason: string): RpcTransactionObservationV1 => ({
    source: { kind: 'rpc', reference: source.reference },
    transactionSignature,
    status: 'unavailable',
    unavailableReason: reason,
    observedAtUnixSeconds,
    statement:
      `RPC ${source.reference} did not report a status for transaction ` +
      `${transactionSignature} at time ${at}: ${reason}.`,
  });

  let reported: TransactionStatus | undefined;
  try {
    reported = await source.status(transactionSignature);
  } catch {
    return unavailable(UNREACHABLE);
  }
  if (reported === undefined) return unavailable(UNKNOWN_TRANSACTION);

  const commitment = reported.commitment ?? 'none reported';
  return {
    source: { kind: 'rpc', reference: source.reference },
    transactionSignature,
    status: 'observed',
    observedSlot: reported.slot,
    ...(reported.commitment !== undefined ? { commitment: reported.commitment } : {}),
    ...(reported.reportedTransactionError ? { reportedTransactionError: true } : {}),
    observedAtUnixSeconds,
    statement:
      `RPC ${source.reference} reported transaction ${transactionSignature} at slot ` +
      `${reported.slot} with commitment ${commitment} at time ${at}` +
      `${reported.reportedTransactionError ? ', and reported that the transaction failed' : ''}.`,
  };
}

/**
 * A status source backed by a Solana RPC endpoint.
 *
 * Constructed only by the live run. The signature is coerced through the published key API, so a
 * value the settlement reported that is not a Solana signature is refused here rather than sent.
 *
 * @param rpcUrl - The endpoint to ask.
 * @param timeoutMs - How long to wait before treating the endpoint as unavailable.
 */
export function solanaRpcSource(rpcUrl: string, timeoutMs = 10_000): TransactionStatusSource {
  return {
    reference: publicEndpointReference(rpcUrl) ?? 'the configured Solana RPC endpoint',
    async status(transactionSignature: string): Promise<TransactionStatus | undefined> {
      const { createSolanaRpc, signature } = await import('@solana/kit');
      const rpc = createSolanaRpc(rpcUrl);
      const response = await rpc
        .getSignatureStatuses([signature(transactionSignature)])
        .send({ abortSignal: AbortSignal.timeout(timeoutMs) });

      const first = response.value[0];
      if (first === null || first === undefined) return undefined;
      // Slots are reported as arbitrary-precision integers. One that cannot be carried exactly is
      // treated as no observation rather than recorded at a value the endpoint did not give.
      const slot = Number(first.slot);
      if (!Number.isSafeInteger(slot)) return undefined;
      return {
        slot,
        ...(first.confirmationStatus !== null ? { commitment: first.confirmationStatus } : {}),
        reportedTransactionError: first.err !== null,
      };
    },
  };
}
