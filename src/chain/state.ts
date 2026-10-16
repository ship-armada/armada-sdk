// ABOUTME: ChainState (F1, #143) — the instance's one view of the pool: the verified trees and the chain checkpoint,
// ABOUTME: advanced by a single sync driver (fetch, apply, verify, save) whose verified batches feed the wallets.

import { TreeStore } from '../sync/tree-store';
import { shieldCommitmentMatches } from '../sync/shield-crypto';
import { loadChainState, saveChainState, clearChainState } from '../sync/scan-persistence';
import type { DecodedPoolEvents } from '../sync/event-decoder';
import type { EventSource } from '../sync/event-source';
import type { StorageAdapter } from '../storage/index';
import type { ChainClient } from './client';
import type { ReorgRecoveryReason, TelemetrySink } from '../index';
import { InstanceClosedError, QuickSyncSchemaError, RootMismatchError } from '../errors';
import { finalRootCheckRequired, quickSyncTelemetry, scanStateMissingLeaves, shouldRecoverFromReorg } from './sync-rules';

export interface ChainStateDeps {
  readonly client: ChainClient;
  /** Primary event source — the indexer when configured, else the RPC source. */
  readonly eventSource: EventSource;
  /** Always the RPC source: covers any tail the indexer lags, and is the verification fallback. */
  readonly rpcEventSource: EventSource;
  /** The instance's shared scope of the storage adapter. Chain state is public, so it's stored in plaintext. */
  readonly storage: StorageAdapter;
  /** Pool deploy block — where the trees start. */
  readonly deployBlock: number;
  readonly telemetry?: TelemetrySink;
  /** Whether the SDK is closing: a sync then stops before saving, with `InstanceClosedError`. */
  readonly isClosed: () => boolean;
}

/** A batch the chain verified and committed: its block range, the hash of its last block, and its events. */
export interface ChainAdvance {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly toBlockHash?: string;
  readonly events: DecodedPoolEvents;
}

/** An empty event batch. */
export const noEvents = (): DecodedPoolEvents => ({ shields: [], transacts: [], nullifiers: [], unshields: [] });

function concatEvents(a: DecodedPoolEvents, b: DecodedPoolEvents): DecodedPoolEvents {
  return {
    shields: [...a.shields, ...b.shields],
    transacts: [...a.transacts, ...b.transacts],
    nullifiers: [...a.nullifiers, ...b.nullifiers],
    unshields: [...a.unshields, ...b.unshields],
  };
}

export class ChainState {
  // The committed (verified and saved) trees and checkpoint. A sync builds on a copy and swaps it in only once it's
  // verified and saved, so readers never see a half-applied or unverified batch.
  private committed = new TreeStore();
  private through: number;
  private throughHash: string | undefined;
  // One sync at a time across the instance: each builds on the committed state the last one left.
  private queue: Promise<unknown> = Promise.resolve();
  private running = 0;

  /** Runs whenever the chain resets for a rescan: the wallets drop their notes too (a reorg may have orphaned some). */
  onReset: (() => Promise<void>) | undefined;

  constructor(private readonly deps: ChainStateDeps) {
    this.through = deps.deployBlock - 1;
  }

  /** The verified trees. */
  get tree(): TreeStore {
    return this.committed;
  }

  /** The block the trees are verified through. */
  get syncedThrough(): number {
    return this.through;
  }

  /** The hash of `syncedThrough` when it was scanned, when the node returned it. */
  get syncedThroughHash(): string | undefined {
    return this.throughHash;
  }

  /** Whether a sync is running. */
  get syncing(): boolean {
    return this.running > 0;
  }

  /** Load the saved chain state, if any (a missing or unreadable record means a rescan from the deploy block). */
  async load(): Promise<void> {
    const saved = await loadChainState(this.deps.storage);
    if (saved !== undefined && saved.syncedThrough > this.through) {
      this.committed = saved.tree;
      this.through = saved.syncedThrough;
      this.throughHash = saved.syncedThroughHash;
    }
  }

