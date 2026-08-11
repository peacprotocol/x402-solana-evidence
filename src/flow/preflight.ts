/**
 * Devnet preflight.
 *
 * Everything a live run needs, checked before anything is signed or sent, so a run either starts
 * from a known-good state or stops with the exact reason and what to do about it. A live run that
 * discovers a missing prerequisite halfway through produces a partial transcript, which is the one
 * outcome an evidence example must not produce.
 *
 * THIS FILE AND THE LIVE DEMONSTRATION ARE THE ONLY PLACES THAT USE THE NETWORK. Nothing else in
 * the reference flow opens a connection, and the offline path never calls the network-using checks
 * here; it exercises only the local ones, which is why they are separated below.
 *
 * The payer key is created once and reused; how it is stored and reloaded lives in `payer-key.ts`.
 *
 * WHAT THE PAYER NEEDS, AND WHAT IT DOES NOT. The payer needs devnet USDC. It does not need devnet
 * SOL, and this preflight does not require any. In the exact scheme the transaction fee is paid by
 * the facilitator: the resource server advertises the facilitator's own address as the fee payer,
 * the client sets that address as the transaction's fee payer and only partially signs, and the
 * facilitator refuses a payment whose fee payer is not one of its own. The payer signs solely as
 * the authority on the token transfer, which moves USDC and spends no lamports of its own. The
 * balance is still reported, because a reader benefits from seeing it, but it gates nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS, DEVNET_RPC_URL } from '@x402/svm';
import { isAddress, type createSolanaRpc } from '@solana/kit';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { displayKeyPath } from './key-file.ts';
import { ENDPOINT_UNREACHABLE } from './observe-transaction.ts';
import { loadPayerSigner, PAYER_KEY_PATH, resolvePayerSigner } from './payer-key.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Enough devnet USDC to pay the demonstration price several times over. */
export const MIN_USDC_BASE_UNITS = 1_000_000n;

export const FUNDING_INSTRUCTIONS = [
  'Devnet USDC: request test USDC for the payer address from the Circle testnet faucet.',
  'Devnet SOL is not required: the facilitator pays the transaction fee in this scheme.',
].join('\n  ');

/**
 * `note` reports something worth seeing that decides nothing. It exists so an observation can be
 * shown without being turned into a requirement, which is how a check nobody needs ends up
 * blocking a run.
 */
export type CheckStatus = 'ok' | 'failed' | 'note' | 'not_evaluated';

export interface PreflightCheck {
  readonly name: string;
  readonly status: CheckStatus;
  /** Bounded, non-quoting explanation. Never contains key material. */
  readonly detail: string;
}

export interface PreflightReport {
  readonly ready: boolean;
  readonly checks: readonly PreflightCheck[];
  /** Public address of the payer. Safe to print, share and fund. */
  readonly payerAddress?: string;
}

const ok = (name: string, detail: string): PreflightCheck => ({ name, status: 'ok', detail });
const failed = (name: string, detail: string): PreflightCheck => ({ name, status: 'failed', detail });
const note = (name: string, detail: string): PreflightCheck => ({ name, status: 'note', detail });
const notEvaluated = (name: string, detail: string): PreflightCheck => ({
  name,
  status: 'not_evaluated',
  detail,
});

/** Create or reuse the devnet payer key and report the address a person needs to fund. */
export async function resolvePayerAddress(): Promise<string> {
  return (await resolvePayerSigner()).address;
}

/**
 * Check that the recipient is an address this network can actually pay.
 *
 * Configuration reaches this example as an environment variable, so it is a string that has never
 * been checked by anything. Left unchecked, a typo is discovered by the chain, after a payment has
 * been built and signed, which is the worst place to find it. It is decided here instead, using the
 * same address rule the rest of the stack uses, before anything opens a connection.
 *
 * Whitespace is refused rather than trimmed. Trimming guesses at what was meant and quietly pays a
 * different address than the one that was configured.
 *
 * @param payTo - The configured recipient, exactly as supplied.
 */
