// ABOUTME: Tests for the spend-holds record (issue #55, #119) — its save/load round-trip, that an empty set deletes the
// ABOUTME: record, that an unreadable record degrades to no holds, and the submissions (txids) the holds belong to.

import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from '../storage/index';
import { PendingSpends, savePendingSpends, loadPendingSpends, PENDING_SPENDS_KEY } from './pending-spends';

describe('spend-holds record', () => {
  it('round-trips holds (tree, nullifier, txid, addedAt) through storage', async () => {
    const storage = new MemoryStorageAdapter();
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 123n }, { tree: 1, nullifier: 2n ** 250n }], '0xsub', 1_000, []);
    await savePendingSpends(storage, holds);

    const loaded = await loadPendingSpends(storage);
    expect(loaded.list()).toEqual(holds.list());
  });

  it('deletes the record once no holds remain', async () => {
    const storage = new MemoryStorageAdapter();
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 1n }], '0xsub', 1_000, []);
    await savePendingSpends(storage, holds);
    expect(await storage.get(PENDING_SPENDS_KEY)).toBeDefined();

    holds.clear('0xsub');
    await savePendingSpends(storage, holds);
    expect(await storage.get(PENDING_SPENDS_KEY)).toBeUndefined();
  });

  it('loads an unreadable record as no holds rather than failing the wallet load', async () => {
    // WHY: a lost hold only re-exposes a note to selection (preflight still catches a spent input); a
    // corrupt record must not brick loading the wallet.
    const storage = new MemoryStorageAdapter();
    await storage.put(PENDING_SPENDS_KEY, new TextEncoder().encode('{not json'));
    expect((await loadPendingSpends(storage)).list()).toEqual([]);
    expect((await loadPendingSpends(new MemoryStorageAdapter())).list()).toEqual([]); // and a missing one
  });
});

describe('txids', () => {
  // A note's spend, as a sync records it once its Nullified event is scanned.
  const spent = (nullifier: bigint) => ({ tree: 0, nullifier, txid: '0xmined', blockNumber: 1 });

  it('lists each held submission once, in the order it was first held', () => {
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 1n }, { tree: 0, nullifier: 2n }], '0xfirst', 1_000, []);
    holds.mark([{ tree: 0, nullifier: 3n }], '0xsecond', 2_000, []);
    expect(holds.txids()).toEqual(['0xfirst', '0xsecond']);
  });

  it('drops a submission once none of its holds remain', () => {
    const holds = new PendingSpends();
    holds.mark([{ tree: 0, nullifier: 1n }, { tree: 0, nullifier: 2n }], '0xfirst', 1_000, []);
    holds.mark([{ tree: 0, nullifier: 3n }], '0xsecond', 2_000, []);
    holds.releaseConfirmed([spent(1n)]);
    expect(holds.txids()).toEqual(['0xfirst', '0xsecond']); // one of its two inputs is still held
    holds.releaseConfirmed([spent(2n)]);
    expect(holds.txids()).toEqual(['0xsecond']);
    holds.clear('0xsecond');
    expect(holds.txids()).toEqual([]);
  });
});
