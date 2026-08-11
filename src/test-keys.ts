/**
 * Key persistence cases.
 *
 * A key that cannot be reloaded is worse than no key: the failure appears only on a live run, once
 * money and a network are already involved. These cases therefore exercise the whole cycle for
 * both keys the example holds, from creation through the file on disk and back to a usable signer,
 * and they finish by signing with the reloaded key and verifying that signature under the public
 * key that was persisted alongside it. Reading a file back is not evidence that the key survived;
 * producing a signature that verifies is.
 *
 * The second half asks the opposite question: what happens to a key file that exists but cannot be
 * loaded. The answer has to be that it is refused and left alone, because the alternative, treating
 * every failure as a first run, silently replaces a key that may hold funds. Each case damages a
 * file in a different way and asserts both that the attempt fails and that the file's bytes are
 * unchanged afterwards.
 *
 * Every case runs against a temporary directory, never the real key files, so running the suite
 * can neither read nor disturb a funded devnet key.
 *
 * These cases need no network. Generating a key is local computation, and nothing here contacts a
 * chain, a faucet or a facilitator.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddressEncoder } from '@solana/kit';
import { derivePublicKey, ed25519Verify } from '@peac/crypto';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { createPayerKeyFile, loadPayerSigner, resolvePayerSigner } from './flow/payer-key.ts';
import {
  DEVNET_ISSUER_ENV,
  IssuerBindingError,
  IssuerConfigurationError,
  resolveIssuerKey,
} from './flow/issuer-key.ts';
import { InvalidKeyFileError } from './flow/key-file.ts';

beginAcceptanceSuite('keys');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const workspace = mkdtempSync(join(tmpdir(), 'peac-keys-'));
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Verify an Ed25519 signature with the platform, given only the raw public key bytes. */
async function verifyWithPublicKeyBytes(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(publicKey), 'Ed25519', false, [
    'verify',
  ]);
  return crypto.subtle.verify('Ed25519', key, Uint8Array.from(signature), Uint8Array.from(message));
}

console.log('\nKey persistence\n');

{
  // The pinned upstream fact this design exists for, asserted rather than assumed. A signer from
  // `generateKeyPairSigner` holds a non-extractable private key, so its bytes can never be written
  // to a file; creation here starts from private-key bytes instead. If a future release changes
  // this, the check fails and the decision gets revisited deliberately.
  const { generateKeyPairSigner } = await import('@solana/kit');
  const generated = await generateKeyPairSigner();
  check(
    'a generated signer holds a private key that cannot be exported',
    generated.keyPair.privateKey.extractable === false,
  );
  let exportRefused = false;
  try {
    await crypto.subtle.exportKey('pkcs8', generated.keyPair.privateKey);
  } catch {
    exportRefused = true;
  }
  check('exporting that private key is refused', exportRefused);
}

recordExecution('KEY-RT-001');
{
  const path = join(workspace, 'payer-roundtrip.json');
  const created = await createPayerKeyFile(path);
  const reloaded = await loadPayerSigner(path);

  check('a created payer key can be reloaded', reloaded !== undefined);
  check(
    'the reloaded payer key has the address it was created with',
    reloaded?.address === created.address,
    `created ${created.address}, reloaded ${reloaded?.address ?? '(nothing)'}`,
  );

  // The stored form is what Solana tooling expects, and the check that matters is that the two
  // halves belong together: the reload above rejects a public half that does not match.
  const stored = JSON.parse(readFileSync(path, 'utf8')) as number[];
  check('the key file holds the 64-byte secret key', stored.length === 64, `${stored.length} bytes`);
  check(
    'the stored public half is the address of the stored private half',
    bytesEqual(
      Uint8Array.from(stored.slice(32)),
      Uint8Array.from(getAddressEncoder().encode(created.address)),
    ),
  );
}

recordExecution('KEY-RT-002');
{
  const path = join(workspace, 'payer-signing.json');
  const created = await createPayerKeyFile(path);
  const reloaded = await loadPayerSigner(path);
  if (reloaded === undefined) throw new Error('the payer key written by this case did not reload');

  const message = new TextEncoder().encode('payment evidence key round trip');
  const [signatures] = await reloaded.signMessages([{ content: message, signatures: {} }]);
  const signature = signatures?.[reloaded.address];
  check('the reloaded payer key produces a signature', signature !== undefined);

  // Verified against the public key taken from the file, not from the object that signed: the
  // question is whether what was persisted still describes the key that is signing.
  const storedPublicKey = Uint8Array.from(
    (JSON.parse(readFileSync(path, 'utf8')) as number[]).slice(32),
  );
  const verified =
    signature !== undefined &&
    (await verifyWithPublicKeyBytes(storedPublicKey, signature, message));
  check('that signature verifies under the persisted public key', verified === true);
  check('signing did not change the address', reloaded.address === created.address);

  const otherMessage = new TextEncoder().encode('payment evidence key round trip.');
  const verifiedOther =
    signature !== undefined &&
    (await verifyWithPublicKeyBytes(storedPublicKey, signature, otherMessage));
  check('that signature does not verify over a different message', verifiedOther === false);
}

