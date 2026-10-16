// ABOUTME: Tests for scan-state persistence (§4.3/§4.4) — snapshot/restore round-trip and
// ABOUTME: StorageAdapter save/load, preserving balances, roots, spendable TXOs, and spent nullifiers.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import { MemoryStorageAdapter } from '../storage/index';
import { EncryptedStore, deriveStorageKey } from '../storage/encrypted';
import { ScopedStore } from '../storage/scoped';
import { WalletScanState } from './scan-engine';
import type { DecodedPoolEvents, DecodedTransactCommitment } from './event-decoder';
import type { CommitmentCiphertextV2 } from './note-crypto';
import { saveScanState, loadScanState, clearScanState, TREE_CHUNK_SIZE } from './scan-persistence';
import type { StorageOp } from '../storage/index';

const NK = 987654321098765n;
const TOKEN = 'ee'.repeat(32);
const TXID = '0x' + 'ab'.repeat(32);
const BAL = { currentBlock: 1000, finalityThreshold: 10 };
const leafHex = (n: number): string => n.toString(16).padStart(64, '0');
const owned = (value: bigint) => ({ tokenHash: TOKEN, value, random: '00'.repeat(16), notePublicKey: 0n });

const dummyCt = (): CommitmentCiphertextV2 => ({
  ciphertext: [leafHex(0), leafHex(0), leafHex(0), leafHex(0)],
  blindedSenderViewingKey: new Uint8Array(32),
  blindedReceiverViewingKey: new Uint8Array(32),
  memo: '0x',
  annotationData: '0x',
});
const mkTransact = (tree: number, position: number, hash: string): DecodedTransactCommitment => ({
  tree, position, blockNumber: 100, txid: TXID, hash, ciphertext: dummyCt(),
});
const noEvents = (): DecodedPoolEvents => ({ shields: [], transacts: [], nullifiers: [], unshields: [] });

async function buildState(): Promise<WalletScanState> {
  const state = new WalletScanState();
  await state.apply(
    { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(11)), mkTransact(0, 1, leafHex(12))] },
    { nullifyingKey: NK, transact: async (c) => (c.hash === leafHex(12) ? owned(50n) : owned(100n)) },
  );
  return state;
}