  /** Run `fn` once every sync queued before it has finished: syncs (and wallet catch-ups) never overlap. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.running += 1;
      try {
        return await fn();
      } finally {
        this.running -= 1;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Fetch the pool events in `[fromBlock, toBlock]` from `source`, RPC-covering any tail it lagged. Returns the events
   * and whether RPC covered a tail. Doesn't touch the trees.
   */
  async fetchEvents(
    source: EventSource,
    fromBlock: number,
    toBlock: number,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<{ events: DecodedPoolEvents; tailCovered: boolean }> {
    const batch = await source.getEvents(fromBlock, toBlock, onProgress);
    if (batch.syncedThroughBlock < toBlock) {
      const tail = await this.deps.rpcEventSource.getEvents(batch.syncedThroughBlock + 1, toBlock, onProgress);
      return { events: concatEvents(batch.events, tail.events), tailCovered: true };
    }
    return { events: batch.events, tailCovered: false };
  }

  /**
   * If the chain was reorganised under the checkpoint (SPEC §4.4) — the block hash recorded when `syncedThrough` was
   * scanned is no longer the chain's hash at that height — reset for a rescan: the append-only tree can't un-append
   * an orphaned leaf. A reorg at or below the checkpoint always changes that hash, including the commonest shapes (a
   * tx re-included one block later, a same-height replacement), which otherwise surface as a position gap or as no
   * error at all. Checked before the head comparison: a same-height reorg leaves the head unchanged.
   */
  async resetIfReorged(): Promise<void> {
    if (this.throughHash === undefined) return;
    const canonical = await this.deps.client.getBlockHash(this.through);
    if (canonical !== undefined && canonical !== this.throughHash) await this.resetForRescan('checkpoint-reorged');
  }

  /**
   * Advance the trees from the checkpoint to `head` (whose hash is `headHash`, when the node returned it): fetch the
   * events, apply their leaves to a copy, verify it, save it, then commit it. Returns the verified batch, for the
   * wallets to read their notes from, or undefined when the checkpoint is already at `head`.
   */
  async advance(
    head: number,
    headHash: string | undefined,
    onProgress?: (coveredThroughBlock: number) => void,
    recovering = false,
  ): Promise<ChainAdvance | undefined> {
    if (head <= this.through) return undefined;
    const fromBlock = this.through + 1;
    // Pin verification to the exact block scanned — by hash when the node returns it — so the pool state the tree is
    // checked against is the state the logs came from; a reorg of `head` mid-sync makes the pinned read fail instead
    // of verifying against a different chain.
    const blockTag = headHash ?? head;
    const usingIndexer = this.deps.eventSource !== this.deps.rpcEventSource;
    // Apply the batch to a COPY of the committed trees; it replaces them only once it is verified and saved. ANY
    // failure below — a partial apply, a root mismatch, a save error — just discards the copy: the committed state
    // and checkpoint were never touched, so a retry re-scans the range cleanly.
    let next = this.committed.clone();
    try {
      let events: DecodedPoolEvents;
      let tailCovered = false;
      let fellBack = false;
      // Preserved so telemetry can classify WHY the indexer batch was discarded (#83) — an HTTP 404, a
      // wire-schema skew, a position gap, or a genuine root mismatch, not one mislabel for all four.
      let fallbackCause: unknown;

      if (usingIndexer) {
        try {
          // The indexer is untrusted: its fetch, wire-schema parse, apply, AND root-verify all live inside this try
          // so ANY failure — malformed/garbage response, HTTP error, position gap, root mismatch, a shield whose
          // value or token doesn't match its leaf hash — discards the batch and re-scans from RPC (the source of
          // truth), rather than failing the whole sync on a degraded indexer (SPEC §4.4).
          ({ events, tailCovered } = await this.fetchEvents(this.deps.eventSource, fromBlock, head, onProgress));
          assertShieldsMatchLeaves(events);
          next.applyLeaves(events);
          await this.verifySyncedTree(next, head, blockTag);
        } catch (err) {
          fellBack = true;
          fallbackCause = err;
          next = this.committed.clone();
          ({ events } = await this.fetchEvents(this.deps.rpcEventSource, fromBlock, head, onProgress));
          next.applyLeaves(events);
        }
      } else {
        ({ events, tailCovered } = await this.fetchEvents(this.deps.rpcEventSource, fromBlock, head, onProgress));
        next.applyLeaves(events);
      }

      // Final guard (SPEC §4.4): the accepted tree — RPC baseline or post-fallback RPC rescan — must reproduce the
      // on-chain root. This is the ONLY verification on the pure-RPC path; a mismatch means the provider returned
      // bad/truncated logs. It throws → the copy is discarded and the checkpoint doesn't advance.
      if (finalRootCheckRequired(usingIndexer, fellBack)) {
        await this.verifySyncedTree(next, head, blockTag);
      }

      // Quick-sync observability (SPEC §8): report whether the configured indexer served a root-verified batch,
      // lagged into an RPC tail, or was rejected for an RPC re-scan — and, on a rejection, the classified `reason`
      // (+ HTTP status) for it. No-op when no indexer is configured. Never carries key material / addresses.
      const qs = quickSyncTelemetry({ usingIndexer, tailCovered, fellBack, fromBlock, head, cause: fallbackCause });
      if (qs !== null) this.deps.telemetry?.emit(qs.event, qs.data);

      if (this.deps.isClosed()) throw new InstanceClosedError('sync: cancelled by sdk.close()');
      await saveChainState(
        this.deps.storage,
        next,
        { syncedThrough: head, ...(headHash !== undefined ? { syncedThroughHash: headHash } : {}) },
        this.committed,
      );
      // Commit: only now — verified and saved — do the new trees become the ones readers see.
      this.committed = next;
      this.through = head;
      this.throughHash = headHash;
      return { fromBlock, toBlock: head, ...(headHash !== undefined ? { toBlockHash: headHash } : {}), events: events! };
    } catch (err) {
      if (this.deps.isClosed()) {
        throw err instanceof InstanceClosedError ? err : new InstanceClosedError('sync: cancelled by sdk.close()', { cause: err });
      }
      // Two failures no retry can fix, so self-heal by rescanning from the deploy block (`recovering` guards a loop):
      // (1) the local tree is missing leaves — a leaf arrived past its next position, so part of the chain was
      // skipped; (2) a reorg removed an already-PERSISTED leaf the hash check couldn't see (a record saved without a
      // hash), so the committed state itself fails root verification.
      if (!recovering && scanStateMissingLeaves(err)) return this.rescan('missing-leaves', head, headHash, onProgress);
      if (shouldRecoverFromReorg(err, await this.committedRootsInvalid(head), recovering)) {
        return this.rescan('persisted-root-invalid', head, headHash, onProgress);
      }
      throw err;
    }
  }

  private async rescan(
    reason: ReorgRecoveryReason,
    head: number,
    headHash: string | undefined,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<ChainAdvance | undefined> {
    await this.resetForRescan(reason);
    return this.advance(head, headHash, onProgress, true);
  }

  /**
   * Reset the chain state (in memory + the saved records) and the wallets' notes, to rescan from the deploy block
   * (blunt recovery — a surgical per-tree rebuild is tracked in issue #75). `reason` goes to telemetry (SPEC §8-safe:
   * an enum and a block number) so an operator can see why rescans happen.
   */
  private async resetForRescan(reason: ReorgRecoveryReason): Promise<void> {
    this.deps.telemetry?.emit('sync.reorg-recovery', { fromBlock: this.deps.deployBlock, reason });
    this.committed = new TreeStore();
    this.through = this.deps.deployBlock - 1;
    this.throughHash = undefined;
    // Delete the poisoned records so a crash mid-rescan can't load them again.
    await clearChainState(this.deps.storage);
    await this.onReset?.();
  }

  /** True if the committed (= persisted) trees fail on-chain root verification. */
  private async committedRootsInvalid(head: number): Promise<boolean> {
    try {
      await this.verifyRoots(this.committed, head);
      return false;
    } catch (err) {
      return err instanceof RootMismatchError;
    }
  }

  /**
   * Verify EVERY built tree's root is an accepted on-chain root for that tree (`pool.rootHistory`), not
   * just the current (highest) tree. A dropped tail of a COMPLETED tree does not shift the current tree's
   * root, so a single-tree check misses it; a per-tree `rootHistory` membership check catches any
   * dropped/reordered/extra commitment in any tree. `rootHistory` is cumulative, so the current tree's
   * live root is a member too. `head` is informational (the check is against current chain state).
   */
  private async verifyRoots(tree: TreeStore, head: number): Promise<void> {
    await Promise.all(
      tree.treeNumbers().map(async (treeNumber) => {
        const computed = tree.root(treeNumber);
        const root = BigInt(computed.startsWith('0x') ? computed : `0x${computed}`);
        if (!(await this.deps.client.isKnownRoot(treeNumber, root))) {
          throw new RootMismatchError(`sync: tree ${treeNumber} root ${computed} not in pool rootHistory @block ${head}`);
        }
      }),
    );
  }

  /**
   * Verify the trees a sync built are EXACTLY the pool's at the scanned block (SPEC §4.4): the pool's current tree
   * number, leaf count, and root, read pinned to `blockTag`, must match the local tree — and every earlier tree must
   * still pass `verifyRoots`. Membership alone isn't enough for the current tree: the pool records a root after every
   * insert, so a log set cut off at an event boundary (a lagging getLogs backend, an indexer omitting its tail) has a
   * historical root and would pass, letting the checkpoint skip the missing events.
   */
  private async verifySyncedTree(tree: TreeStore, head: number, blockTag: string | number): Promise<void> {
    await this.verifyRoots(tree, head);
    const pool = await this.deps.client.readPoolTree(blockTag);
    const localRoot = BigInt(`0x${tree.root(pool.treeNumber)}`);
    const localLeaves = tree.length(pool.treeNumber);
    const aheadOfPool = tree.treeNumbers().some((t) => t > pool.treeNumber);
    if (aheadOfPool || localLeaves !== pool.nextLeafIndex || localRoot !== pool.merkleRoot) {
      throw new RootMismatchError(
        `sync: tree ${pool.treeNumber} built locally (${localLeaves} leaves, root 0x${localRoot.toString(16)}) does not match ` +
          `the pool @block ${head} (${pool.nextLeafIndex} leaves, root 0x${pool.merkleRoot.toString(16)})`,
      );
    }
  }
}

/**
 * Throw `QuickSyncSchemaError` if any shield's value or token doesn't match its leaf hash. Root verification binds
 * only the leaf hashes, and the RPC decoder derives each shield's hash from these same fields, so a mismatch can only
 * come from a quick-sync indexer misstating a shield — whoever's it is.
 */
export function assertShieldsMatchLeaves(events: DecodedPoolEvents): void {
  for (const c of events.shields) {
    if (!shieldCommitmentMatches(c)) {
      throw new QuickSyncSchemaError(`quick-sync: shield ${c.tree}:${c.position} value/token does not match its leaf hash`);
    }
  }
}

/**
 * Throw `RootMismatchError` unless every commitment in `events` is the leaf `tree` already holds at its position —
 * how a wallet catching up checks a batch against trees verified earlier, without verifying roots again.
 */
export function assertMatchesTree(events: DecodedPoolEvents, tree: TreeStore): void {
  for (const c of [...events.shields, ...events.transacts]) {
    const leaf = tree.leaf(c.tree, c.position);
    if (leaf === undefined || BigInt(`0x${strip0x(leaf)}`) !== BigInt(`0x${strip0x(c.hash)}`)) {
      throw new RootMismatchError(`catch-up: commitment ${c.tree}:${c.position} does not match the verified tree`);
    }
  }
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}
