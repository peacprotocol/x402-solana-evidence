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
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS, DEVNET_RPC_URL } from '@x402/svm';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { resolvePayerSigner } from './payer-key.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Devnet SOL is only needed for the payer's own account rent and any client-side fees. */
export const MIN_SOL_LAMPORTS = 10_000_000n;
/** Enough devnet USDC to pay the demonstration price several times over. */
export const MIN_USDC_BASE_UNITS = 1_000_000n;

export const FUNDING_INSTRUCTIONS = [
  'Devnet SOL: request an airdrop for the payer address from a public Solana devnet faucet.',
  'Devnet USDC: request test USDC for the payer address from the Circle testnet faucet.',
].join('\n  ');

export type CheckStatus = 'ok' | 'failed' | 'not_evaluated';

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

/** Create or reuse the devnet payer key and report the address a person needs to fund. */
export async function resolvePayerAddress(): Promise<string> {
  return (await resolvePayerSigner()).address;
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

  const payTo = input.payTo?.trim();
  checks.push(
    payTo !== undefined && payTo.length > 0
      ? ok('recipient configured', payTo)
      : failed('recipient configured', 'no recipient address configured for the paid resource'),
  );

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

  const lamports = (await rpc.getBalance(address(payerAddress)).send()).value;
  checks.push(
    lamports >= MIN_SOL_LAMPORTS
      ? ok('payer holds devnet SOL', `${lamports} lamports`)
      : failed(
          'payer holds devnet SOL',
          `${lamports} lamports, at least ${MIN_SOL_LAMPORTS} required`,
        ),
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

export interface PreflightOptions {
  readonly network: Network;
  readonly payTo: string | undefined;
  readonly asset: string;
  readonly rpcUrl: string;
  readonly facilitatorClient: FacilitatorClient;
}

/** The full preflight. Fails closed: any failed check leaves the run not ready. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const checks = checkLocalConfiguration(options);
  if (checks.some((c) => c.status === 'failed')) {
    return { ready: false, checks };
  }
  const payerAddress = await resolvePayerAddress();
  checks.push(...(await checkChainState(payerAddress, options.rpcUrl)));
  checks.push(await checkFacilitatorSupport(options.facilitatorClient, options.network));
  return { ready: checks.every((c) => c.status === 'ok'), checks, payerAddress };
}

/** Prints a report. The payer address is public and is the one value a person needs to fund. */
export function printReport(report: PreflightReport): void {
  console.log('\nDevnet preflight\n');
  if (report.payerAddress !== undefined) console.log(`  payer address : ${report.payerAddress}\n`);
  for (const check of report.checks) {
    const mark = check.status === 'ok' ? 'ok  ' : check.status === 'failed' ? 'FAIL' : 'skip';
    console.log(`  ${mark}  ${check.name}: ${check.detail}`);
  }
  if (!report.ready) {
    console.log(`\nNot ready. Resolve the failures above.\n  ${FUNDING_INSTRUCTIONS}\n`);
    return;
  }
  console.log('\nReady. The devnet demonstration can run.\n');
}

/** Marker file recording that a preflight passed, so the live demonstration can require one. */
export const PREFLIGHT_MARKER_PATH = join(APP_ROOT, '.local', 'devnet-preflight.json');

export function recordPreflightPass(payerAddress: string): void {
  mkdirSync(dirname(PREFLIGHT_MARKER_PATH), { recursive: true });
  writeFileSync(
    PREFLIGHT_MARKER_PATH,
    `${JSON.stringify({ payerAddress, passedAtUnixSeconds: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
  );
}

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
    // No marker means no preflight has passed, which the caller treats as not ready.
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