describe('scan-state persistence (§4.3/§4.4)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('snapshot → restore preserves balances, root, and spendable TXOs', async () => {
    const state = await buildState();
    const restored = WalletScanState.restore(state.snapshot());

    expect(restored.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
    expect(restored.treeRoot(0)).toBe(state.treeRoot(0));
    expect(restored.treeLength(0)).toBe(2);
    expect(restored.spendableTxos(NK).map((t) => t.position)).toEqual(state.spendableTxos(NK).map((t) => t.position));
  });

  it('preserves spent nullifiers across a snapshot', async () => {
    const state = await buildState();
    await state.apply(
      { ...noEvents(), nullifiers: [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 0), blockNumber: 101, txid: TXID }] },
      { nullifyingKey: NK, transact: async () => undefined },
    );
    const restored = WalletScanState.restore(state.snapshot());
    // Position-0 note is spent → excluded from both the balance and the spendable set.
    expect(restored.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
    expect(restored.spendableTxos(NK)).toHaveLength(1);
  });

  it('saves and loads scan state through a StorageAdapter', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const state = await buildState();

    await saveScanState(storage, state, 500);
    const loaded = await loadScanState(storage);

    expect(loaded).toBeDefined();
    expect(loaded!.syncedThrough).toBe(500);
    expect(loaded!.state.treeRoot(0)).toBe(state.treeRoot(0));
    expect(loaded!.state.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
  });

  it('round-trips the checkpoint block hash, and loads older records without one (#118)', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const state = await buildState();
    const hash = `0x${'ab'.repeat(32)}`;

    const alice = new ScopedStore(storage, 'alice');
    await saveScanState(alice, state, 500, hash);
    expect((await loadScanState(alice))?.syncedThroughHash).toBe(hash);

    // A record written before the hash existed still loads; the reorg check just skips it once.
    const bob = new ScopedStore(storage, 'bob');
    await saveScanState(bob, state, 500);
    const legacy = await loadScanState(bob);
    expect(legacy?.syncedThrough).toBe(500);
    expect(legacy?.syncedThroughHash).toBeUndefined();
  });

  it('returns undefined for a wallet with no persisted state', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    expect(await loadScanState(storage)).toBeUndefined();
  });

  it('degrades a corrupt (unparseable) record to a cache miss instead of throwing (M4)', async () => {
    // WHY: scan state is chain-derived cache. A bit-flip / interrupted write must rescan, not brick every
    // future sync — the in-process form of the "delete the DB by hand" pitfall §4.3 removes.
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    await saveScanState(storage, await buildState(), 500);
    await storage.put('chain/checkpoint', new TextEncoder().encode('{not valid json'));
    expect(await loadScanState(storage)).toBeUndefined();
  });

  it('degrades an undecryptable encrypted record to a cache miss (M4, GCM auth failure)', async () => {
    // A record written under one key and read under another (key rotation / corruption) throws GCM auth
    // failure inside get(); loadScanState must swallow it and rescan rather than propagate and wedge sync.
    const inner = new MemoryStorageAdapter();
    await inner.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const writer = new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(1)));
    await saveScanState(writer, await buildState(), 42);

    const reader = new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(2))); // wrong key
    expect(await loadScanState(reader)).toBeUndefined();
  });

  describe('records: a checkpoint, the notes, and the tree in chunks (SYNC-9, #143)', () => {
    // WHY: the whole scan state — every tree's leaves, every pool nullifier and unshield — was one record, rebuilt,
    // re-encrypted and rewritten on every sync: about 20 MB per wallet at 100k leaves, hitting IndexedDB quota.
    const ns = { schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}` as `0x${string}`, deployBlock: 1 };

    // Records every write, so a test can see exactly which records a save touched and how.
    class RecordingStorage extends MemoryStorageAdapter {
      readonly batches: string[][] = [];
      puts = 0;
      override async put(key: string, value: Uint8Array): Promise<void> {
        this.puts += 1;
        return super.put(key, value);
      }
      override async batch(ops: readonly StorageOp[]): Promise<void> {
        this.batches.push(ops.map((op) => `${op.type} ${op.key}`));
        return super.batch(ops);
      }
    }
    async function keysOf(storage: MemoryStorageAdapter): Promise<string[]> {
      const keys: string[] = [];
      for await (const { key } of storage.list('chain/')) keys.push(key);
      return keys;
    }
    async function stateWithLeaves(count: number): Promise<WalletScanState> {
      const state = new WalletScanState();
      await state.apply(
        { ...noEvents(), transacts: Array.from({ length: count }, (_, i) => mkTransact(0, i, leafHex(i + 1))) },
        { nullifyingKey: NK, transact: async (c) => (c.position === 0 ? owned(100n) : undefined) },
      );
      return state;
    }

    it(`stores the tree in chunks of ${TREE_CHUNK_SIZE} leaves, beside the notes and the checkpoint, in one batch`, async () => {
      const storage = new RecordingStorage();
      await storage.open(ns);
      await saveScanState(storage, await stateWithLeaves(TREE_CHUNK_SIZE + 5), 500);
      expect(await keysOf(storage)).toEqual(['chain/checkpoint', 'chain/notes', 'chain/tree/0/00', 'chain/tree/0/01']);
      expect(storage.batches).toHaveLength(1);
      expect(storage.puts).toBe(0);
      const loaded = await loadScanState(storage);
      expect(loaded?.state.treeLength(0)).toBe(TREE_CHUNK_SIZE + 5);
      expect(loaded?.state.txoCount).toBe(1);
    });

    it('given the state it saved last, writes only the tree chunks that changed', async () => {
      const storage = new RecordingStorage();
      await storage.open(ns);
      const saved = await stateWithLeaves(TREE_CHUNK_SIZE + 5);
      await saveScanState(storage, saved, 500);
      const next = saved.clone();
      await next.apply({ ...noEvents(), transacts: [mkTransact(0, TREE_CHUNK_SIZE + 5, leafHex(9999))] }, { nullifyingKey: NK, transact: async () => undefined });
      await saveScanState(storage, next, 501, undefined, saved);
      expect(storage.batches[1]).toEqual(['put chain/tree/0/01', 'put chain/notes', 'put chain/checkpoint']);
      expect((await loadScanState(storage))?.state.treeRoot(0)).toBe(next.treeRoot(0));
    });

    it('treats a missing chunk, or notes of another format version, as a cache miss', async () => {
      const storage = new MemoryStorageAdapter();
      await storage.open(ns);
      await saveScanState(storage, await stateWithLeaves(TREE_CHUNK_SIZE + 5), 500);
      await storage.del('chain/tree/0/00');
      expect(await loadScanState(storage)).toBeUndefined();

      await saveScanState(storage, await stateWithLeaves(3), 500);
      const notes = JSON.parse(new TextDecoder().decode((await storage.get('chain/notes'))!)) as { version: number };
      await storage.put('chain/notes', new TextEncoder().encode(JSON.stringify({ ...notes, version: 999 })));
      expect(await loadScanState(storage)).toBeUndefined();
    });

    it('clearScanState removes every scan record, chunks included', async () => {
      const storage = new MemoryStorageAdapter();
      await storage.open(ns);
      await saveScanState(storage, await stateWithLeaves(TREE_CHUNK_SIZE + 5), 500);
      await storage.put('chain/pending-spends', new TextEncoder().encode('[]')); // not a scan record: kept
      await clearScanState(storage);
      expect(await keysOf(storage)).toEqual(['chain/pending-spends']);
    });
  });
});
