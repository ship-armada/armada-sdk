// ABOUTME: In-memory incremental UTXO merkletree (SPEC §4.4) — inserts commitment leaves, computes the
// ABOUTME: depth-16 Poseidon root, and generates proofs verifiable by core.verifyMerkleProof.

import { hashLeftRight, MERKLE_ZERO_VALUE, TREE_DEPTH } from '../core/index';

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

// zeros[level] = the all-empty subtree root at `level` (zeros[0] = MERKLE_ZERO_VALUE).
function computeZeros(): string[] {
  const zeros: string[] = [MERKLE_ZERO_VALUE];
  for (let level = 1; level <= TREE_DEPTH; level += 1) {
    const below = zeros[level - 1]!;
    zeros[level] = hashLeftRight(below, below);
  }
  return zeros;
}

/**
 * Append-only merkletree matching the pinned core (depth 16, Poseidon `hashLeftRight`, zero-padding).
 * Rebuilds levels on demand — fine for scan-sized batches; a persistent incremental variant is a later
 * optimization. Roots + proofs are byte-identical to the stock engine's tree for the same leaves.
 */
export class UTXOMerkletree {
  private readonly zeros = computeZeros();
  private readonly leaves: string[] = [];

  insert(commitment: string): void {
    this.leaves.push(commitment);
  }

  insertMany(commitments: readonly string[]): void {
    for (const c of commitments) this.leaves.push(c);
  }

  get length(): number {
    return this.leaves.length;
  }

  /** The inserted leaves in position order — used to snapshot the tree for persistence. */
  getLeaves(): readonly string[] {
    return this.leaves;
  }

  private buildLevels(): string[][] {
    const levels: string[][] = [this.leaves.slice()];
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const current = levels[level]!;
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = i + 1 < current.length ? current[i + 1]! : this.zeros[level]!;
        next.push(hashLeftRight(left, right));
      }
      levels.push(next);
    }
    return levels;
  }

  root(): string {
    if (this.leaves.length === 0) return this.zeros[TREE_DEPTH]!;
    return this.buildLevels()[TREE_DEPTH]![0] ?? this.zeros[TREE_DEPTH]!;
  }

  merkleProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`merkleProof: index ${index} out of range [0, ${this.leaves.length})`);
    }
    const levels = this.buildLevels();
    const elements: string[] = [];
    let indicesBig = 0n;
    let pos = index;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const current = levels[level]!;
      const isRightChild = (pos & 1) === 1;
      const siblingIndex = isRightChild ? pos - 1 : pos + 1;
      const sibling = siblingIndex < current.length ? current[siblingIndex]! : this.zeros[level]!;
      elements.push(sibling);
      if (isRightChild) indicesBig |= 1n << BigInt(level);
      pos = Math.floor(pos / 2);
    }
    return { leaf: this.leaves[index]!, elements, indices: indicesHex(indicesBig), root: this.root() };
  }
}
