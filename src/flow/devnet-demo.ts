/**
 * The live devnet demonstration.
 *
 * Same origin, same middleware, same client as the offline run. Three things change: the
 * facilitator is the configured x402 facilitator instead of an in-process one, the client
 * registers the upstream SVM exact scheme with a real devnet keypair instead of a wallet
 * stand-in, and the transaction reference that appears in the evidence is a real one.
 *
 * It refuses to start unless a preflight has passed. A live run that begins without funds or
 * against the wrong endpoint produces a partial transcript, and a partial transcript of a payment
 * is worse than no transcript.
 *
 * EVIDENCE. A live run emits the same artifact set as the offline one, through the same code: the
 * capture, binding, issuance and verification path is `buildEvidence` from the offline run, called
 * with the inputs that genuinely differ (the devnet issuer key, the real clock, the facilitator as
 * the observation source, and no supplied record identifier). It is written to `out/<runId>/`,
 * which is gitignored, because it describes one run rather than a fixture; the committed fixture
 * directory is never touched. The run then verifies what it wrote, from those files and a public
 * key alone, and fails if that verification does not pass.
 *
 * This file and the preflight are the only parts of the reference flow that use the network.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS, DEVNET_RPC_URL, toClientSvmSigner } from '@x402/svm';
import { registerExactSvmScheme as registerServerScheme } from '@x402/svm/exact/server';
import { registerExactSvmScheme as registerClientScheme } from '@x402/svm/exact/client';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} from '@x402/extensions/payment-identifier';
import { createPaidResource, type RequestObservation } from './server.ts';
import { fetchPaidResource } from './client.ts';
import { readPreflightPass, PREFLIGHT_MARKER_PATH } from './preflight.ts';
import { displayKeyPath, loadPayerSigner, PAYER_KEY_PATH } from './payer-key.ts';
import { buildEvidence, RESOURCE_PATH, RESOURCE_QUERY } from './fixture-e2e.ts';
import { runEvidenceDir, runEvidenceDisplay, writeEvidence } from './issue-record.ts';
import { resolveIssuerKey } from './issuer-key.ts';
import { formatReport, verifyEvidence } from './verify-evidence.ts';
import type { ObservationSource } from './observe-settlement.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Price of one call, in devnet USDC base units. Small, because it is spent for real on devnet. */
const PRICE_BASE_UNITS = '10000';

/**
 * The resource's configured identity, which is what reaches the evidence.
 *
 * The origin listens on an ephemeral port, but no bound value derives from it: the binding
 * describes the resource this run configured, not the socket the process happened to receive.
 */
const RESOURCE_URL = `http://127.0.0.1${RESOURCE_PATH}${RESOURCE_QUERY}`;

/** Decimals of the devnet USDC mint. Recorded so a reader can scale the base-unit amount. */
const USDC_DECIMALS = 6;

/**
 * Name the facilitator that answered, without carrying anything that could be a credential.
 *
 * Only the origin and path survive: userinfo, query and fragment are dropped rather than trusted to
 * be harmless, because this value is written into a document meant to be published.
 */
function facilitatorReference(configured: string | undefined): string {
  if (configured === undefined || configured.trim().length === 0) {
    return 'the upstream default x402 facilitator';
  }
  try {
    const url = new URL(configured);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'the configured x402 facilitator';
  }
}

/** Directory name for one run: the instant it was observed, in a filesystem-safe form. */
function runIdFor(observedAtUnixSeconds: number): string {
  return `devnet-${new Date(observedAtUnixSeconds * 1000).toISOString().replace(/[:.]/g, '-')}`;
}

