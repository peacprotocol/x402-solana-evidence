/**
 * Named acceptance registry.
 *
 * A count of passing checks says nothing about which properties were actually exercised: a suite
 * can grow while quietly losing the case that mattered. Every acceptance case therefore carries a
 * stable identifier, declared here once, and the suites record identifiers as they execute. A
 * completeness runner then fails if any declared identifier never executed, so coverage cannot
 * silently regress and no case can be skipped without the gate noticing.
 *
 * Four execution scopes exist:
 *   local            executed by the test suites in this process
 *   ci-external      executed by a continuous-integration job that this process cannot reproduce
 *                    (a repeated-run byte comparison, or a run with networking disabled). These are
 *                    still declared here so the matrix stays complete and visible.
 *   live-acceptance  executed only against a live network by a person, as a recorded acceptance
 *                    run. It is never executable here or in continuous integration, so it is
 *                    always reported as pending rather than as a result.
 *   planned          declared, agreed, and not yet implemented. Declaring it keeps the matrix
 *                    honest about what is still missing instead of letting a case appear once its
 *                    test happens to be written. A planned case is reported as planned, never as
 *                    executed, and moves to `local` in the change that lands its test.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExecutionScope = 'local' | 'ci-external' | 'live-acceptance' | 'planned';

export interface AcceptanceCase {
  readonly description: string;
  readonly scope: ExecutionScope;
}

/** The declared acceptance matrix for the implemented scope. */
export const ACCEPTANCE_CASES = {
  'X402-VALID-001': { description: 'PaymentRequired fixture accepted by the upstream validator', scope: 'local' },
  'X402-VALID-002': { description: 'PaymentPayload (SVM exact shape) accepted by the upstream validator', scope: 'local' },
  'X402-VALID-003': { description: 'payment identifier extension present and valid via upstream APIs', scope: 'local' },
  'X402-VALID-004': { description: 'round trip: encode, capture, upstream validation self-test', scope: 'local' },
  'X402-REJECT-001': { description: 'an arbitrary JSON object is rejected at the upstream-schema stage', scope: 'local' },
  'X402-REJECT-002': { description: 'a missing required member is rejected', scope: 'local' },
  'X402-REJECT-003': { description: 'a wrong x402Version is rejected', scope: 'local' },
  'X402-REJECT-004': { description: 'an unknown scheme is rejected at the scheme-payload stage', scope: 'local' },
  'X402-REJECT-005': { description: 'a malformed CAIP-2 network is rejected', scope: 'local' },
  'X402-REJECT-006': { description: 'a valid v1-shaped object is rejected by the v2 predicate', scope: 'local' },
  'X402-REJECT-007': { description: 'base64 tampered after encoding is rejected', scope: 'local' },
  'X402-REJECT-008': { description: 'a non-visible-ASCII field value is refused at capture', scope: 'local' },
  'X402-DUP-001': { description: 'a literal duplicate member is rejected before canonicalization', scope: 'local' },
  'X402-DUP-002': { description: 'an escaped-key collision is rejected before canonicalization', scope: 'local' },
  'X402-DUP-003': { description: 'a duplicate member in a nested object is rejected', scope: 'local' },
  'X402-STAGE-001': { description: 'the stage report names the exact failing stage', scope: 'local' },
  'X402-STAGE-002': { description: 'settle response keeps upstream-schema status not_evaluated', scope: 'local' },
  'X402-STAGE-003': { description: 'a capture-only artifact cannot be promoted', scope: 'local' },
  'X402-STAGE-004': { description: 'transport decoding never implies schema validity', scope: 'local' },
  'X402-LIMIT-001': { description: 'an oversized encoded field value is refused', scope: 'local' },
  'X402-LIMIT-002': { description: 'an oversized decoded payload is refused', scope: 'local' },
  'X402-LIMIT-003': { description: 'diagnostics are truncated at the declared caps', scope: 'local' },
  'FOUND-DET-001': { description: 'the fixture demonstration produces byte-identical output across runs', scope: 'ci-external' },
  'FOUND-NET-001': { description: 'the offline path passes in a job with networking disabled', scope: 'ci-external' },

  // Solana virtual machine exact-scheme reference flow.
  'SVM-FLOW-001': { description: 'offline end-to-end run reaches the response-write-attempted state', scope: 'local' },
  'SVM-FLOW-002': { description: 'the challenge carries a valid payment-required field value', scope: 'local' },
  'SVM-FLOW-003': { description: 'a record is issued, verifies locally, and every digest recomputes', scope: 'local' },
  'SVM-FLOW-004': { description: 'devnet run with a real transaction signature', scope: 'live-acceptance' },
  'SVM-LIFE-001': { description: 'verification rejected: no resource execution, no settlement', scope: 'local' },
  'SVM-LIFE-002': { description: 'a throwing handler is normalized by express into the handler-error cancellation state', scope: 'local' },
  'SVM-LIFE-003': { description: 'handler returned an error status: cancellation, no settlement', scope: 'local' },
  'SVM-LIFE-004': { description: 'resource executed and settlement failed: recorded as never written', scope: 'local' },
  'SVM-LIFE-005': { description: 'a payment refused before verification produces verifiable evidence of the refusal', scope: 'local' },
  /**
   * NARROWED, and the description says so rather than the claim being quietly widened later.
   * Whether a fee payer is isolated from the transfer it pays for is decided by the upstream SVM
   * facilitator against a real transaction. The offline path has no such transaction, and
   * rebuilding that machinery would test upstream rather than this integration, so what is
   * asserted here is the property this integration owns: the fee payer stays a role and never
   * becomes a party to the payment.
   */
  'SVM-SEC-001': { description: 'the fee payer stays a distinct role and never becomes the payer or the recipient', scope: 'local' },
  'SVM-SEC-002': { description: 'a destination other than the configured recipient is rejected', scope: 'local' },
  'SVM-SEC-003': { description: 'an amount other than the exact requirement is rejected', scope: 'local' },
  'SVM-SEC-004': { description: 'a different asset is rejected', scope: 'local' },
  'SVM-SEC-005': { description: 'a different network is rejected', scope: 'local' },
  'SVM-REPLAY-001': { description: 'a repeated payment identifier is not refused at this layer and stays visible in the evidence', scope: 'local' },
  'SVM-REPLAY-002': { description: 'a second settlement of the same payment is refused or idempotent', scope: 'local' },
  'SVM-BIND-001': { description: 'a payment bound to one resource fails request binding against another', scope: 'local' },
  'SVM-BIND-002': { description: 'the same path with a changed query fails request binding', scope: 'local' },
  'SVM-BIND-003': { description: 'an altered origin result fails result binding', scope: 'local' },
  'SVM-BIND-004': { description: 'a valid native artifact with an incorrect binding fails at the binding stage', scope: 'local' },
  'SVM-BIND-005': { description: 'an observed-request binding names the authority that actually served the request', scope: 'local' },
  'SVM-TAMPER-001': { description: 'a tampered result digest fails at the expected stage', scope: 'local' },
  'SVM-TAMPER-002': { description: 'a tampered observed field value fails its binding digest', scope: 'local' },
  'SVM-TAMPER-003': { description: 'a tampered record payload fails local verification with an invalid signature', scope: 'local' },
  'SVM-TAMPER-004': { description: 'a valid native artifact with an invalid record binding fails at the binding stage', scope: 'local' },
  'SVM-TAMPER-005': { description: 'a valid record with a missing native artifact fails the presence contract', scope: 'local' },
  // The evidence directory as a thing handed to someone else: verified under a supplied key.
  'EVID-CLI-001': { description: 'an evidence directory and a supplied public key verify through the documented arguments', scope: 'local' },
  'EVID-CLI-002': { description: 'a public key that did not sign the record fails at the signature stage', scope: 'local' },
  'EVID-CLI-003': { description: 'a malformed public key file is refused with the file and the reason named', scope: 'local' },
  /**
   * What a key file says about itself, against what the record says.
   *
   * Only the key bytes decide a signature. The algorithm, key identifier and issuer a file
   * declares are a description of those bytes, and a description that disagrees with the record is
   * reported as its own failure. Agreement is consistency, never identity.
   */
  'KEYMETA-001': { description: 'a key file naming a different key identifier is reported as inconsistent', scope: 'local' },
  'KEYMETA-002': { description: 'a key file naming a different issuer is reported as inconsistent', scope: 'local' },
  'KEYMETA-003': { description: 'a key file whose declared metadata matches the record verifies', scope: 'local' },
  'KEYMETA-004': { description: 'key bytes that did not sign the record still fail at the signature stage', scope: 'local' },
  /**
   * Exercised through an injected status source rather than a socket. What is being tested is how
   * this example records a second observer, not whether a Solana node answers; the endpoint-backed
   * source is the one line these cases deliberately do not run, and a live run covers it.
   */
  'SVM-RPC-001': { description: 'a node status is recorded as a separate observation naming its source', scope: 'local' },
  'SVM-RPC-002': { description: 'an unavailable node is recorded honestly and does not cost the run its evidence', scope: 'local' },
  /**
   * Two observers of one transaction, disagreeing.
   *
   * The property is that the disagreement is reported and not resolved: integrity still passes,
   * the signature is still valid, and neither account is promoted to a fact about the network.
   */
  'OBS-AGREE-001': { description: 'two observers reporting the same outcome raise no warning', scope: 'local' },
  'OBS-AGREE-002': { description: 'facilitator success against a node-reported transaction error is warned about, and still verifies', scope: 'local' },
  'OBS-AGREE-003': { description: 'an unavailable node observation is informational and corroborates nothing', scope: 'local' },
  /**
   * Endpoint references, against URLs built to leak.
   *
   * Each case drives the real derivation used by the live run and then string-scans everything the
   * evidence emission wrote, because the property is about what reaches a published document
   * rather than about what one function returns.
   */
  'RED-URL-001': { description: 'userinfo and password in an endpoint URL never reach the evidence', scope: 'local' },
  'RED-URL-002': { description: 'a token carried in an endpoint path never reaches the evidence', scope: 'local' },
  'RED-URL-003': { description: 'an API key carried in an endpoint query never reaches the evidence', scope: 'local' },
  'RED-URL-004': { description: 'an endpoint fragment never reaches the evidence', scope: 'local' },

  /**
   * Verification against a directory built to break it.
   *
   * A verifier handed hostile files must produce a verdict, not a stack trace: a reader who cannot
   * tell "this evidence is bad" from "the verifier fell over" has learned nothing.
   */
  'HOSTILE-EV-001': { description: 'a malformed request binding is reported as a failure, not thrown', scope: 'local' },
  'HOSTILE-EV-002': { description: 'a malformed origin result binding is reported as a failure, not thrown', scope: 'local' },
  'HOSTILE-EV-003': { description: 'a malformed chain observation is reported as a failure, not thrown', scope: 'local' },
  'HOSTILE-EV-004': { description: 'a sidecar of the wrong JSON type is reported as a failure, not thrown', scope: 'local' },
  'HOSTILE-EV-005': { description: 'an artifact that exists but cannot be read fails, and is never read as absent', scope: 'local' },

  /**
   * The filesystem itself as a hostile input.
   *
   * A directory handed over by another party decides how large its files are and what its names
   * point at. Reading it without bounds trusts both. Each case here is a directory a verifier could
   * be handed, and the property is the same in all of them: a bounded, named failure, promptly,
   * rather than a crash, an exhausted process, or a read of something the directory does not
   * contain.
   */
  'FS-BOUND-001': { description: 'a request binding past its size bound is refused before it is read into memory', scope: 'local' },
  'FS-BOUND-002': { description: 'a chain observation past its size bound is refused before it is read into memory', scope: 'local' },
  'FS-BOUND-003': { description: 'an origin result body past its size bound is refused before it is read into memory', scope: 'local' },
  'FS-BOUND-004': { description: 'a symbolic link standing in for a sidecar is refused rather than followed', scope: 'local' },
  'FS-BOUND-005': { description: 'a symbolic link standing in for a captured field value is refused rather than followed', scope: 'local' },
  'FS-BOUND-006': { description: 'a symbolic link standing in for the nested artifact directory is refused rather than followed', scope: 'local' },
  'FS-BOUND-007': { description: 'a path that is not a regular file is refused without being opened or waited on', scope: 'local' },

  /**
   * What may be admitted as a document at all, before anything is canonicalized.
   *
   * These documents are canonicalized and compared against digests inside a signed record, so a
   * document two parsers would read differently must never reach canonicalization: the digest would
   * then cover whichever reading the reader's parser happened to build. Each case is a document
   * that parses into exactly the expected value and is refused anyway, because what is wrong with
   * it is that it is ambiguous rather than that it is invalid.
   *
   * This is a PEAC binding-safety rule and not an x402 conformance rule.
   */
  'STRICT-EV-001': { description: 'a sidecar with a repeated member is refused before canonicalization', scope: 'local' },
  'STRICT-EV-002': { description: 'a sidecar whose repeated member name is escaped is refused before canonicalization', scope: 'local' },
  'STRICT-EV-003': { description: 'a sidecar carrying invalid UTF-8 is refused rather than decoded with replacements', scope: 'local' },
  'STRICT-EV-004': { description: 'a repeated member inside a nested object is refused before canonicalization', scope: 'local' },
  'STRICT-EV-005': { description: 'a sidecar nested past the scanner bound is refused rather than scanned partially', scope: 'local' },
  'STRICT-EV-006': { description: 'a supplied public key file with a repeated member is refused before it is used', scope: 'local' },

  /**
   * The material a reviewer needs, produced before anything is spent.
   *
   * A live run that settles a payment and then cannot write the public half of its signing key has
   * produced a complete transcript nobody else can check. So the output paths are reserved and the
   * key file is written and read back before a payment can be sent.
   */
  'EVID-KEY-001': { description: 'a taken output path stops the run before anything is built or sent', scope: 'local' },
  'EVID-KEY-002': { description: 'a completed emission leaves both the evidence and its verification key', scope: 'local' },

  /**
   * What a remote party says, against what this flow writes down.
   *
   * A failure reason is carried into a document that gets signed and published, so nothing a
   * facilitator or an exception supplied may reach it. The captured x402 field values are a
   * separate matter: those are observed wire artifacts and carry exactly what was sent.
   */
  'SAN-ERR-001': { description: 'remote failure text never reaches a persisted reason or a durable diagnostic', scope: 'local' },

  'EVID-TX-001': { description: 'an interrupted emission leaves no final evidence directory', scope: 'local' },
  'EVID-TX-002': { description: 'an existing evidence directory is never overwritten or written into', scope: 'local' },

  'SVM-DET-001': { description: 'the offline end-to-end run produces byte-identical evidence across runs', scope: 'ci-external' },
  'SVM-NET-001': { description: 'the offline end-to-end run passes in a job with networking disabled', scope: 'ci-external' },

  // Key persistence. These run offline: key generation is local computation, not a network call.
  'KEY-RT-001': { description: 'a payer key is created, persisted and reloaded to the same address', scope: 'local' },
  'KEY-RT-002': { description: 'a reloaded payer key signs, and the signature verifies under the persisted public key', scope: 'local' },
  'KEY-RT-003': { description: 'a devnet issuer key is created, persisted and reloaded to the same key pair', scope: 'local' },
  'KEY-FC-001': { description: 'a payer key file that is not valid JSON is refused and left unchanged', scope: 'local' },
  'KEY-FC-002': { description: 'a payer key file of the wrong length is refused and left unchanged', scope: 'local' },
  'KEY-FC-003': { description: 'a payer key file whose halves do not match is refused and left unchanged', scope: 'local' },
  'KEY-FC-004': { description: 'an issuer key file with an unusable private key is refused and left unchanged', scope: 'local' },

  /**
   * Preflight revalidation and recipient validation. Only the pre-network failure paths are
   * exercised here, which is exactly what these cases are about: a live run must stop on local
   * grounds before it reaches for a connection, and that is decidable offline. The passing live
   * path stays with SVM-FLOW-004, where a network exists.
   */
  'PRE-RV-001': { description: 'a live run with no payer key stops before any network call', scope: 'local' },
  'PRE-RV-002': { description: 'a live run with an invalid recipient stops before any network call', scope: 'local' },
  'PRE-ROLE-001': { description: 'a run whose recipient is the payer stops before any network call', scope: 'local' },
  'PRE-ADDR-001': { description: 'a valid Solana address is accepted as the recipient', scope: 'local' },
  'PRE-ADDR-002': { description: 'a recipient that is not valid base58 is rejected', scope: 'local' },
  'PRE-ADDR-003': { description: 'a recipient of the wrong length is rejected', scope: 'local' },
  'PRE-ADDR-004': { description: 'a recipient carrying whitespace is rejected rather than trimmed', scope: 'local' },
} as const satisfies Record<string, AcceptanceCase>;

