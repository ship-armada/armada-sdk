// ABOUTME: At-rest AEAD encryption over a StorageAdapter (SPEC §4.3, WS7.2 Option B). Values are
// ABOUTME: AES-256-GCM-encrypted under a rootSecret-derived key; locking = dropping the key (no plaintext at rest).

import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { StorageAdapter, StorageNamespace } from './index';

const STORAGE_KEY_SALT = new TextEncoder().encode('armada/sdk/storage/v1');
const STORAGE_KEY_INFO = new TextEncoder().encode('at-rest-encryption');
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

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Wraps any `StorageAdapter`, transparently AEAD-encrypting values at rest. Each record carries a
 * fresh 12-byte nonce prepended to the ciphertext. A tab crash / disk read leaks nothing without the
 * key; `get` throws on a wrong key or tampered blob (GCM auth failure).
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
    const ciphertext = gcm(this.key, nonce).encrypt(plaintext);
    const blob = new Uint8Array(nonce.length + ciphertext.length);
    blob.set(nonce, 0);
    blob.set(ciphertext, nonce.length);
    await this.inner.put(key, blob);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const blob = await this.inner.get(key);
    return blob === undefined ? undefined : this.decrypt(blob);
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    for await (const { key, value } of this.inner.list(prefix)) {
      yield { key, value: this.decrypt(value) };
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

  /** GCM-decrypt a `nonce ‖ ciphertext` blob. Throws on wrong key / tampered blob (auth failure). */
  private decrypt(blob: Uint8Array): Uint8Array {
    const nonce = blob.slice(0, NONCE_BYTES);
    const ciphertext = blob.slice(NONCE_BYTES);
    return gcm(this.key, nonce).decrypt(ciphertext);
  }
}
