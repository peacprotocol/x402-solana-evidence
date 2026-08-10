/**
 * The payment lifecycle as the x402 express middleware actually runs it, and the terminal states
 * an evidence record has to be able to say honestly.
 *
 * The ordering below is not a design: it is what the installed middleware does. Verification
 * happens first; the response methods are then intercepted and buffered; the resource handler
 * runs; a throw or an error status cancels the verified payment without settling; otherwise
 * settlement runs and only then is the buffered origin result released to the client.
 *
 * Two consequences shape everything downstream. Settlement happens after the resource has already
 * been produced, so "the work was done but the payment did not settle" is a real state rather than
 * an edge case. And the origin can only observe that it attempted to write a response, never that
 * the client received one, so the successful terminal state is `response_write_attempted` and
 * never anything that claims delivery.
 */

/** Lifecycle positions, in the order the middleware reaches them. */
export const LIFECYCLE_STATES = [
  'request_received',
  'payment_required',
  'payment_payload_received',
  'payment_verified',
  'resource_executed',
  'payment_settled',
  'response_prepared',
  'response_write_attempted',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Where a run ended.
 *
 * `response_write_attempted` is the only state in which the customer both paid and received the
 * result. The rest are the failure branches; each is a legitimate outcome to record, and none of
 * them is an error in the evidence.
 */
export const TERMINAL_STATES = [
  /** The customer paid and the origin attempted to write the result. */
  'response_write_attempted',
  /** F1: verification rejected. The handler never ran. */
  'verification_rejected',
  /**
   * F2: the middleware reported that the handler threw.
   *
   * MEASURED: an express route handler cannot reach this state, because express catches the throw
   * and turns it into an error response before the middleware observes it, which arrives as the
   * state below. The state is kept because the middleware defines the cancellation reason and
   * another transport can produce it; it is never claimed as exercised here.
   */
  'handler_threw',
  /** F3: the handler produced an error status. Canceled without settling. */
  'handler_error_status',
  /** F4: the resource was produced and settlement failed. The result was never written. */
  'settlement_failed',
  /** F5: settlement succeeded and writing the response failed. */
  'response_write_failed',
  /** No payment was presented, so the challenge is the whole run. */
  'payment_required_only',
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Whether a terminal state means the origin result reached the client's side of the wire. */
export function originResultWasWritten(state: TerminalState): boolean {
  return state === 'response_write_attempted' || state === 'handler_error_status';
}

/** Whether a terminal state means settlement succeeded. */
export function paymentWasSettled(state: TerminalState): boolean {
  return state === 'response_write_attempted' || state === 'response_write_failed';
}

/** One observation of the lifecycle, as seen from a named vantage point. */
export interface LifecycleObservation {
  /** Positions reached, in order, without duplicates. */
  readonly states: readonly LifecycleState[];
  readonly terminalState: TerminalState;
  /** Reason reported by the middleware when a verified payment was canceled. */
  readonly cancellationReason?: string;
  /** Reason reported by verification or settlement when it refused. */
  readonly failureReason?: string;
  /** Transaction reference reported by settlement, when settlement succeeded. */
  readonly transaction?: string;
  /** Payer reported by verification or settlement. */
  readonly payer?: string;
  /** HTTP status the origin attempted to write. */
  readonly responseStatus?: number;
}

/**
 * Accumulates lifecycle positions during one request.
 *
 * Deliberately dumb: it records what it is told, in order, and never infers a position that was
 * not reported. An inferred state would be indistinguishable in the evidence from an observed one.
 */
export class LifecycleRecorder {
  private readonly seen: LifecycleState[] = [];
  private terminal: TerminalState = 'payment_required_only';
  private detail: {
    cancellationReason?: string;
    failureReason?: string;
    transaction?: string;
    payer?: string;
    responseStatus?: number;
  } = {};

  enter(state: LifecycleState): void {
    if (!this.seen.includes(state)) this.seen.push(state);
  }

  finish(state: TerminalState, detail: LifecycleRecorder['detail'] = {}): void {
    this.terminal = state;
    this.detail = { ...this.detail, ...detail };
  }

  note(detail: LifecycleRecorder['detail']): void {
    this.detail = { ...this.detail, ...detail };
  }

  observation(): LifecycleObservation {
    const ordered = LIFECYCLE_STATES.filter((s) => this.seen.includes(s));
    return {
      states: ordered,
      terminalState: this.terminal,
      ...(this.detail.cancellationReason ? { cancellationReason: this.detail.cancellationReason } : {}),
      ...(this.detail.failureReason ? { failureReason: this.detail.failureReason } : {}),
      ...(this.detail.transaction ? { transaction: this.detail.transaction } : {}),
      ...(this.detail.payer ? { payer: this.detail.payer } : {}),
      ...(this.detail.responseStatus !== undefined ? { responseStatus: this.detail.responseStatus } : {}),
    };
  }
}
