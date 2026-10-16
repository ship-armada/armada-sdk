// ABOUTME: Persist/restore scan state through a StorageAdapter (SPEC §4.3/§4.4) so sync resumes from the last synced
// ABOUTME: block: the instance's chain state (checkpoint + tree chunks) and each wallet's notes (one versioned record).

import type { StorageAdapter, StorageOp } from '../storage/index';
import { TreeStore } from './tree-store';
import { WalletNotes, WALLET_NOTES_VERSION, type WalletNotesSnapshot } from './wallet-notes';

interface PersistedChainCheckpoint {
  readonly syncedThrough: number;
  /**
   * Block hash of `syncedThrough` when it was scanned — the reorg check compares it to the chain's current
   * hash at that height. Optional: absent when the node didn't return the block; the check is skipped once,
   * then gained on the next save.
   */
  readonly syncedThroughHash?: string;
  /** Each tree's leaf count — which chunks hold the tree, and how full the last one is. */
  readonly treeLengths: ReadonlyArray<readonly [number, number]>;
}

type PersistedNotes = WalletNotesSnapshot & {
  readonly version: number;
  /** The block the notes are synced through, and its hash (see `PersistedChainCheckpoint`). */
  readonly syncedThrough: number;
  readonly syncedThroughHash?: string;
};