recordExecution('KEY-RT-003');
{
  const path = join(workspace, 'issuer-roundtrip.json');
  const created = await resolveIssuerKey('devnet', path);
  const reloaded = await resolveIssuerKey('devnet', path);

  check('the reloaded issuer key has the same private key', bytesEqual(reloaded.privateKey, created.privateKey));
  check('the reloaded issuer key has the same public key', bytesEqual(reloaded.publicKey, created.publicKey));
  check('the reloaded issuer key keeps its key identifier', reloaded.kid === created.kid);
  check(
    'the reloaded public key is the one derived from the reloaded private key',
    bytesEqual(reloaded.publicKey, await derivePublicKey(reloaded.privateKey)),
  );

  // The issuer key exists to sign records, so the round trip ends at a signature rather than at a
  // byte comparison.
  const { ed25519Sign } = await import('@peac/crypto');
  const message = new TextEncoder().encode('payment evidence issuer round trip');
  const signature = await ed25519Sign(message, reloaded.privateKey);
  check(
    'a record signed by the reloaded issuer key verifies under the created public key',
    await ed25519Verify(signature, message, created.publicKey),
  );
}

// ---------------------------------------------------------------------------------------------
// The issuer a key claims.
// ---------------------------------------------------------------------------------------------

console.log('\nThe issuer a stored key claims\n');

/** Run something with the configured issuer set, and put the environment back afterwards. */
async function withConfiguredIssuer<T>(issuer: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[DEVNET_ISSUER_ENV];
  process.env[DEVNET_ISSUER_ENV] = issuer;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[DEVNET_ISSUER_ENV];
    else process.env[DEVNET_ISSUER_ENV] = previous;
  }
}

/** What the attempt produced, without letting a refusal end the suite. */
async function issuerKeyAttempt(
  issuer: string,
  path: string,
): Promise<{ readonly key?: Awaited<ReturnType<typeof resolveIssuerKey>>; readonly thrown?: unknown }> {
  try {
    return { key: await withConfiguredIssuer(issuer, () => resolveIssuerKey('devnet', path)) };
  } catch (e) {
    return { thrown: e };
  }
}

const digestOf = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const FIRST_ISSUER = 'https://issuer-one.example.test';
const SECOND_ISSUER = 'https://issuer-two.example.test';

/**
 * ISS-BIND-001. Creating the key records the issuer it will claim.
 *
 * Without this the file describes a key and nothing else, and the issuer a record claims comes from
 * whatever the environment said at the moment of signing.
 */
recordExecution('ISS-BIND-001');
{
  const path = join(workspace, 'issuer-binding-created.json');
  const created = await withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', path));
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

  check('the created key claims the configured issuer', created.iss === FIRST_ISSUER, created.iss);
  check('and the key file records it', stored['issuer'] === FIRST_ISSUER, String(stored['issuer']));
  check(
    'the file is readable by its owner only',
    (statSync(path).mode & 0o777) === 0o600,
    (statSync(path).mode & 0o777).toString(8),
  );
}

/** ISS-BIND-002. Reloading under the issuer it recorded returns the same key. */
recordExecution('ISS-BIND-002');
{
  const path = join(workspace, 'issuer-binding-reload.json');
  const created = await withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', path));
  const reloaded = await withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', path));

  check('the same issuer reloads the same key', bytesEqual(reloaded.privateKey, created.privateKey));
  check('with the same key identifier', reloaded.kid === created.kid);
  check('and the same issuer claim', reloaded.iss === FIRST_ISSUER, reloaded.iss);
}

/**
 * ISS-BIND-003 and ISS-BIND-004. The same key, configured for a different issuer.
 *
 * The refusal is the point, and so is what it leaves behind: one key claiming two issuers would
 * produce records that verify under one public key while naming two different parties. Nothing is
 * migrated, nothing is regenerated, and the file is compared byte for byte afterwards, because a
 * loader that rewrote the issuer to match would pass a "did it throw" check just as easily.
 */
