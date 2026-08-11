/**
 * The devnet payer key.
 *
 * A payer key must survive between runs. Regenerating one per run would strand every airdrop
 * already sent to the previous address, so the key is created once, written to a gitignored
 * directory with owner-only permissions, and reused afterwards. Only the address is ever printed:
 * a key that appears in output ends up in logs, terminal history and pasted transcripts.
 *
 * HOW THE KEY IS CREATED AND RELOADED, AND WHY IT LOOKS LIKE THIS. A signer produced by
 * `generateKeyPairSigner()` holds a non-extractable private key, so its bytes cannot be read back
 * out and cannot be written to a file. Creation therefore starts from the private key instead of
 * from a signer: 32 bytes are drawn from the platform's cryptographic random source, and
 * `createKeyPairSignerFromPrivateKeyBytes` turns them into the signer. Nothing is ever exported
 * from a `CryptoKey`.
 *
 * The file holds the 64-byte secret key that Solana tooling uses: the 32-byte private key followed
 * by its 32-byte public key. The public half comes from encoding the signer's own address, which
 * is that public key in base58, so the two halves are consistent by construction rather than by
 * assumption. Reloading goes back through `createKeyPairSignerFromBytes`, which rejects a wrong
 * length and rejects a public half that does not belong to the private half. That check is the
 * reason no offset in this file is taken on trust: a mistake in the layout cannot produce a
 * working signer, and the round-trip tests exercise exactly that path.
 *
 * A key file that exists but cannot be loaded is refused, never replaced: see `key-file.ts`.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';
import { parseKeyFileJson, readKeyFile, refuseKeyFile, writeNewKeyFile } from './key-file.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KEY_DIR = join(APP_ROOT, '.local', 'keys');

/** Where the payer key lives. Gitignored, and the one file a person must not lose or share. */
export const PAYER_KEY_PATH = join(KEY_DIR, 'payer.json');

/** Bytes of an Ed25519 private key, which is also the seed the public key derives from. */
const PRIVATE_KEY_BYTES = 32;
/** Bytes of the stored secret key: the private key followed by the public key. */
const SECRET_KEY_BYTES = 64;

/**
 * Create the payer key file and return its signer.
 *
 * @param path - Where to write the key file. Defaults to the devnet payer key.
 * @throws InvalidKeyFileError when a key file is already there, which is never overwritten.
 */
export async function createPayerKeyFile(path: string = PAYER_KEY_PATH): Promise<KeyPairSigner> {
  const privateKey = new Uint8Array(randomBytes(PRIVATE_KEY_BYTES));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  const publicKey = getAddressEncoder().encode(signer.address);

  const secretKey = new Uint8Array(SECRET_KEY_BYTES);
  secretKey.set(privateKey, 0);
  secretKey.set(publicKey, PRIVATE_KEY_BYTES);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeNewKeyFile(path, JSON.stringify([...secretKey]));
  // Set separately as well, in case the file's mode did not come from the create above.
  chmodSync(path, 0o600);
  return signer;
}

/**
 * Load the payer key from its file.
 *
 * @param path - Where to read the key file from. Defaults to the devnet payer key.
 * @returns The signer, or `undefined` when the file does not exist.
 * @throws InvalidKeyFileError when the file exists and does not hold a usable key.
 */
export async function loadPayerSigner(
  path: string = PAYER_KEY_PATH,
): Promise<KeyPairSigner | undefined> {
  const text = readKeyFile(path);
  if (text === undefined) return undefined;

  const stored = parseKeyFileJson(path, text);
  if (!Array.isArray(stored)) {
    refuseKeyFile(path, 'it does not hold an array of bytes');
  }
  if (stored.length !== SECRET_KEY_BYTES) {
    refuseKeyFile(path, `it holds ${stored.length} entries, expected ${SECRET_KEY_BYTES}`);
  }
  // Checked before conversion: Uint8Array.from turns anything unrecognised into zero, which would
  // otherwise silently reshape a damaged file into a well-formed but wrong key.
  for (const [index, entry] of stored.entries()) {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 255) {
      refuseKeyFile(path, `entry ${index} is not a byte value`);
    }
  }

  try {
    // Rejects a public half that does not belong to the private half, so a file assembled from
    // two different keys cannot load as either of them.
    return await createKeyPairSignerFromBytes(Uint8Array.from(stored as number[]));
  } catch (e) {
    refuseKeyFile(path, `it is not a usable key pair (${(e as Error).message.split('\n')[0]})`);
  }
}

/**
 * Load the payer key, creating it only when no key file exists.
 *
 * @param path - Where the key file lives. Defaults to the devnet payer key.
 * @throws InvalidKeyFileError when a key file exists and cannot be loaded. It is left untouched.
 */
export async function resolvePayerSigner(
  path: string = PAYER_KEY_PATH,
): Promise<KeyPairSigner> {
  return (await loadPayerSigner(path)) ?? (await createPayerKeyFile(path));
}