/** A persisted scan position: the block synced through, and its hash when the node returned it. */
export interface SyncedThrough {
  readonly syncedThrough: number;
  readonly syncedThroughHash?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// `chain/` → chain-derived, so resetChainState() wipes these on redeploy (keeps identity records). The chain records
// live in the instance's shared scope (plaintext: leaf hashes are public); the notes record in each wallet's scoped,
// encrypted store, under its opaque tag — never its 0zk address, since keys are stored in plaintext (SPEC §4.3).
export const CHECKPOINT_KEY = 'chain/checkpoint';
export const TREE_PREFIX = 'chain/tree/';
export const NOTES_KEY = 'chain/notes';
/** Leaves per tree record: a sync rewrites only the last, partly filled chunk and any new ones. */
export const TREE_CHUNK_SIZE = 1024;

// Two digits: a depth-16 tree holds 65,536 leaves, so at most 64 chunks.
function chunkKey(tree: number, chunk: number): string {
  return `${TREE_PREFIX}${tree}/${String(chunk).padStart(2, '0')}`;
}

function chunkCount(length: number): number {
  return Math.ceil(length / TREE_CHUNK_SIZE);
}

const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

/**
 * Persist the chain state — every tree's leaves and the checkpoint — in one batch. Pass `saved`, the tree the store
 * already holds, to rewrite only the chunks that changed since; without it every chunk is written. A relaxed write:
 * chain state is a cache a rescan rebuilds.
 */
export async function saveChainState(
  storage: StorageAdapter,
  tree: TreeStore,
  position: SyncedThrough,
  saved?: TreeStore,
): Promise<void> {
  const ops: StorageOp[] = [];
  const treeLengths: [number, number][] = [];
  for (const treeNumber of tree.treeNumbers()) {
    const leaves = tree.leaves(treeNumber);
    treeLengths.push([treeNumber, leaves.length]);
    const savedLength = saved?.length(treeNumber) ?? 0;
    if (saved !== undefined && savedLength === leaves.length) continue;
    for (let chunk = Math.floor(savedLength / TREE_CHUNK_SIZE); chunk < chunkCount(leaves.length); chunk += 1) {
      const slice = leaves.slice(chunk * TREE_CHUNK_SIZE, (chunk + 1) * TREE_CHUNK_SIZE);
      ops.push({ type: 'put', key: chunkKey(treeNumber, chunk), value: json(slice) });
    }
  }
  const checkpoint: PersistedChainCheckpoint = { ...position, treeLengths };
  ops.push({ type: 'put', key: CHECKPOINT_KEY, value: json(checkpoint) });
  await storage.batch(ops);
}

/**
 * Load the persisted chain state, or `undefined` on a first run OR when any stored record is unreadable. Chain state
 * is a cache: a corrupt record (a bit-flip, an interrupted write, a missing chunk) must degrade to a cache MISS so the
 * chain rescans from the pool's deploy block — not throw and brick every future sync (the "delete the DB by hand"
 * pitfall §4.3 deletes). The next save overwrites the records it needs; a stale chunk past a tree's recorded length is
 * never read.
 */
export async function loadChainState(storage: StorageAdapter): Promise<({ tree: TreeStore } & SyncedThrough) | undefined> {
  try {
    const checkpoint = await readJson<PersistedChainCheckpoint>(storage, CHECKPOINT_KEY);
    if (checkpoint === undefined || typeof checkpoint.syncedThrough !== 'number' || !Array.isArray(checkpoint.treeLengths)) {
      return undefined;
    }
    const trees: { tree: number; leaves: string[] }[] = [];
    for (const [tree, length] of checkpoint.treeLengths) {
      const leaves: string[] = [];
      for (let chunk = 0; chunk < chunkCount(length); chunk += 1) {
        const part = await readJson<string[]>(storage, chunkKey(tree, chunk));
        if (!Array.isArray(part)) return undefined;
        leaves.push(...part);
      }
      if (leaves.length !== length) return undefined;
      trees.push({ tree, leaves });
    }
    return { tree: TreeStore.fromLeaves(trees), ...syncedThroughOf(checkpoint) };
  } catch {
    // Malformed JSON, or leaves that won't rebuild — rescan rather than wedge.
    return undefined;
  }
}

/** Delete the chain state: the checkpoint and the tree chunks it lists. */
export async function clearChainState(storage: StorageAdapter): Promise<void> {
  let checkpoint: PersistedChainCheckpoint | undefined;
  try {
    checkpoint = await readJson<PersistedChainCheckpoint>(storage, CHECKPOINT_KEY);
  } catch {
    // Unreadable: its chunks can't be listed, but no later checkpoint will point at them past what it rewrites.
    checkpoint = undefined;
  }
  const ops: StorageOp[] = [];
  for (const [tree, length] of checkpoint?.treeLengths ?? []) {
    for (let chunk = 0; chunk < chunkCount(length); chunk += 1) ops.push({ type: 'del', key: chunkKey(tree, chunk) });
  }
  ops.push({ type: 'del', key: CHECKPOINT_KEY });
  await storage.batch(ops);
}

/** Persist a wallet's notes and the block they're synced through, as one record, through the wallet's scoped store. */
export async function saveWalletNotes(storage: StorageAdapter, notes: WalletNotes, position: SyncedThrough): Promise<void> {
  const record: PersistedNotes = { version: WALLET_NOTES_VERSION, ...position, ...notes.snapshot() };
  await storage.put(NOTES_KEY, json(record));
}

/**
 * Load a wallet's persisted notes, or `undefined` on a first run OR when the record is unreadable — an EncryptedStore
 * GCM failure, malformed JSON, notes of another format version — so the wallet rescans its notes rather than wedging.
 */
export async function loadWalletNotes(storage: StorageAdapter): Promise<({ notes: WalletNotes } & SyncedThrough) | undefined> {
  try {
    const record = await readJson<PersistedNotes>(storage, NOTES_KEY);
    if (record === undefined || record.version !== WALLET_NOTES_VERSION || typeof record.syncedThrough !== 'number') {
      return undefined;
    }
    return { notes: WalletNotes.restore(record), ...syncedThroughOf(record) };
  } catch {
    return undefined;
  }
}

/** Delete a wallet's notes record. */
export async function clearWalletNotes(storage: StorageAdapter): Promise<void> {
  await storage.del(NOTES_KEY);
}

function syncedThroughOf(record: SyncedThrough): SyncedThrough {
  return {
    syncedThrough: record.syncedThrough,
    ...(typeof record.syncedThroughHash === 'string' ? { syncedThroughHash: record.syncedThroughHash } : {}),
  };
}

async function readJson<T>(storage: StorageAdapter, key: string): Promise<T | undefined> {
  const raw = await storage.get(key);
  return raw === undefined ? undefined : (JSON.parse(decoder.decode(raw)) as T);
}
