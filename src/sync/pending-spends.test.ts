// ABOUTME: Tests for the spend-holds record (issue #55, #119) — its save/load round-trip, that an empty set
// ABOUTME: deletes the record, and that an unreadable record degrades to no holds instead of failing the load.

import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from '../storage/index';
import { PendingSpends, savePendingSpends, loadPendingSpends, pendingSpendsKey } from './pending-spends';

const ID = 'ab'.repeat(16);

describe('spend-holds record', () => {
  it('round-trips holds (tree, nullifier, txid, addedAt) through storage', async () => {
    const storage = new MemoryStorageAdapter();
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 123n }, { tree: 1, nullifier: 2n ** 250n }], '0xsub', 1_000, []);
    await savePendingSpends(storage, ID, holds);

    const loaded = await loadPendingSpends(storage, ID);
    expect(loaded.list()).toEqual(holds.list());
  });

  it('deletes the record once no holds remain', async () => {
    const storage = new MemoryStorageAdapter();
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 1n }], '0xsub', 1_000, []);
    await savePendingSpends(storage, ID, holds);
    expect(await storage.get(pendingSpendsKey(ID))).toBeDefined();

    holds.clear('0xsub');
    await savePendingSpends(storage, ID, holds);
    expect(await storage.get(pendingSpendsKey(ID))).toBeUndefined();
  });

  it('loads an unreadable record as no holds rather than failing the wallet load', async () => {
    // WHY: a lost hold only re-exposes a note to selection (preflight still catches a spent input); a
    // corrupt record must not brick loading the wallet.
    const storage = new MemoryStorageAdapter();
    await storage.put(pendingSpendsKey(ID), new TextEncoder().encode('{not json'));
    expect((await loadPendingSpends(storage, ID)).list()).toEqual([]);
    expect((await loadPendingSpends(storage, 'missing')).list()).toEqual([]);
  });
});