recordExecution('ISS-BIND-003');
recordExecution('ISS-BIND-004');
{
  const path = join(workspace, 'issuer-binding-mismatch.json');
  const created = await withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', path));
  const before = digestOf(path);

  const attempt = await issuerKeyAttempt(SECOND_ISSUER, path);
  check('a different configured issuer is refused', attempt.key === undefined);
  check(
    'it is refused as an issuer binding failure',
    attempt.thrown instanceof IssuerBindingError,
    attempt.thrown instanceof Error ? attempt.thrown.message.split('\n')[0] : String(attempt.thrown),
  );
  check(
    'the message names both issuers without choosing between them',
    attempt.thrown instanceof IssuerBindingError &&
      attempt.thrown.storedIssuer === FIRST_ISSUER &&
      attempt.thrown.configuredIssuer === SECOND_ISSUER,
  );
  check(
    'and says the file was not modified',
    attempt.thrown instanceof Error && attempt.thrown.message.includes('It was not modified'),
  );
  check('the key file is byte-identical afterwards', digestOf(path) === before);
  check(
    'and it still loads as the key it was, under the issuer it records',
    bytesEqual(
      (await withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', path))).privateKey,
      created.privateKey,
    ),
  );
}

/**
 * ISS-BIND-005. A key file written before the issuer was recorded.
 *
 * What issuer that key has already claimed is not in the file, and the currently configured one is
 * a guess. It is refused with what to do about it, and left alone.
 */
recordExecution('ISS-BIND-005');
{
  const path = join(workspace, 'issuer-binding-legacy.json');
  const source = await withConfiguredIssuer(FIRST_ISSUER, () =>
    resolveIssuerKey('devnet', join(workspace, 'issuer-binding-legacy-source.json')),
  );
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        note: 'Demonstration key for a test network. Not an organizational identity.',
        kid: 'payment-evidence-devnet-legacy',
        privateKeyHex: Buffer.from(source.privateKey).toString('hex'),
      },
      null,
      2,
    )}\n`,
  );
  const before = digestOf(path);

  const attempt = await issuerKeyAttempt(FIRST_ISSUER, path);
  check('a key file recording no issuer is refused', attempt.key === undefined);
  check(
    'it is refused as an invalid key file rather than by assuming the configured issuer',
    attempt.thrown instanceof InvalidKeyFileError,
    attempt.thrown instanceof Error ? attempt.thrown.message.split('\n')[0] : String(attempt.thrown),
  );
  check(
    'the reason says the issuer cannot be established and what to do instead',
    attempt.thrown instanceof InvalidKeyFileError &&
      attempt.thrown.reason.includes('records no issuer') &&
      attempt.thrown.reason.includes('move it aside'),
    attempt.thrown instanceof InvalidKeyFileError ? attempt.thrown.reason : '',
  );
  check('the key file is byte-identical afterwards', digestOf(path) === before);
}

/**
 * ISS-BIND-006. Files and configuration that cannot decide anything.
 *
 * The first three are the admission rules an evidence document gets, applied to the file that
 * decides which key signs: bytes that are not text, an object naming the same member twice, and
 * ordinary damage. The last is the other direction, and it stops earlier than the others: a
 * configured issuer this example will not sign under is refused before the key file is opened at
 * all.
 */
recordExecution('ISS-BIND-006');
{
  const validKey = Buffer.from(
    (await withConfiguredIssuer(FIRST_ISSUER, () =>
      resolveIssuerKey('devnet', join(workspace, 'issuer-binding-source.json')),
    )).privateKey,
  ).toString('hex');
  const body = (issuer: string): string =>
    `"kid":"payment-evidence-devnet-1","issuer":"${issuer}","privateKeyHex":"${validKey}"`;

  await refusesAndLeavesFileAlone('issuer-duplicate-issuer', `{${body(FIRST_ISSUER)},"issuer":"${SECOND_ISSUER}"}\n`, (p) =>
    withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', p)),
  );
  await refusesAndLeavesFileAlone(
    'issuer-invalid-utf8',
    Buffer.concat([Buffer.from(`{"issuer":"`), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]),
    (p) => withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', p)),
  );
  await refusesAndLeavesFileAlone('issuer-malformed-json', `{${body(FIRST_ISSUER)}`, (p) =>
    withConfiguredIssuer(FIRST_ISSUER, () => resolveIssuerKey('devnet', p)),
  );

  const unusable = join(workspace, 'issuer-unusable-configuration.json');
  writeFileSync(unusable, `{${body(FIRST_ISSUER)}}\n`);
  const before = digestOf(unusable);
  for (const configured of [
    'not-a-url',
    'ftp://issuer.example.test',
    'https://user:secret@issuer.example.test',
    'https://issuer.example.test#fragment',
    ` ${FIRST_ISSUER}`,
  ]) {
    const attempt = await issuerKeyAttempt(configured, unusable);
    check(
      `a configured issuer of "${configured.slice(0, 40)}" is refused`,
      attempt.thrown instanceof IssuerConfigurationError,
      attempt.thrown instanceof Error ? attempt.thrown.message.split('\n')[0] : String(attempt.thrown),
    );
  }
  check('and no key file was touched while refusing them', digestOf(unusable) === before);
  check(
    'a credential in the configured issuer is never published in the refusal',
    !(await issuerKeyAttempt('https://user:secret@issuer.example.test', unusable)).thrown
      ?.toString()
      .includes('secret'),
  );
}

