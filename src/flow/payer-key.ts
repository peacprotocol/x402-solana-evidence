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
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KEY_DIR = join(APP_ROOT, '.local', 'keys');

/** Where the payer key lives. Gitignored, and the one file a person must not lose or share. */
export const PAYER_KEY_PATH = join(KEY_DIR, 'payer.json');

/** Bytes of an Ed25519 private key, which is also the seed the public key derives from. */
const PRIVATE_KEY_BYTES = 32;
/** Bytes of the stored secret key: the private key followed by the public key. */
const SECRET_KEY_BYTES = 64;

/** Path shown in messages, relative to the repository so no local directory layout is printed. */
export function displayKeyPath(path: string): string {
  return path.startsWith(APP_ROOT) ? `.${path.slice(APP_ROOT.length)}` : path;
}

/**
 * Create the payer key file and return its signer.
 *
 * @param path - Where to write the key file. Defaults to the devnet payer key.
 */
export async function createPayerKeyFile(path: string = PAYER_KEY_PATH): Promise<KeyPairSigner> {
  const privateKey = new Uint8Array(randomBytes(PRIVATE_KEY_BYTES));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  const publicKey = getAddressEncoder().encode(signer.address);

  const secretKey = new Uint8Array(SECRET_KEY_BYTES);
  secretKey.set(privateKey, 0);
  secretKey.set(publicKey, PRIVATE_KEY_BYTES);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify([...secretKey]), { mode: 0o600 });
  // Set separately as well, because an existing file keeps the permissions it already had.
  chmodSync(path, 0o600);
  return signer;
}

/**
 * Load the payer key from its file.
 *
 * @param path - Where to read the key file from. Defaults to the devnet payer key.
 * @returns The signer, or `undefined` when no key has been created yet.
 */
export async function loadPayerSigner(
  path: string = PAYER_KEY_PATH,
): Promise<KeyPairSigner | undefined> {
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(stored)) return undefined;
  return createKeyPairSignerFromBytes(Uint8Array.from(stored as number[]));
}

/**
 * Load the payer key, creating it on first use.
 *
 * @param path - Where the key file lives. Defaults to the devnet payer key.
 */
export async function resolvePayerSigner(
  path: string = PAYER_KEY_PATH,
): Promise<KeyPairSigner> {
  return (await loadPayerSigner(path)) ?? (await createPayerKeyFile(path));
}
