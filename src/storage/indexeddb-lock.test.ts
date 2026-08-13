// ABOUTME: IndexedDBStorageAdapter exclusive-lock guard — a second live instance on the same DB fails
// ABOUTME: loud with StorageConflictError (Web Locks), and the lock releases on close so re-open works.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexedDBStorageAdapter } from './indexeddb';
import { StorageConflictError } from '../errors';
import type { StorageNamespace } from './index';

const ns: StorageNamespace = { schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 };

// Minimal in-memory Web Locks: exclusive by name; `ifAvailable` yields null immediately when held. The
// held lock is released when the callback's returned promise settles (i.e. when the adapter closes).
function makeLockManager() {
  const held = new Set<string>();
  return {
    request: async (
      name: string,
      options: { mode?: string; ifAvailable?: boolean },
      callback: (lock: { name: string } | null) => unknown,
    ): Promise<unknown> => {
      if (options.ifAvailable === true && held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: makeLockManager() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IndexedDBStorageAdapter — exclusive-lock guard', () => {
  it('a second live instance on the same DB throws StorageConflictError', async () => {
    const a = new IndexedDBStorageAdapter('lock-db-1');
    await a.open(ns);
    const b = new IndexedDBStorageAdapter('lock-db-1');
    await expect(b.open(ns)).rejects.toBeInstanceOf(StorageConflictError);
    await a.close();
  });

  it('releases the lock on close — a fresh instance can re-open the same DB', async () => {
    const a = new IndexedDBStorageAdapter('lock-db-2');
    await a.open(ns);
    await a.close();
    const b = new IndexedDBStorageAdapter('lock-db-2');
    await expect(b.open(ns)).resolves.toEqual({ reset: false });
    await b.close();
  });

  it('different DBs do not collide', async () => {
    const a = new IndexedDBStorageAdapter('lock-db-3');
    const b = new IndexedDBStorageAdapter('lock-db-4');
    await a.open(ns);
    await expect(b.open(ns)).resolves.toEqual({ reset: false });
    await a.close();
    await b.close();
  });

  it('skips the guard when navigator.locks is unavailable (older/test envs)', async () => {
    vi.stubGlobal('navigator', {}); // no `locks`
    const a = new IndexedDBStorageAdapter('lock-db-5');
    const b = new IndexedDBStorageAdapter('lock-db-5');
    await a.open(ns);
    // No Web Locks API → no guard; both open (documents the feature-detect fallback).
    await expect(b.open(ns)).resolves.toEqual({ reset: false });
    await a.close();
    await b.close();
  });
});
