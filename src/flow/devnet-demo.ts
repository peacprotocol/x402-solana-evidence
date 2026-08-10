/**
 * The live devnet demonstration.
 *
 * Same origin, same middleware, same client as the offline run. Three things change: the
 * facilitator is the configured x402 facilitator instead of an in-process one, the client
 * registers the upstream SVM exact scheme with a real devnet keypair instead of a wallet
 * stand-in, and the transaction reference that appears in the evidence is a real one.
 *
 * It runs the entire preflight itself, immediately before building anything, rather than trusting
 * that one passed earlier: an earlier pass describes conditions that have had time to change, and
 * the file recording it authorizes nothing. A live run that begins without funds or against the
 * wrong endpoint produces a partial transcript, and a partial transcript of a payment is worse
 * than no transcript.
 *
 * EVIDENCE. A live run emits the same artifact set as the offline one, through the same code: the
 * capture, binding, issuance and verification path is `buildEvidence` from the offline run, called
 * with the inputs that genuinely differ (the devnet issuer key, the real clock, the request as the
 * origin observed it, the facilitator as the observation source, and no supplied record
 * identifier). It is written to `out/<runId>/`,
 * which is gitignored, because it describes one run rather than a fixture; the committed fixture
 * directory is never touched. The run then verifies what it wrote, from those files and a public
 * key alone, and fails if that verification does not pass.
 *
 * ORDER. The run identifier is allocated, both output paths are checked for collisions, and the
 * public half of the signing key is written and read back BEFORE any payment is sent. Evidence
 * nobody else can verify is not evidence, so the material a reviewer needs is produced while
 * stopping is still free rather than after devnet funds have moved.
 *
 * This file and the preflight are the only parts of the reference flow that use the network.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  printReport,
  readPreflightPass,
  runPreflight,
  PREFLIGHT_MARKER_PATH,
} from './preflight.ts';
import { loadPayerSigner } from './payer-key.ts';
import { displayKeyPath } from './key-file.ts';
import { buildEvidence, RESOURCE_PATH, RESOURCE_QUERY } from './fixture-e2e.ts';
import {
  prepareRunOutputs,
  runEvidenceDir,
  runEvidenceDisplay,
  runPublicKeyDisplay,
  runPublicKeyPath,
  writeEvidenceTransactionally,
} from './issue-record.ts';
import { resolveIssuerKey } from './issuer-key.ts';
import { SUPPLIED_KEY_CAVEAT } from './public-key-file.ts';
import { formatReport, verifyEvidence } from './verify-evidence.ts';
import type { ObservationSource } from './observe-settlement.ts';
import {
  observeTransaction,
  publicEndpointReference,
  solanaRpcSource,
} from './observe-transaction.ts';

/** Price of one call, in devnet USDC base units. Small, because it is spent for real on devnet. */
const PRICE_BASE_UNITS = '10000';

/**
 * The resource identity advertised in the x402 payment requirements.
 *
 * This is x402's own `resource` field and stays the configured value. The PEAC request binding does
 * NOT derive from it: that binds the components the origin captured from the request it actually
 * served, ephemeral port included, so the evidence describes the request that happened rather than
 * the one that was configured.
 */
const RESOURCE_URL = `http://127.0.0.1${RESOURCE_PATH}${RESOURCE_QUERY}`;

/** Decimals of the devnet USDC mint. Recorded so a reader can scale the base-unit amount. */
const USDC_DECIMALS = 6;

/**
 * Name the facilitator that answered, without carrying anything that could be a credential.
 *
 * Only the origin survives: userinfo, password, path, query and fragment are all dropped rather
 * than trusted to be harmless, because this value is written into a document meant to be
 * published. A facilitator endpoint is as likely to carry a token in its path as a node endpoint
 * is, so both go through the same reduction.
 */
export function facilitatorReference(configured: string | undefined): string {
  if (configured === undefined || configured.trim().length === 0) {
    return 'the upstream default x402 facilitator';
  }
  return publicEndpointReference(configured) ?? 'the configured x402 facilitator';
}

/**
 * Directory name for one run: the instant it started, in a filesystem-safe form.
 *
 * Derived from the start rather than from the observation, because the identifier has to exist
 * before the run reaches a payment: both output paths are claimed and the reviewer's key is
 * written while stopping is still free.
 */
