// ABOUTME: Wallet scan orchestrator (SPEC §4.4) — folds decoded pool events into per-tree merkletrees,
// ABOUTME: detects owned TXOs via injected decryptors, records nullifiers, verifies roots, projects balances.

import { TransactNote } from '../core/index';
import { UTXOMerkletree, type MerkleProof } from './merkletree';
import {
  computeBalances,
  type TXO,
  type SpentNullifier,
  type TokenBalance,
  type BalanceOptions,
} from './balances';
import type {
  DecodedPoolEvents,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
} from './event-decoder';
import { RootMismatchError } from '../errors';

/** The wallet-relevant fields a decryptor recovers from a commitment it owns. */
export interface OwnedNote {
  readonly tokenHash: string;
  readonly value: bigint;
  /** 16-byte note random (hex, no 0x) — carried into the TXO so the spend witness can be rebuilt. */
  readonly random: string;
  /** Note public key `poseidon(masterPublicKey, random)`. */
  readonly notePublicKey: bigint;
}

/** Returns the owned note if the commitment belongs to the wallet, else `undefined`. */
export type Decryptor<C> = (commitment: C) => Promise<OwnedNote | undefined>;

/** Map a decrypted transact note to an `OwnedNote` — the transact-decryptor's note→result adapter. */
export function ownedNoteFromTransactNote(note: TransactNote): OwnedNote {
  return { tokenHash: note.tokenHash, value: note.value, random: note.random, notePublicKey: note.notePublicKey };
}

/**
 * Per-commitment-type decryptors. `transact` wraps `tryDecryptCommitment`; `shield` (optional) is the
 * seam for shield-note ownership (ShieldNote ECDH via shieldKey) — omit it and shield leaves still
 * build the tree, they just don't contribute TXOs yet.
 */
export interface WalletDecryptors {
  readonly transact: Decryptor<DecodedTransactCommitment>;
  readonly shield?: Decryptor<DecodedShieldCommitment>;
}

/** The wallet-owned deltas produced by applying one event batch (for `note:received`/`balance:updated`). */
export interface ApplyResult {
  readonly ownedTxos: TXO[];
  readonly nullifiers: SpentNullifier[];
}

// Compare two commitment roots regardless of 0x-prefix / leading-zero padding.
function sameRoot(a: string, b: string): boolean {
  const norm = (h: string): bigint => BigInt(h.startsWith('0x') ? h : `0x${h}`);
  return norm(a) === norm(b);
}

/**
 * Accumulates wallet state across incremental scan batches. Leaves from ALL commitment types are
 * inserted into per-`treeNumber` merkletrees in `(tree, position)` order (append-only, position-gap
 * checked); commitments the wallet owns become TXOs; nullifiers are recorded tree-scoped. Balances are
 * a pure projection over the accumulated TXO/nullifier sets.
 */
export class WalletScanState {
  private readonly trees = new Map<number, UTXOMerkletree>();
  private readonly nextPosition = new Map<number, number>();
  private readonly txos: TXO[] = [];
  private readonly spent: SpentNullifier[] = [];

  /**
   * Fold a decoded event batch into wallet state. Batches MUST arrive in scan order (ascending
   * block/position) — the append-only merkletree requires each leaf's position to equal the tree's
   * current length. Returns the owned TXOs + nullifiers newly seen in this batch.
   */
  async apply(events: DecodedPoolEvents, decryptors: WalletDecryptors): Promise<ApplyResult> {
    // Unify shield + transact commitments into a single position-ordered leaf stream for tree building.
    type Leaf =
      | { readonly kind: 'shield'; readonly c: DecodedShieldCommitment }
      | { readonly kind: 'transact'; readonly c: DecodedTransactCommitment };
    const leaves: Leaf[] = [
      ...events.shields.map((c): Leaf => ({ kind: 'shield', c })),
      ...events.transacts.map((c): Leaf => ({ kind: 'transact', c })),
    ].sort((a, b) => a.c.tree - b.c.tree || a.c.position - b.c.position);

    const ownedTxos: TXO[] = [];
    for (const leaf of leaves) {
      const { tree, position, hash, blockNumber } = leaf.c;
      this.insertLeaf(tree, position, hash);

      const owned =
        leaf.kind === 'transact'
          ? await decryptors.transact(leaf.c)
          : await decryptors.shield?.(leaf.c);
      if (owned !== undefined) {
        const txo: TXO = {
          tree,
          position,
          tokenHash: owned.tokenHash,
          value: owned.value,
          blockNumber,
          random: owned.random,
          notePublicKey: owned.notePublicKey,
        };
        this.txos.push(txo);
        ownedTxos.push(txo);
      }
    }

    const nullifiers: SpentNullifier[] = events.nullifiers.map((n) => ({ tree: n.tree, nullifier: n.nullifier }));
    this.spent.push(...nullifiers);

    return { ownedTxos, nullifiers };
  }

  private insertLeaf(tree: number, position: number, hash: string): void {
    let merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      merkletree = new UTXOMerkletree();
      this.trees.set(tree, merkletree);
      this.nextPosition.set(tree, 0);
    }
    const expected = this.nextPosition.get(tree)!;
    if (position !== expected) {
      throw new Error(`scan: merkle position gap in tree ${tree}: expected ${expected}, got ${position}`);
    }
    merkletree.insert(hash);
    this.nextPosition.set(tree, expected + 1);
  }

  /** Current commitment root of `tree` (no-0x hex); the empty-tree root if unseen. */
  treeRoot(tree: number): string {
    const merkletree = this.trees.get(tree);
    return (merkletree ?? new UTXOMerkletree()).root();
  }

  /**
   * Verify each tree's locally-built root against the on-chain root (0x-prefixed or bare). Throws a
   * typed `RootMismatchError` (code `ROOT_MISMATCH`) carrying tree context on the first mismatch.
   */
  verifyRoots(expectedRoots: ReadonlyMap<number, string>): void {
    for (const [tree, expected] of expectedRoots) {
      const actual = this.treeRoot(tree);
      if (!sameRoot(actual, expected)) {
        throw new RootMismatchError(`tree ${tree}: expected root ${expected}, built ${actual}`);
      }
    }
  }

  /** Per-token spendable/pending over all accumulated TXOs + spent nullifiers. */
  balances(nullifyingKey: bigint, options: BalanceOptions): TokenBalance[] {
    return computeBalances(this.txos, this.spent, nullifyingKey, options);
  }

  get txoCount(): number {
    return this.txos.length;
  }

  /** Number of leaves inserted into `tree`. */
  treeLength(tree: number): number {
    return this.trees.get(tree)?.length ?? 0;
  }

  /** Merkle proof for a note at `(tree, position)` — the spend witness's `pathElements`/`leavesIndices`. */
  merkleProof(tree: number, position: number): MerkleProof {
    const merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      throw new Error(`merkleProof: unknown tree ${tree}`);
    }
    return merkletree.merkleProof(position);
  }

  /**
   * Unspent owned TXOs (tree-scoped nullifier–filtered), ready to hand to `planTransfer`. Excludes any
   * note whose `(tree, getNullifier(nullifyingKey, position))` appears in the recorded spent set.
   */
  spendableTxos(nullifyingKey: bigint): TXO[] {
    const spentSet = new Set(this.spent.map((s) => `${s.tree}:${s.nullifier.toString()}`));
    return this.txos.filter(
      (t) => !spentSet.has(`${t.tree}:${TransactNote.getNullifier(nullifyingKey, t.position).toString()}`),
    );
  }
}
