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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddressEncoder } from '@solana/kit';
import { derivePublicKey, ed25519Verify } from '@peac/crypto';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { createPayerKeyFile, loadPayerSigner, resolvePayerSigner } from './flow/payer-key.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';
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
  contents: string,
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