function runIdFor(startedAtUnixSeconds: number): string {
  return `devnet-${new Date(startedAtUnixSeconds * 1000).toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * The exact command someone else runs against what this run wrote.
 *
 * Printed in full rather than described, because a reader who has to reconstruct the invocation
 * from prose is a reader who will not run it. The boundary is printed with it: the key travels with
 * the evidence, which makes the record checkable and establishes nothing about who signed it.
 */
function outsiderInstructions(runId: string): string {
  return [
    '',
    'Verify this evidence from the files and the key alone:',
    '',
    `  ${verificationCommand(runId)}`,
    '',
    `  ${SUPPLIED_KEY_CAVEAT}`,
    '',
  ].join('\n');
}

function verificationCommand(runId: string): string {
  return (
    `corepack pnpm@8.15.0 verify -- --evidence ${runEvidenceDisplay(runId)} ` +
    `--public-key ${runPublicKeyDisplay(runId)}`
  );
}

/**
 * The note left in the directory for whoever reads it next.
 *
 * Written inside the same staged emission as the artifacts, so a directory that exists always
 * carries its own instructions rather than depending on someone having kept the console output.
 */
function reviewerNotes(runId: string): string {
  return [
    `Evidence for devnet run ${runId}`,
    '',
    'This directory was written in full, verified, and only then moved into place. Its presence',
    'means a complete artifact set that passed verification at the moment it was written.',
    '',
    'Verify it yourself, from these files and the public key beside this directory:',
    '',
    `  ${verificationCommand(runId)}`,
    '',
    SUPPLIED_KEY_CAVEAT.split('\n  ').join('\n'),
    '',
    'Devnet is a test network. The record says so, and no output of this run describes a payment',
    'on a production network.',
    '',
  ].join('\n');
}

export async function main(): Promise<void> {
  const payTo = process.env['PEAC_EXAMPLE_PAY_TO'];
  const configuredFacilitatorUrl = process.env['PEAC_EXAMPLE_FACILITATOR_URL'];
  const facilitatorClient = new HTTPFacilitatorClient(
    configuredFacilitatorUrl !== undefined ? { url: configuredFacilitatorUrl } : undefined,
  );

  const prepared = readPreflightPass();
  if (prepared === undefined) {
    console.log(
      `\nNo record of a prepared wallet at ${displayKeyPath(PREFLIGHT_MARKER_PATH)}.` +
        '\n  If this run stops for want of funds, prepare one with: pnpm demo:devnet:prepare\n',
    );
  }

  /**
   * The whole preflight, again, here.
   *
   * Not a repetition of `demo:devnet:prepare` for its own sake: that run proved a state that has
   * since had time to change. Balances get spent, endpoints move, a facilitator stops advertising
   * a network, a key file gets edited. The conditions that matter are the ones holding now, a
   * moment before this process builds and signs a payment, so they are established now. The marker
   * file above says only whether someone has prepared a wallet here; it authorizes nothing.
   *
   * The payer key must already exist. A live run has to use the key that was funded, and quietly
   * creating a fresh one would turn a clear stop here into a failure mid-payment.
   */
  const report = await runPreflight({
    network: SOLANA_DEVNET_CAIP2,
    payTo,
    asset: USDC_DEVNET_ADDRESS,
    rpcUrl: process.env['PEAC_EXAMPLE_RPC_URL'] ?? DEVNET_RPC_URL,
    facilitatorClient,
    payerKeyMode: 'require-existing',
  });
  printReport(report);
  if (!report.ready) {
    console.error('The live run stops here. Nothing was built, signed or sent.\n');
    process.exit(1);
  }

  // Both established by the preflight that just passed: the recipient is a valid address, and the
  // payer key exists. Narrowed rather than re-checked, so there is one place that decides.
  if (payTo === undefined) throw new Error('the preflight passed without a recipient');
  const payer = await loadPayerSigner();
  if (payer === undefined) throw new Error('the preflight passed without a payer key');

  /**
   * Everything a reviewer will need, claimed and written before a payment can be sent.
   *
   * The run identifier comes from the start of the run rather than from the settlement, so both
   * output paths can be checked for collisions and the public half of the signing key can be
   * written and read back while stopping still costs nothing. After this point a failure can leave
   * a key file without a directory, which is public material describing an incomplete run; it can
   * never leave a directory whose key was never written.
   */
  const runId = runIdFor(Math.floor(Date.now() / 1000));
  const display = runEvidenceDisplay(runId);
  const issuerKey = await resolveIssuerKey('devnet');
  const reviewerKey = prepareRunOutputs({
    evidenceDirectory: runEvidenceDir(runId),
    publicKeyFile: runPublicKeyPath(runId),
    issuerKey,
  });
  console.log(`\n  verification key    : ${runPublicKeyDisplay(runId)}`);

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
  const { address, port } = server.address() as AddressInfo;

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
     * The request this run served, as the origin observed it.
     *
     * Required rather than optional. A live run whose request the component profile refuses to
     * describe has nothing honest to bind, and falling back to the configured resource identity
     * would put a value in the evidence that no request produced.
     */
    const components = origin.components;
    if (components === undefined) {
      throw new Error('the origin could not describe the request it served as RFC 9421 components');
    }

    /**
     * The evidence for this run, built by the offline run's own path.
     *
     * What is supplied here is exactly what a live run cannot share with the fixture: the devnet
     * issuer key, the real clock, the observed request, the facilitator as the observation source,
     * and no record identifier, because a run that happened once has no bytes to reproduce.
     */
    const observedAtUnixSeconds = Math.floor(Date.now() / 1000);
    const observationSource: ObservationSource = {
      kind: 'facilitator',
      reference: facilitatorReference(configuredFacilitatorUrl),
    };

    /**
     * A second observer of the same settlement, asked only once one has happened.
     *
     * The facilitator is a party to the payment. Asking a node as well does not make the payment
     * more true; it records what a separate observer said, kept separate in the document. An
     * endpoint that is unreachable or does not know the transaction costs this run nothing: the
     * observation is recorded as unavailable and the evidence is emitted either way.
     */
    const settledTransaction = origin.lifecycle.transaction;
    const rpcObservation =
      settledTransaction === undefined
        ? undefined
        : await observeTransaction({
            source: solanaRpcSource(process.env['PEAC_EXAMPLE_RPC_URL'] ?? DEVNET_RPC_URL),
            transactionSignature: settledTransaction,
            observedAtUnixSeconds,
          });
    if (rpcObservation !== undefined) console.log(`  rpc observation     : ${rpcObservation.statement}`);

    const paymentReference = extractPaymentIdentifier(result.paymentPayload);
    const layout = await buildEvidence(
      {
        client: result,
        challenge,
        origin,
        terminalState: origin.lifecycle.terminalState,
        listenerAuthority: `${address}:${port}`,
      },
      {
        mode: 'devnet',
        requestIdentity: { kind: 'observed', components },
        requestBody: new Uint8Array(0),
        observedAtUnixSeconds,
        observationSource,
        ...(rpcObservation !== undefined ? { rpcObservation } : {}),
        assetDecimals: USDC_DECIMALS,
        ...(paymentReference !== null ? { paymentReference } : {}),
        currency: 'USDC',
        // Devnet is a test network, and the record says so rather than reading as a live payment.
        environment: 'test',
      },
    );

    /**
     * Written so that the directory is either complete or absent.
     *
     * Everything below happens in a staging directory beside the destination: the artifacts, the
     * verification an outside reader would perform, the report, and the note telling a reader how
     * to repeat it. Only once all of that has succeeded does a single rename put it in place, so
     * `out/<runId>/` existing means a complete and verified set rather than however far a run got.
     */
    await writeEvidenceTransactionally({
      finalDirectory: runEvidenceDir(runId),
      layout,
      finalize: async (staged) => {
        // Verified the way an outside reader would: from the files just written and the key file
        // written before the payment, with no access to the state the run still holds in memory.
        const report = await verifyEvidence(staged, reviewerKey.publicKey, {
          algorithm: reviewerKey.algorithm,
          kid: reviewerKey.kid,
          issuer: reviewerKey.issuer,
        });
        writeFileSync(join(staged, 'verification-report.txt'), formatReport(display, report).trimStart());
        writeFileSync(join(staged, 'how-to-verify.txt'), reviewerNotes(runId));
        console.log(formatReport(display, report));
        if (!report.ok) throw new Error('the evidence written by this run did not verify');
      },
    });
    console.log(`  evidence            : ${display}`);
    console.log(outsiderInstructions(runId));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