function recipientCheck(payTo: string | undefined): PreflightCheck {
  const name = 'recipient is a Solana address';
  if (payTo === undefined || payTo.length === 0) {
    return failed(name, 'no recipient address configured for the paid resource');
  }
  if (payTo.trim() !== payTo) {
    return failed(name, 'the configured recipient has leading or trailing whitespace');
  }
  if (!isAddress(payTo)) {
    return failed(name, 'the configured recipient is not a Solana address');
  }
  return ok(name, payTo);
}

/**
 * The payer and the recipient have to be two different accounts.
 *
 * A DEMONSTRATION INVARIANT OF THIS EXAMPLE, and nothing more. Neither x402 nor Solana forbids
 * paying yourself, and a real integration may have perfectly good reasons to. This example exists
 * to show a payment moving between parties and being recorded as such, and a run where the payer
 * and the recipient are one account produces evidence in which the two roles cannot be told apart
 * by anyone reading it. So it is refused here, on local grounds, before anything reaches a network.
 *
 * @param payTo - The configured recipient, already established as an address.
 * @param payerAddress - The address of the key that will sign the payment.
 */
export function distinctRolesCheck(payTo: string, payerAddress: string): PreflightCheck {
  const name = 'payer and recipient are distinct';
  if (payTo !== payerAddress) return ok(name, 'the payment moves between two accounts');
  return failed(
    name,
    'the configured recipient is the payer address; this example requires them to differ so both ' +
      'roles stay independently observable in the evidence. That is an invariant of this ' +
      'demonstration, not a rule of x402 or of Solana',
  );
}

/**
 * Checks that need no network.
 *
 * Separated so they can be exercised offline, including their failure paths, without the suite
 * ever reaching for a connection.
 */
