// ABOUTME: TreeStore (F1, #143) — the chain-public half of a scan: one append-only merkletree per pool tree number,
// ABOUTME: with position-gap checks, roots, proofs and cheap clones. Holds nothing about any wallet.

import { UTXOMerkletree, type MerkleProof } from './merkletree';
import { PositionGapError } from '../errors';
import type { DecodedPoolEvents } from './event-decoder';

export class TreeStore {
  private readonly trees = new Map<number, UTXOMerkletree>();

  /** Rebuild from persisted leaves, one entry per tree, each in position order. */
  static fromLeaves(entries: Iterable<{ readonly tree: number; readonly leaves: readonly string[] }>): TreeStore {
    const store = new TreeStore();
    for (const { tree, leaves } of entries) {
      const merkletree = new UTXOMerkletree();
      merkletree.insertMany(leaves);
      store.trees.set(tree, merkletree);
    }
    return store;
  }

  /**
   * Append the leaf at `(tree, position)`. Leaves must arrive in position order: the append-only tree requires each
   * leaf's position to equal the tree's current length, and a gap throws `PositionGapError`.
   */
  insertLeaf(tree: number, position: number, hash: string): void {
    let merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      merkletree = new UTXOMerkletree();
      this.trees.set(tree, merkletree);
    }
    const expected = merkletree.length;
    if (position !== expected) {
      throw new PositionGapError(`scan: merkle position gap in tree ${tree}: expected ${expected}, got ${position}`, {
        expected,
        received: position,
      });
    }
    merkletree.insert(hash);
  }

  /** Append every commitment in `events` (shields and transacts) in `(tree, position)` order. */
  applyLeaves(events: DecodedPoolEvents): void {
    const leaves = [...events.shields, ...events.transacts].sort((a, b) => a.tree - b.tree || a.position - b.position);
    for (const { tree, position, hash } of leaves) this.insertLeaf(tree, position, hash);
  }

  /** The leaf at `(tree, position)`, or undefined past the tree's end. */
  leaf(tree: number, position: number): string | undefined {
    return this.trees.get(tree)?.getLeaves()[position];
  }

  /** Current commitment root of `tree` (no-0x hex); the empty-tree root if unseen. */
  root(tree: number): string {
    return (this.trees.get(tree) ?? new UTXOMerkletree()).root();
  }

  /** Tree numbers with at least one inserted leaf, ascending. */
  treeNumbers(): number[] {
    return [...this.trees.keys()].sort((a, b) => a - b);
  }

  /** Number of leaves inserted into `tree`. */
  length(tree: number): number {
    return this.trees.get(tree)?.length ?? 0;
  }

  /** `tree`'s leaves in position order. */
  leaves(tree: number): readonly string[] {
    return this.trees.get(tree)?.getLeaves() ?? [];
  }

  /** Merkle proof for the leaf at `(tree, position)`. */
  merkleProof(tree: number, position: number): MerkleProof {
    const merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      throw new Error(`merkleProof: unknown tree ${tree}`);
    }
    return merkletree.merkleProof(position);
  }

  /** An independent copy; each tree copies its levels without rehashing. */
  clone(): TreeStore {
    const copy = new TreeStore();
    for (const [tree, merkletree] of this.trees) copy.trees.set(tree, merkletree.clone());
    return copy;
  }
}
