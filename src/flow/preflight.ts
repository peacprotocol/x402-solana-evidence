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
import { isAddress } from '@solana/kit';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { displayKeyPath } from './key-file.ts';
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

/** Balance and network-identity checks. Opens connections; never called by the offline path. */
export async function checkChainState(payerAddress: string, rpcUrl: string): Promise<PreflightCheck[]> {
  const { createSolanaRpc, address } = await import('@solana/kit');
  const rpc = createSolanaRpc(rpcUrl);
  const checks: PreflightCheck[] = [];

  const genesisHash = await rpc.getGenesisHash().send();
  const derivedCaip2 = `solana:${String(genesisHash).slice(0, 32)}`;
  checks.push(
    derivedCaip2 === SOLANA_DEVNET_CAIP2
      ? ok('endpoint genesis matches devnet', derivedCaip2)
      : failed(
          'endpoint genesis matches devnet',
          `endpoint reports ${derivedCaip2}, expected ${SOLANA_DEVNET_CAIP2}`,
        ),
  );

  // Reported, not required: the facilitator pays the transaction fee, so a payer with no SOL can
  // still complete this flow. See the note at the top of this file for where that is decided.
  const lamports = (await rpc.getBalance(address(payerAddress)).send()).value;
  checks.push(
    note('payer SOL balance', `${lamports} lamports, not required for this flow`),
  );

  const tokenAccounts = await rpc
    .getTokenAccountsByOwner(
      address(payerAddress),
      { mint: address(USDC_DEVNET_ADDRESS) },
      { encoding: 'jsonParsed' },
    )
    .send();
  let usdc = 0n;
  for (const account of tokenAccounts.value) {
    const parsed = account.account.data.parsed as {
      info?: { tokenAmount?: { amount?: string } };
    };
    usdc += BigInt(parsed.info?.tokenAmount?.amount ?? '0');
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

/** Asks the configured facilitator what it supports, through the upstream client. */
export async function checkFacilitatorSupport(
  facilitatorClient: FacilitatorClient,
  network: Network,
): Promise<PreflightCheck> {
  let supported: Awaited<ReturnType<FacilitatorClient['getSupported']>>;
  try {
    supported = await facilitatorClient.getSupported();
  } catch (e) {
    return failed('facilitator supports the network', (e as Error).message.split('\n')[0] ?? 'unreachable');
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

  checks.push(...(await checkChainState(payerAddress, options.rpcUrl)));
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
