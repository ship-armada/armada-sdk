// ABOUTME: Tests for scan-state persistence (§4.3/§4.4) — snapshot/restore round-trip, and saving/loading the chain
// ABOUTME: state (checkpoint + tree chunks) and a wallet's notes, with every unreadable record a cache miss.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import { MemoryStorageAdapter } from '../storage/index';
import { EncryptedStore, deriveStorageKey } from '../storage/encrypted';
import { ScopedStore } from '../storage/scoped';
import { WalletScanState } from './scan-engine';
import type { DecodedPoolEvents, DecodedTransactCommitment } from './event-decoder';
import type { CommitmentCiphertextV2 } from './note-crypto';
import {
  saveChainState,
  loadChainState,
  clearChainState,
  saveWalletNotes,
  loadWalletNotes,
  clearWalletNotes,
  TREE_CHUNK_SIZE,
} from './scan-persistence';
import type { StorageOp } from '../storage/index';
import { TreeStore } from './tree-store';

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

  const ns = { schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}` as `0x${string}`, deployBlock: 1 };
  const opened = async (): Promise<MemoryStorageAdapter> => {
    const storage = new MemoryStorageAdapter();
    await storage.open(ns);
    return storage;
  };

  it('saves and loads the chain state and a wallet\'s notes through a StorageAdapter', async () => {
    const storage = await opened();
    const state = await buildState();

    await saveChainState(storage, state.trees, { syncedThrough: 500 });
    await saveWalletNotes(new ScopedStore(storage, 'alice'), state.walletNotes, { syncedThrough: 500 });
    const chain = await loadChainState(storage);
    const notes = await loadWalletNotes(new ScopedStore(storage, 'alice'));

    expect(chain?.syncedThrough).toBe(500);
    expect(chain?.tree.root(0)).toBe(state.treeRoot(0));
    expect(notes?.syncedThrough).toBe(500);
    const restored = new WalletScanState(chain!.tree, notes!.notes);
    expect(restored.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
  });

  it('round-trips the checkpoint block hash, and loads records without one (#118)', async () => {
    const storage = await opened();
    const state = await buildState();
    const hash = `0x${'ab'.repeat(32)}`;

    await saveChainState(storage, state.trees, { syncedThrough: 500, syncedThroughHash: hash });
    expect((await loadChainState(storage))?.syncedThroughHash).toBe(hash);
    await saveWalletNotes(storage, state.walletNotes, { syncedThrough: 500, syncedThroughHash: hash });
    expect((await loadWalletNotes(storage))?.syncedThroughHash).toBe(hash);

    // A record saved when the node didn't return the block still loads; the reorg check just skips it once.
    const bob = new ScopedStore(storage, 'bob');
    await saveWalletNotes(bob, state.walletNotes, { syncedThrough: 500 });
    const noHash = await loadWalletNotes(bob);
    expect(noHash?.syncedThrough).toBe(500);
    expect(noHash?.syncedThroughHash).toBeUndefined();
  });

  it('returns undefined when nothing is persisted', async () => {
    const storage = await opened();
    expect(await loadChainState(storage)).toBeUndefined();
    expect(await loadWalletNotes(storage)).toBeUndefined();
  });

  it('degrades a corrupt (unparseable) record to a cache miss instead of throwing (M4)', async () => {
    // WHY: scan state is chain-derived cache. A bit-flip / interrupted write must rescan, not brick every
    // future sync — the in-process form of the "delete the DB by hand" pitfall §4.3 removes.
    const storage = await opened();
    const state = await buildState();
    await saveChainState(storage, state.trees, { syncedThrough: 500 });
    await saveWalletNotes(storage, state.walletNotes, { syncedThrough: 500 });
    await storage.put('chain/checkpoint', new TextEncoder().encode('{not valid json'));
    await storage.put('chain/notes', new TextEncoder().encode('{not valid json'));
    expect(await loadChainState(storage)).toBeUndefined();
    expect(await loadWalletNotes(storage)).toBeUndefined();
  });

  it('degrades undecryptable notes to a cache miss (M4, GCM auth failure)', async () => {
    // A record written under one key and read under another (key rotation / corruption) throws GCM auth
    // failure inside get(); loadWalletNotes must swallow it and rescan rather than propagate and wedge sync.
    const inner = await opened();
    const writer = new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(1)));
    await saveWalletNotes(writer, (await buildState()).walletNotes, { syncedThrough: 42 });

    const reader = new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(2))); // wrong key
    expect(await loadWalletNotes(reader)).toBeUndefined();
  });

  it('treats notes of another format version as a cache miss', async () => {
    const storage = await opened();
    await saveWalletNotes(storage, (await buildState()).walletNotes, { syncedThrough: 500 });
    const record = JSON.parse(new TextDecoder().decode((await storage.get('chain/notes'))!)) as { version: number };
    await storage.put('chain/notes', new TextEncoder().encode(JSON.stringify({ ...record, version: 999 })));
    expect(await loadWalletNotes(storage)).toBeUndefined();
  });

  it('clearWalletNotes removes the notes record', async () => {
    const storage = await opened();
    await saveWalletNotes(storage, (await buildState()).walletNotes, { syncedThrough: 500 });
    await clearWalletNotes(storage);
    expect(await loadWalletNotes(storage)).toBeUndefined();
  });

  describe('the chain state: a checkpoint and the tree in chunks (SYNC-9, #143)', () => {
    // WHY: the whole scan state — every tree's leaves, every pool nullifier and unshield — was one record, rebuilt,
    // re-encrypted and rewritten on every sync: about 20 MB per wallet at 100k leaves, hitting IndexedDB quota.

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
    function treeWithLeaves(count: number): TreeStore {
      const tree = new TreeStore();
      for (let i = 0; i < count; i += 1) tree.insertLeaf(0, i, leafHex(i + 1));
      return tree;
    }

    it(`stores the tree in chunks of ${TREE_CHUNK_SIZE} leaves, beside the checkpoint, in one batch`, async () => {
      const storage = new RecordingStorage();
      await storage.open(ns);
      await saveChainState(storage, treeWithLeaves(TREE_CHUNK_SIZE + 5), { syncedThrough: 500 });
      expect(await keysOf(storage)).toEqual(['chain/checkpoint', 'chain/tree/0/00', 'chain/tree/0/01']);
      expect(storage.batches).toHaveLength(1);
      expect(storage.puts).toBe(0);
      expect((await loadChainState(storage))?.tree.length(0)).toBe(TREE_CHUNK_SIZE + 5);
    });

    it('given the tree it saved last, writes only the chunks that changed', async () => {
      const storage = new RecordingStorage();
      await storage.open(ns);
      const saved = treeWithLeaves(TREE_CHUNK_SIZE + 5);
      await saveChainState(storage, saved, { syncedThrough: 500 });
      const next = saved.clone();
      next.insertLeaf(0, TREE_CHUNK_SIZE + 5, leafHex(9999));
      await saveChainState(storage, next, { syncedThrough: 501 }, saved);
      expect(storage.batches[1]).toEqual(['put chain/tree/0/01', 'put chain/checkpoint']);
      expect((await loadChainState(storage))?.tree.root(0)).toBe(next.root(0));
    });

    it('treats a missing chunk as a cache miss', async () => {
      const storage = await opened();
      await saveChainState(storage, treeWithLeaves(TREE_CHUNK_SIZE + 5), { syncedThrough: 500 });
      await storage.del('chain/tree/0/00');
      expect(await loadChainState(storage)).toBeUndefined();
    });

    it('clearChainState removes the checkpoint and every chunk', async () => {
      const storage = await opened();
      await saveChainState(storage, treeWithLeaves(TREE_CHUNK_SIZE + 5), { syncedThrough: 500 });
      await storage.put('chain/pending-spends', new TextEncoder().encode('[]')); // not a chain-state record: kept
      await clearChainState(storage);
      expect(await keysOf(storage)).toEqual(['chain/pending-spends']);
    });
  });
});