export type AcceptanceId = keyof typeof ACCEPTANCE_CASES;

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = join(HERE, '..', '.acceptance');

let ledgerPath: string | undefined;

/**
 * Start recording for one suite. Each suite writes its own ledger so suites stay independent
 * processes while the completeness check still sees their union.
 */
export function beginAcceptanceSuite(suite: string): void {
  if (!/^[a-z0-9-]+$/.test(suite)) throw new Error(`invalid suite name: ${suite}`);
  mkdirSync(LEDGER_DIR, { recursive: true });
  ledgerPath = join(LEDGER_DIR, `${suite}.ledger`);
  // Truncate by writing an empty file, so a removed case disappears from the union.
  appendFileSync(ledgerPath, '', { flag: 'w' });
}

/** Record that an acceptance case executed. Unknown identifiers are a programming error. */
export function recordExecution(id: AcceptanceId): void {
  if (!(id in ACCEPTANCE_CASES)) throw new Error(`unknown acceptance id: ${id}`);
  if (ledgerPath === undefined) throw new Error('beginAcceptanceSuite must be called before recordExecution');
  appendFileSync(ledgerPath, `${id}\n`);
}

/** Every identifier recorded by any suite in the current run. */
export function readExecutedIds(): Set<string> {
  const executed = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(LEDGER_DIR);
  } catch {
    return executed;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.ledger')) continue;
    for (const line of readFileSync(join(LEDGER_DIR, entry), 'utf8').split('\n')) {
      const id = line.trim();
      if (id.length > 0) executed.add(id);
    }
  }
  return executed;
}

