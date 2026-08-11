/**
 * Record-issuing keys for the two run modes.
 *
 * The offline path uses a fixed key so a repeated run produces identical bytes. That key is
 * written here in the source, in the open, because it is test material: it protects nothing, it is
 * published in a public repository, and treating it as a secret would be theatre. It is refused
 * outside the fixture mode so it cannot be reached by accident on a live run.
 *
 * The devnet path generates a key into a gitignored directory with owner-only permissions and
 * keeps it across runs, so the same issuer can be recognised between runs. It is a demonstration
 * key on a test network, not an organizational identity.
 *
 * WHAT VERIFICATION MEANS HERE. A record that verifies against one of these keys shows that its
 * contents are intact relative to the key material supplied to the verifier. It does not show that
 * the key belongs to any particular organization, and nothing in this example establishes that.
 *
 * HOW THE KEY IS CREATED. Through the published surface of the protocol's own crypto package:
 * `generateKeypair` produces the 32-byte private key and its public key, and `derivePublicKey`
 * recomputes the public key from the private one on reload, so the stored file never has to be
 * trusted for anything but the private half. Nothing here reaches past those functions into
 * internals, and no key bytes are assembled by hand.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePublicKey, generateKeypair } from '@peac/crypto';
import { parseKeyFileJson, readKeyFile, refuseKeyFile, writeNewKeyFile } from './key-file.ts';

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KEY_DIR = join(APP_ROOT, '.local', 'keys');

/** Where the devnet issuer key lives. Gitignored, and a demonstration key rather than an identity. */
export const ISSUER_KEY_PATH = join(KEY_DIR, 'issuer.json');

export type RunMode = 'fixture' | 'devnet';

export interface IssuerKey {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** Key identifier carried in the record header. */
  readonly kid: string;
  /** Issuer identity claimed by the record. */
  readonly iss: string;
}

/**
 * TEST-ONLY issuer key for the offline path. Not a secret, not reused anywhere, and never valid
 * for anything beyond this example's fixture output.
 */
const FIXTURE_ISSUER_PRIVATE_KEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 11) % 256),
);

export const FIXTURE_ISSUER = 'https://origin.example.test';
export const FIXTURE_KID = 'payment-evidence-fixture-key-1';

/** The issuer identity used by a devnet run. Overridable so a real deployment names itself. */
export const DEVNET_ISSUER_ENV = 'PEAC_EXAMPLE_ISSUER';
const DEFAULT_DEVNET_ISSUER = 'https://origin.example.test';

interface StoredIssuerKey {
  readonly note: string;
  readonly kid: string;
  readonly privateKeyHex: string;
}

/** Exactly the 32 bytes of an Ed25519 private key, written as lower or upper case hex. */
const PRIVATE_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Load the stored issuer key.
 *
 * @param path - The key file to read.
 * @returns The stored key, or `undefined` when the file does not exist.
 * @throws InvalidKeyFileError when the file exists and does not hold a usable key.
 */
function loadStoredKey(path: string): StoredIssuerKey | undefined {
  const text = readKeyFile(path);
  if (text === undefined) return undefined;

  const parsed = parseKeyFileJson(path, text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuseKeyFile(path, 'it does not hold a key object');
  }
  const stored = parsed as Partial<StoredIssuerKey>;
  if (typeof stored.kid !== 'string' || stored.kid.length === 0) {
    refuseKeyFile(path, 'it has no key identifier');
  }
  // Validated as hex before decoding, because the decoder discards characters it does not
  // recognise: a damaged field would otherwise decode to a shorter, entirely different key.
  if (typeof stored.privateKeyHex !== 'string' || !PRIVATE_KEY_HEX.test(stored.privateKeyHex)) {
    refuseKeyFile(path, 'its private key is not 32 bytes of hex');
  }
  return { note: String(stored.note ?? ''), kid: stored.kid, privateKeyHex: stored.privateKeyHex };
}

/**
 * Resolve the issuer key for a run.
 *
 * @param mode - `fixture` returns the fixed test key; `devnet` reuses or creates the local key.
 * @param path - Where the devnet key file lives. Defaults to the gitignored local key.
 */
export async function resolveIssuerKey(
  mode: RunMode,
  path: string = ISSUER_KEY_PATH,
): Promise<IssuerKey> {
  if (mode === 'fixture') {
    return {
      privateKey: FIXTURE_ISSUER_PRIVATE_KEY,
      publicKey: await derivePublicKey(FIXTURE_ISSUER_PRIVATE_KEY),
      kid: FIXTURE_KID,
      iss: FIXTURE_ISSUER,
    };
  }

  const iss = process.env[DEVNET_ISSUER_ENV] ?? DEFAULT_DEVNET_ISSUER;
  const stored = loadStoredKey(path);
  if (stored !== undefined) {
    const privateKey = Uint8Array.from(Buffer.from(stored.privateKeyHex, 'hex'));
    try {
      return { privateKey, publicKey: await derivePublicKey(privateKey), kid: stored.kid, iss };
    } catch (e) {
      refuseKeyFile(path, `its private key is not usable (${(e as Error).message.split('\n')[0]})`);
    }
  }

  const generated = await generateKeypair();
  const kid = `payment-evidence-devnet-${Date.now().toString(36)}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload: StoredIssuerKey = {
    note: 'Demonstration key for a test network. Not an organizational identity.',
    kid,
    privateKeyHex: Buffer.from(generated.privateKey).toString('hex'),
  };
  writeNewKeyFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  // Set separately as well, in case the file's mode did not come from the create above.
  chmodSync(path, 0o600);
  return { privateKey: generated.privateKey, publicKey: generated.publicKey, kid, iss };
}
