// ABOUTME: In-memory incremental UTXO merkletree (SPEC §4.4) — inserts commitment leaves, computes the
// ABOUTME: depth-16 Poseidon root, and generates proofs verifiable by core.verifyMerkleProof.

import { hashLeftRight, MERKLE_ZERO_VALUE, TREE_DEPTH } from '../core/index';
import { InternalError } from '../errors';

export interface MerkleProof {
  readonly leaf: string;
  readonly elements: string[];
  readonly indices: string;
  readonly root: string;
}

// No 0x prefix — matches the engine's getMerkleProof `indices` format (bit i = right-child at level i).
function indicesHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

// zeros[level] = the all-empty subtree root at `level` (zeros[0] = MERKLE_ZERO_VALUE). The same for every tree, so
// computed once, on first use (Poseidon must be initialized by then).
let sharedZeros: readonly string[] | undefined;
function zeroValues(): readonly string[] {
  if (sharedZeros === undefined) {
    const zeros: string[] = [MERKLE_ZERO_VALUE];
    for (let level = 1; level <= TREE_DEPTH; level += 1) {
      const below = zeros[level - 1]!;
      zeros[level] = hashLeftRight(below, below);
    }
    sharedZeros = zeros;
  }
  return sharedZeros;
}

/**
 * Append-only merkletree matching the pinned core (depth 16, Poseidon `hashLeftRight`, zero-padding). Keeps every
 * level, so an insert rehashes only the nodes above the new leaves, and `root()`/`merkleProof()` do no hashing.
 * Roots + proofs are byte-identical to the stock engine's tree for the same leaves.
 */
export class UTXOMerkletree {
  private readonly zeros = zeroValues();
  // levels[0] holds the leaves; levels[l][i] = hash(levels[l-1][2i], levels[l-1][2i+1] or level l-1's zero value).
  // A node exists once any leaf below it does, so levels[TREE_DEPTH][0] is the root of a non-empty tree.
  private readonly levels: string[][] = Array.from({ length: TREE_DEPTH + 1 }, () => []);

  insert(commitment: string): void {
    this.insertMany([commitment]);
  }

  /** Append `commitments`, then rehash only the nodes above them: O(batch + depth) hashes, not a rebuild. */
  insertMany(commitments: readonly string[]): void {
    if (commitments.length === 0) return;
    const leaves = this.levels[0]!;
    let from = leaves.length;
    for (const c of commitments) leaves.push(c);
    let to = leaves.length - 1;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const current = this.levels[level]!;
      const parents = this.levels[level + 1]!;
      from >>= 1;
      to >>= 1;
      for (let p = from; p <= to; p += 1) {
        const left = current[2 * p]!;
        const right = 2 * p + 1 < current.length ? current[2 * p + 1]! : this.zeros[level]!;
        parents[p] = hashLeftRight(left, right);
      }
    }
  }

  get length(): number {
    return this.levels[0]!.length;
  }

  /** The inserted leaves in position order — used to snapshot the tree for persistence. */
  getLeaves(): readonly string[] {
    return this.levels[0]!;
  }

  root(): string {
    return this.levels[TREE_DEPTH]![0] ?? this.zeros[TREE_DEPTH]!;
  }

  merkleProof(index: number): MerkleProof {
    if (index < 0 || index >= this.length) {
      throw new InternalError(`merkleProof: index ${index} out of range [0, ${this.length})`);
    }
    const elements: string[] = [];
    let indicesBig = 0n;
    let pos = index;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const current = this.levels[level]!;
      const isRightChild = (pos & 1) === 1;
      const siblingIndex = isRightChild ? pos - 1 : pos + 1;
      const sibling = siblingIndex < current.length ? current[siblingIndex]! : this.zeros[level]!;
      elements.push(sibling);
      if (isRightChild) indicesBig |= 1n << BigInt(level);
      pos = Math.floor(pos / 2);
    }
    return { leaf: this.levels[0]![index]!, elements, indices: indicesHex(indicesBig), root: this.root() };
  }

  /** An independent copy, without rehashing: the levels are copied as they are. */
  clone(): UTXOMerkletree {
    const copy = new UTXOMerkletree();
    this.levels.forEach((level, i) => {
      copy.levels[i] = level.slice();
    });
    return copy;
  }
}