export interface CompletenessReport {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly executed: readonly string[];
  readonly declaredExternally: readonly string[];
  readonly pendingLiveAcceptance: readonly string[];
  readonly planned: readonly string[];
  /** Declared out of process but recorded anyway: the scope or the recording is wrong. */
  readonly misscoped: readonly string[];
}

/**
 * Compare the declared matrix against what actually executed.
 *
 * Cases outside this process are reported under their own scope rather than treated as executed,
 * so a local run never reads as though it proved something it did not. A case recorded while
 * declared out of process is an error in the other direction, and is reported as such: it would
 * otherwise let a suite quietly satisfy a case that the matrix still presents as pending.
 */
export function checkCompleteness(): CompletenessReport {
  const executed = readExecutedIds();
  const missing: string[] = [];
  const declaredExternally: string[] = [];
  const pendingLiveAcceptance: string[] = [];
  const planned: string[] = [];
  const misscoped: string[] = [];
  for (const [id, spec] of Object.entries(ACCEPTANCE_CASES)) {
    if (spec.scope !== 'local') {
      if (executed.has(id)) misscoped.push(id);
      else if (spec.scope === 'ci-external') declaredExternally.push(id);
      else if (spec.scope === 'live-acceptance') pendingLiveAcceptance.push(id);
      else planned.push(id);
      continue;
    }
    if (!executed.has(id)) missing.push(id);
  }
  return {
    complete: missing.length === 0 && misscoped.length === 0,
    missing,
    executed: [...executed].sort(),
    declaredExternally,
    pendingLiveAcceptance,
    planned,
    misscoped,
  };
}
