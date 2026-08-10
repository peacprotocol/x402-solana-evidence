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
 * Every case runs against a temporary directory, never the real key files, so running the suite
 * can neither read nor disturb a funded devnet key.
 *
 * These cases need no network. Generating a key is local computation, and nothing here contacts a
 * chain, a faucet or a facilitator.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddressEncoder } from '@solana/kit';
import { derivePublicKey, ed25519Verify } from '@peac/crypto';
import { beginAcceptanceSuite, recordExecution } from './acceptance-ids.ts';
import { createPayerKeyFile, loadPayerSigner } from './flow/payer-key.ts';
import { resolveIssuerKey } from './flow/issuer-key.ts';

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

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