console.log('\nKey files that cannot be loaded\n');

/**
 * Run one refusal case.
 *
 * The assertion that matters is not only that the call failed: it is that the file on disk is
 * byte-for-byte what it was. A loader that generated a replacement key would pass a "did it throw"
 * check just as easily if it wrote first and failed afterwards, so the bytes are compared.
 *
 * @param name - What the case is called in the output.
 * @param contents - The damaged file to write before the attempt.
 * @param attempt - The call under test, given the path to the damaged file.
 */
async function refusesAndLeavesFileAlone(
  name: string,
  contents: string | Uint8Array,
  attempt: (path: string) => Promise<unknown>,
): Promise<void> {
  const path = join(workspace, `${name}.json`);
  writeFileSync(path, contents);
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');

  let refusal: unknown;
  try {
    await attempt(path);
  } catch (e) {
    refusal = e;
  }
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');

  check(`${name}: the attempt fails`, refusal !== undefined);
  check(
    `${name}: it fails as an invalid key file rather than by generating a new key`,
    refusal instanceof InvalidKeyFileError,
    refusal instanceof Error ? refusal.message.split('\n')[0] : String(refusal),
  );
  check(
    `${name}: the message says the file was not modified and names it`,
    refusal instanceof InvalidKeyFileError &&
      refusal.message.includes('It was not modified.') &&
      refusal.message.includes(`${name}.json`),
  );
  check(`${name}: the file is byte-identical afterwards`, before === after);
}

// Every case calls the create-on-first-use path, because that is the one that would otherwise
// replace the key: a plain load has nothing to overwrite with.
recordExecution('KEY-FC-001');
await refusesAndLeavesFileAlone('payer-malformed-json', '[1, 2, 3', (p) => resolvePayerSigner(p));

recordExecution('KEY-FC-002');
await refusesAndLeavesFileAlone(
  'payer-wrong-length',
  JSON.stringify(Array.from({ length: 32 }, () => 7)),
  (p) => resolvePayerSigner(p),
);

recordExecution('KEY-FC-003');
{
  // Structurally perfect and cryptographically wrong: 64 entries, all byte values, but the public
  // half belongs to a different key. Nothing short of the key pair check catches this one.
  const keptPath = join(workspace, 'payer-source.json');
  const other = await createPayerKeyFile(join(workspace, 'payer-other.json'));
  const source = await createPayerKeyFile(keptPath);
  const mixed = JSON.parse(readFileSync(keptPath, 'utf8')) as number[];
  mixed.splice(32, 32, ...Array.from(getAddressEncoder().encode(other.address)));
  check('the mismatched file is still 64 byte values', mixed.length === 64 && mixed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
  check('the two halves come from different keys', other.address !== source.address);
  await refusesAndLeavesFileAlone('payer-mismatched-halves', JSON.stringify(mixed), (p) =>
    resolvePayerSigner(p),
  );
}

recordExecution('KEY-FC-004');
await refusesAndLeavesFileAlone(
  'issuer-unusable-private-key',
  `${JSON.stringify({ note: 'damaged', kid: 'issuer-key-1', privateKeyHex: 'not hex at all' }, null, 2)}\n`,
  (p) => resolveIssuerKey('devnet', p),
);

{
  // The other way a key is lost: a file that appears between deciding to create one and writing it.
  const path = join(workspace, 'payer-exclusive.json');
  const created = await createPayerKeyFile(path);
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  let refusal: unknown;
  try {
    await createPayerKeyFile(path);
  } catch (e) {
    refusal = e;
  }
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');
  check('creating a key file over an existing one is refused', refusal instanceof InvalidKeyFileError);
  check('that file is byte-identical afterwards', before === after);
  check(
    'and it still loads as the key it was',
    (await loadPayerSigner(path))?.address === created.address,
  );
}

{
  // Absence stays the one case that means "no key yet", so first use still works.
  const path = join(workspace, 'payer-first-use.json');
  const created = await resolvePayerSigner(path);
  check('a missing key file is created on first use', (await loadPayerSigner(path))?.address === created.address);
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
