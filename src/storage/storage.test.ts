// ABOUTME: Unit tests for the storage module — MemoryStorageAdapter (namespace/reset semantics) and
// ABOUTME: EncryptedStore (at-rest AEAD round-trip, tamper/wrong-key rejection, no plaintext at rest).

import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from './memory';
import { EncryptedStore, deriveStorageKey } from './encrypted';
import type { StorageNamespace } from './index';

const POOL = '0x1111111111111111111111111111111111111111' as const;
const ns = (deployBlock: number): StorageNamespace => ({
  schemaVersion: 1,
  chainId: 31337,
  poolAddress: POOL,
  deployBlock,
});
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);

async function collect(iter: AsyncIterable<{ key: string; value: Uint8Array }>) {
  const out: string[] = [];
  for await (const { key } of iter) out.push(key);
  return out.sort();
}

describe('MemoryStorageAdapter', () => {
  it('put / get / del round-trip', async () => {
    const s = new MemoryStorageAdapter();
    await s.open(ns(10));
    await s.put('chain/merkle/0', bytes('node'));
    expect(str((await s.get('chain/merkle/0'))!)).toBe('node');
    await s.del('chain/merkle/0');
    expect(await s.get('chain/merkle/0')).toBeUndefined();
  });

  it('list by prefix', async () => {
    const s = new MemoryStorageAdapter();
    await s.open(ns(10));
    await s.put('chain/txo/1', bytes('a'));
    await s.put('chain/txo/2', bytes('b'));
    await s.put('identity/wallet/x', bytes('c'));
    expect(await collect(s.list('chain/txo/'))).toEqual(['chain/txo/1', 'chain/txo/2']);
  });

  it('resetChainState clears chain-derived keys, preserves identity/ and durable/ (P3.4)', async () => {
    const s = new MemoryStorageAdapter();
    await s.open(ns(10));
    await s.put('chain/merkle/0', bytes('m'));
    await s.put('identity/wallet/x', bytes('id'));
    await s.put('durable/claim-counter', bytes('7')); // MUST survive a redeploy — else seed reuse (§6.2)
    await s.resetChainState();
    expect(await s.get('chain/merkle/0')).toBeUndefined();
    expect(str((await s.get('identity/wallet/x'))!)).toBe('id');
    expect(str((await s.get('durable/claim-counter'))!)).toBe('7');
  });

  it('reopening under a changed deployBlock auto-resets chain state but keeps identity', async () => {
    const s = new MemoryStorageAdapter();
    await s.open(ns(10));
    await s.put('chain/merkle/0', bytes('m'));
    await s.put('identity/wallet/x', bytes('id'));
    await s.open(ns(20)); // redeploy → different deployBlock
    expect(await s.get('chain/merkle/0')).toBeUndefined();
    expect(str((await s.get('identity/wallet/x'))!)).toBe('id');
  });
});

describe('EncryptedStore', () => {
  const key = deriveStorageKey(new Uint8Array(32).fill(7));

  it('encrypts at rest and decrypts round-trip', async () => {
    const store = new EncryptedStore(new MemoryStorageAdapter(), key);
    await store.open(ns(1));
    await store.put('chain/note/1', bytes('a very secret note'));
    expect(str((await store.get('chain/note/1'))!)).toBe('a very secret note');
  });

  it('stores ciphertext, not plaintext, in the inner adapter', async () => {
    const inner = new MemoryStorageAdapter();
    const store = new EncryptedStore(inner, key);
    await store.open(ns(1));
    await store.put('chain/note/1', bytes('plaintext-marker'));
    const raw = await inner.get('chain/note/1');
    expect(raw).toBeDefined();
    expect(str(raw!)).not.toContain('plaintext-marker');
    expect(raw!.length).toBeGreaterThan('plaintext-marker'.length); // nonce + tag overhead
  });

  it('a wrong key fails to decrypt (GCM auth)', async () => {
    const inner = new MemoryStorageAdapter();
    await new EncryptedStore(inner, key).put('chain/note/1', bytes('secret'));
    const wrong = new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(9)));
    await expect(wrong.get('chain/note/1')).rejects.toThrow();
  });

  it('binds the record key as AAD — a blob moved to another key fails to decrypt (cut-and-paste)', async () => {
    // WHY (M3): without AAD, an attacker with storage write access copies one record's ciphertext over
    // another key and it silently decrypts under the same store key. Binding the key defeats that.
    const inner = new MemoryStorageAdapter();
    const store = new EncryptedStore(inner, key);
    await store.open(ns(1));
    await store.put('chain/scan-state/A', bytes('A notes'));
    const blob = await inner.get('chain/scan-state/A');
    await inner.put('chain/scan-state/B', blob!); // move A's blob onto key B
    await expect(store.get('chain/scan-state/B')).rejects.toThrow();
    expect(str((await store.get('chain/scan-state/A'))!)).toBe('A notes'); // A still fine
  });

  it('list() decrypts each value so it is a full StorageAdapter (satisfies the type)', async () => {
    // WHY: EncryptedStore must implement the whole StorageAdapter surface, or a consumer can't pass
    // it as `config.storage`. `list` iterates the inner (ciphertext) entries and decrypts each value.
    const store = new EncryptedStore(new MemoryStorageAdapter(), key);
    await store.open(ns(1));
    await store.put('chain/note/1', bytes('one'));
    await store.put('chain/note/2', bytes('two'));
    await store.put('identity/wallet/x', bytes('id'));
    const out: Record<string, string> = {};
    for await (const { key: k, value } of store.list('chain/note/')) out[k] = str(value);
    expect(out).toEqual({ 'chain/note/1': 'one', 'chain/note/2': 'two' });
  });

  it('deriveStorageKey is deterministic and rejects non-32-byte input', () => {
    const a = deriveStorageKey(new Uint8Array(32).fill(1));
    const b = deriveStorageKey(new Uint8Array(32).fill(1));
    expect(a).toEqual(b);
    expect(deriveStorageKey(new Uint8Array(32).fill(1))).not.toEqual(key);
    expect(() => deriveStorageKey(new Uint8Array(16))).toThrow();
  });
});
