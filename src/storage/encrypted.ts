// ABOUTME: At-rest AEAD encryption over a StorageAdapter (SPEC §4.3, WS7.2 Option B). Values are
// ABOUTME: AES-256-GCM-encrypted under a rootSecret-derived key; locking = dropping the key (no plaintext at rest).

import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { StorageAdapter, StorageNamespace } from './index';

const STORAGE_KEY_SALT = new TextEncoder().encode('armada/sdk/storage/v1');
const STORAGE_KEY_INFO = new TextEncoder().encode('at-rest-encryption');
const STORAGE_KEY_INFO_WALLET = new TextEncoder().encode('at-rest-encryption/wallet-v1');
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Derive the 32-byte at-rest storage key from the wallet's rootSecret via HKDF-SHA-256,
 * domain-separated so it never collides with other subkey derivations.
 */
export function deriveStorageKey(rootSecret: Uint8Array): Uint8Array {
  if (rootSecret.length !== KEY_BYTES) {
    throw new Error(`deriveStorageKey: expected ${KEY_BYTES}-byte rootSecret, got ${rootSecret.length}`);
  }
  return hkdf(sha256, rootSecret, STORAGE_KEY_SALT, STORAGE_KEY_INFO, KEY_BYTES);
}

/**
 * Derive a per-wallet at-rest storage key from the wallet's viewing private key. Used instead of
 * `deriveStorageKey` at the wallet-persistence boundary because the viewing key is present on EVERY
 * wallet type — including view-only wallets, which have no rootSecret. HKDF ikm may be any length; a
 * distinct `info` tag keeps this key independent of both the note-ECIES use of the same viewing key
 * and the rootSecret-derived `deriveStorageKey`. Anyone already holding the viewing key can read the
 * notes directly, so deriving the disk key from it protects exactly the intended threat: a disk-at-rest
 * reader who lacks the wallet's keys.
 */
export function deriveWalletStorageKey(viewingPrivateKey: Uint8Array): Uint8Array {
  return hkdf(sha256, viewingPrivateKey, STORAGE_KEY_SALT, STORAGE_KEY_INFO_WALLET, KEY_BYTES);
}

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Wraps any `StorageAdapter`, transparently AEAD-encrypting values at rest. Each record carries a
 * fresh 12-byte nonce prepended to the ciphertext, and the record KEY is bound as GCM associated data
 * (AAD) so a ciphertext copied onto a different key fails to decrypt — an attacker with storage write
 * access cannot cut-and-paste one record's blob over another. A tab crash / disk read leaks nothing
 * without the key; `get` throws on a wrong key, a tampered blob, or a moved record (GCM auth failure).
 *
 * The namespace is deliberately NOT part of the AAD: identity/durable records must survive a
 * deploy-block change (which rewrites the namespace but not the wallet), and per-wallet keys already
 * isolate one wallet's records from another's.
 */
export class EncryptedStore implements StorageAdapter {
  constructor(
    private readonly inner: StorageAdapter,
    private readonly key: Uint8Array,
  ) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`EncryptedStore: key must be ${KEY_BYTES} bytes (AES-256)`);
    }
  }

  open(namespace: StorageNamespace): Promise<void> {
    return this.inner.open(namespace);
  }

  async put(key: string, plaintext: Uint8Array): Promise<void> {
    const nonce = randomNonce();
    const ciphertext = gcm(this.key, nonce, aad(key)).encrypt(plaintext);
    const blob = new Uint8Array(nonce.length + ciphertext.length);
    blob.set(nonce, 0);
    blob.set(ciphertext, nonce.length);
    await this.inner.put(key, blob);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const blob = await this.inner.get(key);
    return blob === undefined ? undefined : this.decrypt(blob, key);
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    for await (const { key, value } of this.inner.list(prefix)) {
      yield { key, value: this.decrypt(value, key) };
    }
  }

  del(key: string): Promise<void> {
    return this.inner.del(key);
  }

  resetChainState(): Promise<void> {
    return this.inner.resetChainState();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** GCM-decrypt a `nonce ‖ ciphertext` blob under the record key's AAD. Throws on wrong key /
   *  tampered blob / a blob moved to a different key (auth failure). */
  private decrypt(blob: Uint8Array, key: string): Uint8Array {
    const nonce = blob.slice(0, NONCE_BYTES);
    const ciphertext = blob.slice(NONCE_BYTES);
    return gcm(this.key, nonce, aad(key)).decrypt(ciphertext);
  }
}

/** Associated data binding a ciphertext to its record key (defeats cross-key cut-and-paste). */
function aad(key: string): Uint8Array {
  return new TextEncoder().encode(key);
}
