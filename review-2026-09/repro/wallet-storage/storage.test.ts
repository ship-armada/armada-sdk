// ABOUTME: Repro tests for the storage layer review (wallet-storage area). Each test PASSES when the
// ABOUTME: reported bug is present — i.e. it asserts the current (buggy) behaviour.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryLevel } from 'memory-level';
import { MemoryStorageAdapter, EncryptedStore, LevelStorageAdapter, IndexedDBStorageAdapter, deriveWalletStorageKey } from '../../../src/storage/index';
import type { StorageNamespace, AbstractLevelLike } from '../../../src/storage/index';
import { StorageConflictError } from '../../../src/errors';
import { resolveWalletStorage } from '../../../src/sdk';
import { deriveKeyset } from '../../../src/wallet/index';
import { saveScanState, WalletScanState } from '../../../src/sync/index';

const nsA: StorageNamespace = { schemaVersion: 1, chainId: 1, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 };
const nsB: StorageNamespace = { schemaVersion: 1, chainId: 2, poolAddress: `0x${'22'.repeat(20)}`, deployBlock: 5 };

function makeLockManager() {
  const held = new Set<string>();
  return {
    held,
    request: async (name: string, options: { ifAvailable?: boolean }, cb: (l: { name: string } | null) => unknown) => {
      if (options.ifAvailable === true && held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
}

async function collect(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of it) out.push(key);
  return out;
}

describe('STO: plaintext record keys leak the 0zk address', () => {
  it('the encrypted per-wallet scan-state record is stored under chain/scan-state/<0zk address> in plaintext', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(nsA);
    const keyset = await deriveKeyset(new Uint8Array(32).fill(7));
    const store = resolveWalletStorage(raw, keyset.viewingPrivateKey, false); // default (encrypted) path, sdk.ts:366
    await saveScanState(store, keyset.shieldedAddress, new WalletScanState(), 10); // as sdk.ts:603
    const keys = await collect(raw.list(''));
    expect(keys).toContain(`chain/scan-state/${keyset.shieldedAddress}`);
  });
});

describe('STO: EncryptedStore shares one key space across wallets', () => {
  it('list(prefix) on wallet A throws on wallet B\'s record (GCM auth failure)', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(nsA);
    const a = new EncryptedStore(raw, deriveWalletStorageKey(new Uint8Array(32).fill(1)));
    const b = new EncryptedStore(raw, deriveWalletStorageKey(new Uint8Array(32).fill(2)));
    await a.put('durable/pending-claims/1', new Uint8Array([1]));
    await b.put('durable/pending-claims/2', new Uint8Array([2]));
    await expect(collect(a.list('durable/pending-claims/'))).rejects.toThrow();
  });
  it('list(\'identity/\') through a per-wallet store throws on the adapter\'s plaintext namespace marker', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(nsA); // writes plaintext identity/__namespace__
    const a = new EncryptedStore(raw, deriveWalletStorageKey(new Uint8Array(32).fill(1)));
    await a.put('identity/wallet-record', new Uint8Array([1]));
    await expect(collect(a.list('identity/'))).rejects.toThrow();
  });
  it('wallet B can silently overwrite wallet A\'s same-named record; A then fails to read it', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(nsA);
    const a = new EncryptedStore(raw, deriveWalletStorageKey(new Uint8Array(32).fill(1)));
    const b = new EncryptedStore(raw, deriveWalletStorageKey(new Uint8Array(32).fill(2)));
    await a.put('durable/claim-counter', new Uint8Array([41]));
    await b.put('durable/claim-counter', new Uint8Array([0]));
    await expect(a.get('durable/claim-counter')).rejects.toThrow();
  });
});

describe('STO: LevelStorageAdapter lock mapping never fires against a real abstract-level DB', () => {
  it('a LEVEL_LOCKED open failure surfaces as LEVEL_DATABASE_NOT_OPEN, not StorageConflictError', async () => {
    class LockedLevel extends MemoryLevel<string, Uint8Array> {
      // Same failure classic-level raises from its native open when another process holds the LOCK file.
      async _open(): Promise<void> {
        throw Object.assign(new Error('IO error: /tmp/db/LOCK: Resource temporarily unavailable'), { code: 'LEVEL_LOCKED' });
      }
    }
    const db = new LockedLevel({ keyEncoding: 'utf8', valueEncoding: 'view' });
    const err = await new LevelStorageAdapter(db as unknown as AbstractLevelLike).open(nsA).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorageConflictError);
    expect((err as { code?: string }).code).toBe('LEVEL_DATABASE_NOT_OPEN');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('LEVEL_LOCKED');
  });
});

describe('STO: list() ordering differs between adapters', () => {
  it('MemoryStorageAdapter yields insertion order; LevelStorageAdapter yields key order', async () => {
    const mem = new MemoryStorageAdapter();
    await mem.open(nsA);
    const lvl = new LevelStorageAdapter(new MemoryLevel({ keyEncoding: 'utf8', valueEncoding: 'view' }) as unknown as AbstractLevelLike);
    await lvl.open(nsA);
    for (const s of [mem, lvl]) {
      await s.put('durable/journal/0002', new Uint8Array([2]));
      await s.put('durable/journal/0001', new Uint8Array([1]));
    }
    expect(await collect(mem.list('durable/journal/'))).toEqual(['durable/journal/0002', 'durable/journal/0001']);
    expect(await collect(lvl.list('durable/journal/'))).toEqual(['durable/journal/0001', 'durable/journal/0002']);
  });
});

describe('STO: one adapter object shared by two SDK instances / deployments', () => {
  beforeEach(() => { vi.stubGlobal('navigator', { locks: makeLockManager() }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('IndexedDB: re-opening the SAME adapter under another namespace bypasses the lock and wipes chain state', async () => {
    const s = new IndexedDBStorageAdapter('shared-db-1');
    await s.open(nsA);
    await s.put('chain/scan-state/0zkA', new Uint8Array([1]));
    const second = await s.open(nsB); // a 2nd createArmadaSdk({ storage: s, pool: B }) — no StorageConflictError
    expect(second.reset).toBe(true);
    expect(await s.get('chain/scan-state/0zkA')).toBeUndefined();
    await s.close();
  });

  it('IndexedDB: after close(), any call silently re-opens the DB WITHOUT the lock, racing the new lock holder', async () => {
    const old = new IndexedDBStorageAdapter('shared-db-2');
    await old.open(nsA);
    await old.close();
    const fresh = new IndexedDBStorageAdapter('shared-db-2');
    await fresh.open(nsA); // holds the exclusive lock now
    await fresh.put('chain/scan-state/0zkA', new Uint8Array([9, 9]));
    // A straggling sync from the closed instance (close() does not await in-flight syncs) writes stale state:
    await old.put('chain/scan-state/0zkA', new Uint8Array([1]));
    expect(Array.from((await fresh.get('chain/scan-state/0zkA'))!)).toEqual([1]);
    await fresh.close();
    await old.close();
  });

  it('Memory: close() wipes the store, so a closed-then-reused adapter loses durable/ records', async () => {
    const s = new MemoryStorageAdapter();
    await s.open(nsA);
    await s.put('durable/claim-counter', new Uint8Array([5]));
    await s.close();
    await s.open(nsA);
    expect(await s.get('durable/claim-counter')).toBeUndefined();
  });
});
