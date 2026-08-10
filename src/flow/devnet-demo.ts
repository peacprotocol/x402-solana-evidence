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
 * This file and the preflight are the only parts of the reference flow that use the network.
 */
import { readFileSync } from 'node:fs';
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
} from '@x402/extensions/payment-identifier';
import { createPaidResource } from './server.ts';
import { fetchPaidResource } from './client.ts';
import { readPreflightPass, PREFLIGHT_MARKER_PATH } from './preflight.ts';
import { RESOURCE_PATH, RESOURCE_QUERY } from './fixture-e2e.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PAYER_KEY_PATH = join(APP_ROOT, '.local', 'keys', 'payer.json');

/** Price of one call, in devnet USDC base units. Small, because it is spent for real on devnet. */
const PRICE_BASE_UNITS = '10000';

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

  const { createKeyPairSignerFromBytes } = await import('@solana/kit');
  const payerBytes = Uint8Array.from(JSON.parse(readFileSync(PAYER_KEY_PATH, 'utf8')) as number[]);
  const payer = await createKeyPairSignerFromBytes(payerBytes);

  const facilitatorClient = new HTTPFacilitatorClient(
    process.env['PEAC_EXAMPLE_FACILITATOR_URL'] !== undefined
      ? { url: process.env['PEAC_EXAMPLE_FACILITATOR_URL'] }
      : undefined,
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
    resourceUrl: `http://127.0.0.1${RESOURCE_PATH}${RESOURCE_QUERY}`,
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
    const origin = resource.observations.at(-1);
    console.log('\nSolana exact-scheme reference flow: devnet run\n');
    console.log(`  payer address       : ${payer.address}`);
    console.log(`  recipient           : ${payTo}`);
    console.log(`  paid status         : ${result.paidStatus}`);
    console.log(`  payment status      : ${result.parsed.paymentStatus}`);
    console.log(`  lifecycle           : ${origin?.lifecycle.states.join(' -> ') ?? '(none)'}`);
    console.log(`  terminal state      : ${origin?.lifecycle.terminalState ?? '(none)'}`);
    console.log(`  transaction         : ${origin?.lifecycle.transaction ?? '(none)'}`);
    console.log('');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