export function checkLocalConfiguration(input: {
  readonly network: Network;
  readonly payTo: string | undefined;
  readonly asset: string;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  checks.push(
    input.network === SOLANA_DEVNET_CAIP2
      ? ok('network is Solana devnet', input.network)
      : failed(
          'network is Solana devnet',
          `configured ${input.network}, this example supports only ${SOLANA_DEVNET_CAIP2}`,
        ),
  );

  checks.push(recipientCheck(input.payTo));

  checks.push(
    input.asset === USDC_DEVNET_ADDRESS
      ? ok('asset is devnet USDC', input.asset)
      : failed(
          'asset is devnet USDC',
          `configured ${input.asset}, expected the devnet USDC mint ${USDC_DEVNET_ADDRESS}`,
        ),
  );

  return checks;
}

/**
 * How long any single request to the configured endpoint may take before it is treated as no
 * answer.
 *
 * An endpoint that never responds is not the same failure as one that refuses a connection: the
 * second returns an error and the first returns nothing at all, so a preparation command without a
 * deadline can sit there indefinitely with no output and no way to tell it apart from slow work.
 * The bound turns that into an ordinary failed check.
 */
export const PREFLIGHT_RPC_TIMEOUT_MS = 12_000;

/**
 * The endpoint calls this preflight makes, and nothing else.
 *
 * Narrowed from the full client so a test can supply an endpoint that behaves however the case
 * needs, including one that never answers, without a socket and without reconstructing a client.
 */
export type ChainStateRpc = Pick<
  ReturnType<typeof createSolanaRpc>,
  'getGenesisHash' | 'getBalance' | 'getTokenAccountsByOwner'
>;

export interface ChainStateOptions {
  /** Per-request deadline. Defaults to `PREFLIGHT_RPC_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The endpoint to ask. Defaults to a client for `rpcUrl`. Supplied by tests. */
  readonly rpc?: ChainStateRpc;
}

/**
 * Send one request under the deadline.
 *
 * Whatever came back from a failure is deliberately dropped rather than reported: a timeout, a
 * refused connection and an error the endpoint composed itself are all "no usable answer" here,
 * and only the last one carries remote text.
 */
async function attempt<T>(
  request: () => { send(config?: { abortSignal?: AbortSignal }): Promise<T> },
  timeoutMs: number,
): Promise<T | undefined> {
  try {
    return await request().send({ abortSignal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return undefined;
  }
}

/** Named once: the genesis result decides whether the later endpoint checks are worth asking. */
const GENESIS_CHECK = 'endpoint genesis matches devnet';

/** The account lookups behind the recipient readiness check, and nothing else. */
export type RecipientReadinessRpc = Pick<ReturnType<typeof createSolanaRpc>, 'getAccountInfo'>;

export interface RecipientReadinessOptions {
  /** Per-request deadline. Defaults to `PREFLIGHT_RPC_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The endpoint to ask. Defaults to a client for `rpcUrl`. Supplied by tests. */
  readonly rpc?: RecipientReadinessRpc;
}

export const RECIPIENT_READINESS_CHECK = 'recipient can receive devnet USDC';

/**
 * One wording for one outcome. An account that was never created and an account that exists
 * without being initialized are the same fact to a payment: there is nothing there to receive it.
 */
const ATA_NOT_INITIALIZED = 'the derived devnet USDC associated token account is not initialized';

/**
 * Balance and network-identity checks. Opens connections; never called by the offline path.
 *
 * Every request carries a deadline, and a request that does not answer within it becomes a named
 * failed check rather than a wait with no end. The reason recorded is fixed text: an endpoint's own
 * message is written to a terminal and pasted into run notes, and it can say anything at all.
 *
 * A genesis call that does not answer stops the sequence, because the two calls after it are to the
 * same endpoint and would spend the same deadline again to learn the same thing. They are reported
 * as not evaluated, which is what they are.
 */
export async function checkChainState(
  payerAddress: string,
  rpcUrl: string,
  options: ChainStateOptions = {},
): Promise<PreflightCheck[]> {
  const { createSolanaRpc, address } = await import('@solana/kit');
  const rpc = options.rpc ?? createSolanaRpc(rpcUrl);
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_RPC_TIMEOUT_MS;
  const checks: PreflightCheck[] = [];

  const genesisHash = await attempt(() => rpc.getGenesisHash(), timeoutMs);
  if (genesisHash === undefined) {
    return [
      failed(GENESIS_CHECK, ENDPOINT_UNREACHABLE),
      notEvaluated('payer SOL balance', 'the endpoint did not answer'),
      notEvaluated('payer holds devnet USDC', 'the endpoint did not answer'),
    ];
  }
  const derivedCaip2 = `solana:${String(genesisHash).slice(0, 32)}`;
  checks.push(
    derivedCaip2 === SOLANA_DEVNET_CAIP2
      ? ok(GENESIS_CHECK, derivedCaip2)
      : failed(GENESIS_CHECK, `endpoint reports ${derivedCaip2}, expected ${SOLANA_DEVNET_CAIP2}`),
  );

  // Reported, not required: the facilitator pays the transaction fee, so a payer with no SOL can
  // still complete this flow. See the note at the top of this file for where that is decided.
  const balance = await attempt(() => rpc.getBalance(address(payerAddress)), timeoutMs);
  checks.push(
    balance === undefined
      ? note('payer SOL balance', `not read: ${ENDPOINT_UNREACHABLE}`)
      : note('payer SOL balance', `${balance.value} lamports, not required for this flow`),
  );

  const tokenAccounts = await attempt(
    () =>
      rpc.getTokenAccountsByOwner(
        address(payerAddress),
        { mint: address(USDC_DEVNET_ADDRESS) },
        { encoding: 'jsonParsed' },
      ),
    timeoutMs,
  );
  if (tokenAccounts === undefined) {
    checks.push(failed('payer holds devnet USDC', ENDPOINT_UNREACHABLE));
    return checks;
  }
  let usdc = 0n;
  try {
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed as {
        info?: { tokenAmount?: { amount?: string } };
      };
      usdc += BigInt(parsed.info?.tokenAmount?.amount ?? '0');
    }
  } catch {
    // An amount that is not an integer is something only the endpoint can produce, so it is
    // reported as a balance this run could not read rather than raised as a fault of this process.
    checks.push(failed('payer holds devnet USDC', 'the endpoint reported a balance this run could not read'));
    return checks;
  }
  checks.push(
    usdc >= MIN_USDC_BASE_UNITS
      ? ok('payer holds devnet USDC', `${usdc} base units`)
      : failed(
          'payer holds devnet USDC',
          `${usdc} base units, at least ${MIN_USDC_BASE_UNITS} required`,
        ),
  );

  return checks;
}

/**
 * Whether the recipient can actually receive the asset, at the account the transfer will name.
 *
 * A recipient that is a valid address is not yet a recipient that can be paid. In the exact SVM
 * scheme the transfer does not move tokens to `payTo` itself: it moves them to the associated
 * token account derived from `payTo` and the mint, and the payment the client builds contains a
 * compute-budget instruction, one `TransferChecked` and a memo, and nothing that creates that
 * account. A recipient configured for the first time therefore passes every other check here and
 * the transfer still has nowhere to land.
 *
 * So the exact destination is derived and looked up, rather than the recipient address being
 * looked up as if it held tokens. Two properties make the derivation the same one the payment
 * uses: the mint's owning program is read from the mint account rather than assumed, because a
 * mint may belong to either token program and the derived address differs between them; and the
 * account found there is required to be a token account naming this mint and this owner, so an
 * answer about some other account cannot satisfy the check.
 *
 * NOTHING IS CREATED, FUNDED OR SENT. This reports a state and never changes one: whether an
 * account should exist, and who should pay to create it, is a decision for whoever runs this.
 *
 * @param payTo - The configured recipient, already established as an address.
 * @param rpcUrl - The endpoint to ask.
 */
export async function checkRecipientReadiness(
  payTo: string,
  rpcUrl: string,
  options: RecipientReadinessOptions = {},
): Promise<PreflightCheck> {
  const name = RECIPIENT_READINESS_CHECK;
  const { createSolanaRpc, address } = await import('@solana/kit');
  const { findAssociatedTokenPda } = await import('@solana-program/token');
  const rpc = options.rpc ?? createSolanaRpc(rpcUrl);
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_RPC_TIMEOUT_MS;

  const mint = await attempt(
    () => rpc.getAccountInfo(address(USDC_DEVNET_ADDRESS), { encoding: 'jsonParsed' }),
    timeoutMs,
  );
  if (mint === undefined) return failed(name, ENDPOINT_UNREACHABLE);
  const tokenProgram = mint.value?.owner;
  if (tokenProgram === undefined || tokenProgram === null) {
    return failed(name, 'the devnet USDC mint was not found at the configured endpoint');
  }

  const [destination] = await findAssociatedTokenPda({
    mint: address(USDC_DEVNET_ADDRESS),
    owner: address(payTo),
    tokenProgram,
  });

  const account = await attempt(
    () => rpc.getAccountInfo(destination, { encoding: 'jsonParsed' }),
    timeoutMs,
  );
  if (account === undefined) return failed(name, ENDPOINT_UNREACHABLE);
  if (account.value === null || account.value === undefined) {
    return failed(name, ATA_NOT_INITIALIZED);
  }

  // A response that is not a parsed token account, or is one describing a different mint or a
  // different owner, is not the account this transfer names, whatever address it arrived under.
  const parsed = (
    account.value.data as {
      readonly parsed?: { readonly type?: string; readonly info?: Record<string, unknown> };
    }
  ).parsed;
  if (
    account.value.owner !== tokenProgram ||
    parsed?.type !== 'account' ||
    parsed.info?.['mint'] !== USDC_DEVNET_ADDRESS ||
    parsed.info?.['owner'] !== payTo
  ) {
    return failed(
      name,
      'the account at the derived address is not a devnet USDC account for the configured recipient',
    );
  }
  if (parsed.info['state'] !== 'initialized') return failed(name, ATA_NOT_INITIALIZED);

  return ok(name, 'the derived associated token account is initialized');
}

/**
 * Asks the configured facilitator what it supports, through the upstream client.
 *
 * The wait is bounded by that client rather than here: its configuration applies a per-request
 * deadline to every `getSupported` attempt, defaulting to thirty seconds. So this call cannot hang,
 * and adding a second deadline around it would mean two different components deciding when the same
 * request has failed.
 */
export async function checkFacilitatorSupport(
  facilitatorClient: FacilitatorClient,
  network: Network,
): Promise<PreflightCheck> {
  let supported: Awaited<ReturnType<FacilitatorClient['getSupported']>>;
  try {
    supported = await facilitatorClient.getSupported();
  } catch {
    // Deliberately says nothing the remote party supplied. An exception here carries a message
    // built elsewhere, and this diagnostic is written to a terminal and kept in run notes.
    return failed(
      'facilitator supports the network',
      'the configured facilitator could not be reached or did not answer',
    );
  }
  const match = supported.kinds.find((k) => k.network === network && k.scheme === 'exact');
  return match !== undefined
    ? ok('facilitator supports the network', `exact on ${network}`)
    : failed(
        'facilitator supports the network',
        `no exact scheme advertised for ${network} by the configured facilitator`,
      );
}

/**
 * How the preflight obtains the payer key.
 *
 * `create-if-absent` is what preparing a wallet means: no key yet is the ordinary first run.
 * `require-existing` is what a live run means: it must use the key that was funded, and creating a
 * fresh unfunded one would only move the failure later, into the middle of a payment.
 */
export type PayerKeyMode = 'create-if-absent' | 'require-existing';

export interface PreflightOptions {
  readonly network: Network;
  readonly payTo: string | undefined;
  readonly asset: string;
  readonly rpcUrl: string;
  readonly facilitatorClient: FacilitatorClient;
  /** Defaults to `create-if-absent`. */
  readonly payerKeyMode?: PayerKeyMode;
  /** Where the payer key file lives. Defaults to the devnet payer key. */
  readonly payerKeyPath?: string;
}

/**
 * The full preflight. Fails closed: any failed check leaves the run not ready.
 *
 * Ordered so that everything decidable locally is decided first. A misconfigured recipient or a
 * missing key is answered before a connection is opened, which keeps the failure cheap and keeps
 * the offline suites able to exercise these paths for real.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const checks = checkLocalConfiguration(options);
  if (checks.some((c) => c.status === 'failed')) {
    return { ready: false, checks };
  }

  const keyPath = options.payerKeyPath ?? PAYER_KEY_PATH;
  let payerAddress: string;
  if (options.payerKeyMode === 'require-existing') {
    const payer = await loadPayerSigner(keyPath);
    if (payer === undefined) {
      checks.push(
        failed(
          'payer key present',
          `no payer key at ${displayKeyPath(keyPath)}; run pnpm demo:devnet:prepare to create and fund one`,
        ),
      );
      return { ready: false, checks };
    }
    payerAddress = payer.address;
  } else {
    payerAddress = (await resolvePayerSigner(keyPath)).address;
  }

  // The recipient is an address by now: the local checks above refuse anything else and return
  // before reaching here. This is the last thing decidable without a connection, so it is decided
  // before one is opened.
  if (options.payTo === undefined) return { ready: false, checks, payerAddress };
  checks.push(distinctRolesCheck(options.payTo, payerAddress));
  if (checks.some((c) => c.status === 'failed')) return { ready: false, checks, payerAddress };

  const chainChecks = await checkChainState(payerAddress, options.rpcUrl);
  checks.push(...chainChecks);

  // Asked of the same endpoint the checks above just used, so an endpoint that did not answer them
  // is not asked again to learn the same thing. That is a check which did not run, and is reported
  // as one rather than as a recipient that failed.
  const genesis = chainChecks.find((c) => c.name === GENESIS_CHECK);
  checks.push(
    genesis?.status === 'failed' && genesis.detail === ENDPOINT_UNREACHABLE
      ? notEvaluated(RECIPIENT_READINESS_CHECK, 'the endpoint did not answer')
      : await checkRecipientReadiness(options.payTo, options.rpcUrl),
  );

  checks.push(await checkFacilitatorSupport(options.facilitatorClient, options.network));
  return { ready: !checks.some((c) => c.status !== 'ok' && c.status !== 'note'), checks, payerAddress };
}

/** Prints a report. The payer address is public and is the one value a person needs to fund. */
export function printReport(report: PreflightReport): void {
  console.log('\nDevnet preflight\n');
  if (report.payerAddress !== undefined) console.log(`  payer address : ${report.payerAddress}\n`);
  for (const check of report.checks) {
    const mark =
      check.status === 'ok'
        ? 'ok  '
        : check.status === 'failed'
          ? 'FAIL'
          : check.status === 'note'
            ? 'note'
            : 'skip';
    console.log(`  ${mark}  ${check.name}: ${check.detail}`);
  }
  if (!report.ready) {
    console.log(`\nNot ready. Resolve the failures above.\n  ${FUNDING_INSTRUCTIONS}\n`);
    return;
  }
  console.log('\nReady. The devnet demonstration can run.\n');
}

/**
 * A note that a preflight once passed. It is convenience, and nothing else.
 *
 * It records a moment that has already gone: funds get spent, endpoints change, a facilitator drops
 * a network, a key file is edited. Treating this file as permission to sign would mean deciding a
 * live run against conditions that were true earlier and may not be true now, and the file itself
 * is an ordinary writable file that anything on the machine could create. So nothing is authorized
 * by its presence: the live run repeats the whole preflight against current conditions, and this
 * only tells a person whether they have prepared a wallet before.
 */
export const PREFLIGHT_MARKER_PATH = join(APP_ROOT, '.local', 'devnet-preflight.json');

export function recordPreflightPass(payerAddress: string): void {
  mkdirSync(dirname(PREFLIGHT_MARKER_PATH), { recursive: true });
  writeFileSync(
    PREFLIGHT_MARKER_PATH,
    `${JSON.stringify({ payerAddress, passedAtUnixSeconds: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
  );
}

/** Read the marker. Its absence means nobody has prepared a wallet here, not that a run is unsafe. */
export function readPreflightPass(): { payerAddress: string; passedAtUnixSeconds: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(PREFLIGHT_MARKER_PATH, 'utf8')) as {
      payerAddress?: string;
      passedAtUnixSeconds?: number;
    };
    if (typeof parsed.payerAddress === 'string' && typeof parsed.passedAtUnixSeconds === 'number') {
      return { payerAddress: parsed.payerAddress, passedAtUnixSeconds: parsed.passedAtUnixSeconds };
    }
  } catch {
    // Absent or unreadable. It carries no authority either way, so there is nothing to report.
  }
  return undefined;
}

/** Entry point for `demo:devnet:prepare`. */
export async function main(): Promise<void> {
  const { HTTPFacilitatorClient } = await import('@x402/core/server');
  const report = await runPreflight({
    network: SOLANA_DEVNET_CAIP2,
    payTo: process.env['PEAC_EXAMPLE_PAY_TO'],
    asset: USDC_DEVNET_ADDRESS,
    rpcUrl: process.env['PEAC_EXAMPLE_RPC_URL'] ?? DEVNET_RPC_URL,
    facilitatorClient: new HTTPFacilitatorClient(),
  });
  printReport(report);
  if (!report.ready) process.exit(1);
  recordPreflightPass(report.payerAddress!);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
