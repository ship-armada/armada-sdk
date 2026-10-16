// ABOUTME: Persist/restore a wallet's scan state through a StorageAdapter (SPEC §4.3/§4.4) so sync() resumes from the
// ABOUTME: last synced block: a checkpoint, the wallet's notes, and each tree's leaves in fixed-size chunks.

import type { StorageAdapter, StorageOp } from '../storage/index';
import { WalletScanState } from './scan-engine';
import { WALLET_NOTES_VERSION, type WalletNotesSnapshot } from './wallet-notes';

interface PersistedCheckpoint {
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

type PersistedNotes = WalletNotesSnapshot & { readonly version: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// `chain/` → chain-derived, so resetChainState() wipes these on redeploy (keeps identity records). The keys are per
// wallet because `storage` is the wallet's scoped store (see `resolveWalletStorage`), which files them under the
// wallet's opaque tag — never its 0zk address, since keys are stored in plaintext (SPEC §4.3).
export const CHECKPOINT_KEY = 'chain/checkpoint';
export const NOTES_KEY = 'chain/notes';
export const TREE_PREFIX = 'chain/tree/';
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
 * Persist a wallet's scan state + the highest synced block (and that block's hash, when known), through the wallet's
 * scoped store, in one batch. Pass `saved` — the state this store already holds — to rewrite only the tree chunks
 * that changed since; without it every chunk is written. A relaxed write: scan state is a cache a rescan rebuilds.
 */
export async function saveScanState(
  storage: StorageAdapter,
  state: WalletScanState,
  syncedThrough: number,
  syncedThroughHash?: string,
  saved?: WalletScanState,
): Promise<void> {
  const ops: StorageOp[] = [];
  const treeLengths: [number, number][] = [];
  for (const tree of state.treeNumbers()) {
    const leaves = state.trees.leaves(tree);
    treeLengths.push([tree, leaves.length]);
    const savedLength = saved?.treeLength(tree) ?? 0;
    if (saved !== undefined && savedLength === leaves.length) continue;
    for (let chunk = Math.floor(savedLength / TREE_CHUNK_SIZE); chunk < chunkCount(leaves.length); chunk += 1) {
      const slice = leaves.slice(chunk * TREE_CHUNK_SIZE, (chunk + 1) * TREE_CHUNK_SIZE);
      ops.push({ type: 'put', key: chunkKey(tree, chunk), value: json(slice) });
    }
  }
  const notes: PersistedNotes = { version: WALLET_NOTES_VERSION, ...state.walletNotes.snapshot() };
  const checkpoint: PersistedCheckpoint = {
    syncedThrough,
    ...(syncedThroughHash !== undefined ? { syncedThroughHash } : {}),
    treeLengths,
  };
  ops.push({ type: 'put', key: NOTES_KEY, value: json(notes) }, { type: 'put', key: CHECKPOINT_KEY, value: json(checkpoint) });
  await storage.batch(ops);
}

/**
 * Load a wallet's persisted scan state, or `undefined` on a first run OR when any stored record is
 * unreadable. Scan state is a chain-derived cache: a corrupt blob (a bit-flip, an interrupted write, an
 * undecryptable record after a key/format change, a missing chunk, notes of another format version) must
 * degrade to a cache MISS so `sync()` rescans from the pool's deploy block — not throw and brick every future
 * sync (the "delete the DB by hand" pitfall §4.3 deletes). The next save overwrites the records it needs; a
 * stale chunk past a tree's recorded length is never read.
 */
export async function loadScanState(
  storage: StorageAdapter,
): Promise<{ state: WalletScanState; syncedThrough: number; syncedThroughHash?: string } | undefined> {
  try {
    const checkpoint = await readJson<PersistedCheckpoint>(storage, CHECKPOINT_KEY);
    if (checkpoint === undefined || typeof checkpoint.syncedThrough !== 'number' || !Array.isArray(checkpoint.treeLengths)) {
      return undefined;
    }
    const notes = await readJson<PersistedNotes>(storage, NOTES_KEY);
    if (notes === undefined || notes.version !== WALLET_NOTES_VERSION) return undefined;
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
    return {
      state: WalletScanState.restore({ ...notes, trees }),
      syncedThrough: checkpoint.syncedThrough,
      ...(typeof checkpoint.syncedThroughHash === 'string' ? { syncedThroughHash: checkpoint.syncedThroughHash } : {}),
    };
  } catch {
    // e.g. an EncryptedStore GCM auth failure on a corrupted/foreign blob, malformed JSON, or a snapshot that won't
    // restore — rescan rather than wedge.
    return undefined;
  }
}

/** Delete a wallet's scan records: the checkpoint, the notes, and the tree chunks the checkpoint lists. */
export async function clearScanState(storage: StorageAdapter): Promise<void> {
  let checkpoint: PersistedCheckpoint | undefined;
  try {
    checkpoint = await readJson<PersistedCheckpoint>(storage, CHECKPOINT_KEY);
  } catch {
    // Unreadable: its chunks can't be listed, but no later checkpoint will point at them past what it rewrites.
    checkpoint = undefined;
  }
  const ops: StorageOp[] = [];
  for (const [tree, length] of checkpoint?.treeLengths ?? []) {
    for (let chunk = 0; chunk < chunkCount(length); chunk += 1) ops.push({ type: 'del', key: chunkKey(tree, chunk) });
  }
  ops.push({ type: 'del', key: NOTES_KEY }, { type: 'del', key: CHECKPOINT_KEY });
  await storage.batch(ops);
}

async function readJson<T>(storage: StorageAdapter, key: string): Promise<T | undefined> {
  const raw = await storage.get(key);
  return raw === undefined ? undefined : (JSON.parse(decoder.decode(raw)) as T);
}