export async function main(): Promise<void> {
  const preflight = readPreflightPass();
  if (preflight === undefined) {
    console.error(
      '\nNo passed preflight found.\n' +
        '  Run: pnpm demo:devnet:prepare\n' +
        `  It records its result at ${PREFLIGHT_MARKER_PATH.replace(APP_ROOT, '.')}\n`,
    );
    process.exit(1);
  }

  const payTo = process.env['PEAC_EXAMPLE_PAY_TO'];
  if (payTo === undefined || payTo.trim().length === 0) {
    console.error('\nPEAC_EXAMPLE_PAY_TO is not set. It must name the recipient address.\n');
    process.exit(1);
  }

  // Loaded, never created here: a live run uses the funded key the preflight prepared, and a
  // freshly created one would be unfunded and would fail partway through.
  const payer = await loadPayerSigner();
  if (payer === undefined) {
    console.error(
      `\nNo payer key at ${displayKeyPath(PAYER_KEY_PATH)}.\n  Run: pnpm demo:devnet:prepare\n`,
    );
    process.exit(1);
  }

  const configuredFacilitatorUrl = process.env['PEAC_EXAMPLE_FACILITATOR_URL'];
  const facilitatorClient = new HTTPFacilitatorClient(
    configuredFacilitatorUrl !== undefined ? { url: configuredFacilitatorUrl } : undefined,
  );

  const resource = await createPaidResource({
    facilitatorClient,
    registerSchemes: (server) => {
      registerServerScheme(server, {
        networks: [SOLANA_DEVNET_CAIP2],
        rpcUrl: process.env['PEAC_EXAMPLE_RPC_URL'] ?? DEVNET_RPC_URL,
      });
    },
    network: SOLANA_DEVNET_CAIP2,
    payTo,
    price: { asset: USDC_DEVNET_ADDRESS, amount: PRICE_BASE_UNITS },
    method: 'GET',
    path: RESOURCE_PATH,
    resourceUrl: RESOURCE_URL,
    maxTimeoutSeconds: 60,
    declaredExtensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    handler: () => ({
      status: 200,
      contentType: 'application/json',
      // Synthetic and non-sensitive on purpose, so the whole run can be published for review.
      body: new TextEncoder().encode(
        JSON.stringify({ region: 'alpha', units: 'metric', source: 'reference example' }),
      ),
    }),
  });

  const server = resource.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const result = await fetchPaidResource(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        network: SOLANA_DEVNET_CAIP2,
        registerSchemes: (client) => {
          registerClientScheme(client, {
            signer: toClientSvmSigner(payer),
            networks: [SOLANA_DEVNET_CAIP2],
          });
        },
      },
      `${RESOURCE_PATH}${RESOURCE_QUERY}`,
    );

    // The unpaid challenge and the paid retry, in arrival order. The evidence describes the retry
    // and binds the challenge the origin emitted, so both are needed and neither is inferred.
    if (resource.observations.length !== 2) {
      throw new Error(`expected two origin observations, recorded ${resource.observations.length}`);
    }
    const [challenge, origin] = resource.observations as readonly [
      RequestObservation,
      RequestObservation,
    ];

    console.log('\nSolana exact-scheme reference flow: devnet run\n');
    console.log(`  payer address       : ${payer.address}`);
    console.log(`  recipient           : ${payTo}`);
    console.log(`  paid status         : ${result.paidStatus}`);
    console.log(`  payment status      : ${result.parsed.paymentStatus}`);
    console.log(`  lifecycle           : ${origin.lifecycle.states.join(' -> ')}`);
    console.log(`  terminal state      : ${origin.lifecycle.terminalState}`);
    console.log(`  transaction         : ${origin.lifecycle.transaction ?? '(none)'}`);

    /**
     * The evidence for this run, built by the offline run's own path.
     *
     * What is supplied here is exactly what a live run cannot share with the fixture: the devnet
     * issuer key, the real clock, the facilitator as the observation source, and no record
     * identifier, because a run that happened once has no bytes to reproduce.
     */
    const observedAtUnixSeconds = Math.floor(Date.now() / 1000);
    const observationSource: ObservationSource = {
      kind: 'facilitator',
      reference: facilitatorReference(configuredFacilitatorUrl),
    };
    const paymentReference = extractPaymentIdentifier(result.paymentPayload);
    const layout = await buildEvidence(
      { client: result, challenge, origin, terminalState: origin.lifecycle.terminalState },
      {
        mode: 'devnet',
        resourceUrl: RESOURCE_URL,
        requestBody: new Uint8Array(0),
        observedAtUnixSeconds,
        observationSource,
        assetDecimals: USDC_DECIMALS,
        ...(paymentReference !== null ? { paymentReference } : {}),
        currency: 'USDC',
        // Devnet is a test network, and the record says so rather than reading as a live payment.
        environment: 'test',
      },
    );

    const runId = runIdFor(observedAtUnixSeconds);
    const directory = runEvidenceDir(runId);
    const display = runEvidenceDisplay(runId);
    writeEvidence(directory, layout);
    console.log(`  evidence            : ${display}`);

    // Verified the way an outside reader would: from the files just written and a public key,
    // with no access to the state the run still holds in memory.
    const issuerKey = await resolveIssuerKey('devnet');
    const report = await verifyEvidence(directory, issuerKey.publicKey);
    writeFileSync(
      join(directory, 'verification-report.txt'),
      formatReport(display, report).trimStart(),
    );
    console.log(formatReport(display, report));
    if (!report.ok) throw new Error('the evidence written by this run did not verify');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
