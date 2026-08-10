/**
 * Preflight cases: what a live run decides before it is allowed to touch a network.
 *
 * A live run stops for local reasons more often than for remote ones, and those reasons are all
 * knowable without a connection: no key, a recipient that is not an address, a network this
 * example does not support. Deciding them first makes the failure cheap, keeps the diagnosis
 * exact, and, since money and a chain are involved by the next step, keeps the stop somewhere
 * harmless.
 *
 * It also makes them testable. Everything here runs offline, and the facilitator supplied to the
 * preflight records whether it was asked anything: a case that claims a run stopped before any
 * network call proves it, rather than asserting it.
 *
 * The successful live path is not here and cannot be. It needs a real chain and a real
 * facilitator, and it stays a recorded acceptance run under SVM-FLOW-004.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from '@x402/svm';
import type { FacilitatorClient } from '@x402/core/server';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { checkLocalConfiguration, runPreflight, type PreflightCheck } from './flow/preflight.ts';
import { createPayerKeyFile } from './flow/payer-key.ts';

beginAcceptanceSuite('preflight');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const workspace = mkdtempSync(join(tmpdir(), 'peac-preflight-'));

/** A recipient that is genuinely a Solana address, so recipient checks are not what fails. */
const VALID_RECIPIENT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/**
 * A facilitator that answers nothing and remembers whether it was asked.
 *
 * Being asked at all is the failure these cases look for, so it never needs to answer: reaching it
 * already means the run went past the point where it should have stopped.
 */
function watchfulFacilitator(): { client: FacilitatorClient; asked: () => boolean } {
  let wasAsked = false;
  const client = {
    getSupported: async () => {
      wasAsked = true;
      throw new Error('the preflight reached the facilitator');
    },
  } as unknown as FacilitatorClient;
  return { client, asked: () => wasAsked };
}

/** An endpoint that no test may contact. If a case reaches it, the case has already failed. */
const UNREACHABLE_RPC_URL = 'http://127.0.0.1:1/must-not-be-called';

const named = (checks: readonly PreflightCheck[], name: string): PreflightCheck | undefined =>
  checks.find((c) => c.name === name);

console.log('\nPreflight: stopping before the network\n');

recordExecution('PRE-RV-001');
{
  const { client, asked } = watchfulFacilitator();
  const report = await runPreflight({
    network: SOLANA_DEVNET_CAIP2,
    payTo: VALID_RECIPIENT,
    asset: USDC_DEVNET_ADDRESS,
    rpcUrl: UNREACHABLE_RPC_URL,
    facilitatorClient: client,
    payerKeyMode: 'require-existing',
    payerKeyPath: join(workspace, 'absent', 'payer.json'),
  });

  check('a live run without a payer key is not ready', report.ready === false);
  check(
    'it says the payer key is missing',
    named(report.checks, 'payer key present')?.status === 'failed',
    report.checks.map((c) => `${c.name}=${c.status}`).join(', '),
  );
  check('it points at the command that prepares one', (named(report.checks, 'payer key present')?.detail ?? '').includes('demo:devnet:prepare'));
  check('it never asked the facilitator anything', asked() === false);
  check(
    'it never reached the chain checks',
    named(report.checks, 'endpoint genesis matches devnet') === undefined &&
      named(report.checks, 'payer holds devnet USDC') === undefined,
  );
  check('and it reports no payer address, because there is none', report.payerAddress === undefined);
}

recordExecution('PRE-RV-002');
{
  // A payer key exists here, so the recipient is unambiguously what stops the run.
  const payerKeyPath = join(workspace, 'funded-payer.json');
  await createPayerKeyFile(payerKeyPath);
  const { client, asked } = watchfulFacilitator();
  const report = await runPreflight({
    network: SOLANA_DEVNET_CAIP2,
    payTo: 'not-an-address',
    asset: USDC_DEVNET_ADDRESS,
    rpcUrl: UNREACHABLE_RPC_URL,
    facilitatorClient: client,
    payerKeyMode: 'require-existing',
    payerKeyPath,
  });

  check('a live run with an invalid recipient is not ready', report.ready === false);
  check(
    'it says the recipient is not an address',
    named(report.checks, 'recipient is a Solana address')?.status === 'failed',
  );
  check('it never asked the facilitator anything', asked() === false);
  check(
    'it never reached the chain checks',
    named(report.checks, 'endpoint genesis matches devnet') === undefined,
  );
  check(
    'it did not read the payer key either, having already stopped',
    report.payerAddress === undefined,
  );
}

console.log('\nPreflight: which recipients are addresses\n');

/**
 * Run the local configuration checks against one recipient.
 *
 * @param payTo - The configured recipient, exactly as it would arrive from the environment.
 */
const recipientResult = (payTo: string | undefined): PreflightCheck | undefined =>
  named(
    checkLocalConfiguration({
      network: SOLANA_DEVNET_CAIP2,
      payTo,
      asset: USDC_DEVNET_ADDRESS,
    }),
    'recipient is a Solana address',
  );

recordExecution('PRE-ADDR-001');
{
  const result = recipientResult(VALID_RECIPIENT);
  check('a valid Solana address is accepted', result?.status === 'ok', result?.detail);
  check('the accepted value is the one that was configured', result?.detail === VALID_RECIPIENT);
}

recordExecution('PRE-ADDR-002');
{
  // Right length, wrong alphabet: base58 has no 0, O, I or l, so this can never decode.
  const result = recipientResult('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl');
  check('a recipient that is not valid base58 is rejected', result?.status === 'failed', result?.detail);
}

recordExecution('PRE-ADDR-003');
{
  const short = recipientResult('4zMMC9srt5Ri5X14');
  const long = recipientResult(`${VALID_RECIPIENT}${VALID_RECIPIENT}`);
  check('a recipient that is too short is rejected', short?.status === 'failed', short?.detail);
  check('a recipient that is too long is rejected', long?.status === 'failed', long?.detail);
}

recordExecution('PRE-ADDR-004');
{
  const trailing = recipientResult(`${VALID_RECIPIENT} `);
  const leading = recipientResult(` ${VALID_RECIPIENT}`);
  const newline = recipientResult(`${VALID_RECIPIENT}\n`);

  // Refused rather than trimmed: trimming guesses at the intent and can pay a different address
  // than the one that was written down.
  check('a recipient with a trailing space is rejected', trailing?.status === 'failed');
  check('a recipient with a leading space is rejected', leading?.status === 'failed');
  check('a recipient with a trailing newline is rejected', newline?.status === 'failed');
  check(
    'the message says whitespace, rather than blaming the address',
    (trailing?.detail ?? '').includes('whitespace'),
    trailing?.detail,
  );
  check('an absent recipient is rejected', recipientResult(undefined)?.status === 'failed');
  check('an empty recipient is rejected', recipientResult('')?.status === 'failed');
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
