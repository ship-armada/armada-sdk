// ABOUTME: Tests for the incremental UTXO merkletree — self-consistent build/prove/verify, edge cases,
// ABOUTME: and a differential cross-check that reconstructs the captured merkle-vectors tree.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initPoseidonPromise, verifyMerkleProof, poseidon, hashLeftRight, MERKLE_ZERO_VALUE, TREE_DEPTH } from '../core/index';
import { UTXOMerkletree } from './merkletree';

// Count the tree's Poseidon hashes, so a test can tell an incremental update from a rebuild.
const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../core/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index')>();
  return {
    ...actual,
    hashLeftRight: (left: string, right: string): string => {
      hashes.count += 1;
      return actual.hashLeftRight(left, right);
    },
  };
});

interface MerkleVector {
  treeNumber: number;
  leafIndex: number;
  leaf: string;
  pathElements: string[];
  pathIndices: string;
  root: string;
}
const merkleVectors = (): MerkleVector[] =>
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../test/vectors/merkle-vectors.json'), 'utf8'),
  ).vectors;

const nToHex = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('UTXOMerkletree', () => {
  it('build → prove → verify is self-consistent for N leaves', () => {
    const leaves = Array.from({ length: 7 }, (_, i) => nToHex(poseidon([BigInt(i + 1)])));
    const tree = new UTXOMerkletree();
    tree.insertMany(leaves);
    expect(tree.length).toBe(7);
    for (let i = 0; i < leaves.length; i += 1) {
      const proof = tree.merkleProof(i);
      expect(proof.leaf).toBe(leaves[i]);
      expect(proof.root).toBe(tree.root());
      expect(verifyMerkleProof(proof)).toBe(true);
    }
  });

  it('a changed leaf changes the root', () => {
    const a = new UTXOMerkletree();
    a.insertMany([nToHex(1n), nToHex(2n)]);
    const b = new UTXOMerkletree();
    b.insertMany([nToHex(1n), nToHex(3n)]);
    expect(a.root()).not.toBe(b.root());
  });

  it('merkleProof throws for an out-of-range index', () => {
    const tree = new UTXOMerkletree();
    tree.insert(nToHex(1n));
    expect(() => tree.merkleProof(5)).toThrow(/out of range/);
  });

  it('reproduces the captured merkle-vectors root + proofs (differential vs on-chain)', () => {
    const sorted = [...merkleVectors()].sort((x, y) => x.leafIndex - y.leafIndex);
    const tree = new UTXOMerkletree();
    tree.insertMany(sorted.map((v) => v.leaf));
    for (const v of sorted) {
      expect(tree.root()).toBe(v.root);
      const proof = tree.merkleProof(v.leafIndex);
      expect(proof.elements).toEqual(v.pathElements);
      expect(proof.indices).toBe(v.pathIndices);
      expect(verifyMerkleProof(proof)).toBe(true);
    }
  });
});

// The full-rebuild tree the incremental one must match: every level recomputed from the leaves.
function referenceLevels(leaves: readonly string[]): string[][] {
  const zeros = [MERKLE_ZERO_VALUE];
  for (let l = 1; l <= TREE_DEPTH; l += 1) zeros[l] = hashLeftRight(zeros[l - 1]!, zeros[l - 1]!);
  const levels = [leaves.slice()];
  for (let l = 0; l < TREE_DEPTH; l += 1) {
    const cur = levels[l]!;
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(hashLeftRight(cur[i]!, i + 1 < cur.length ? cur[i + 1]! : zeros[l]!));
    levels.push(next);
  }
  return levels;
}

describe('UTXOMerkletree is incremental (SYNC-8, #143)', () => {
  const leafAt = (i: number): string => nToHex(poseidon([BigInt(i + 1)]));

  it('matches a full rebuild after every batch, whatever the batch sizes', () => {
    const tree = new UTXOMerkletree();
    const leaves: string[] = [];
    for (const size of [1, 1, 3, 2, 7, 1, 16, 5]) {
      const batch = Array.from({ length: size }, (_, i) => leafAt(leaves.length + i));
      tree.insertMany(batch);
      leaves.push(...batch);
      const levels = referenceLevels(leaves);
      expect(tree.root()).toBe(levels[TREE_DEPTH]![0]);
      for (const i of [0, leaves.length - 1, Math.floor(leaves.length / 2)]) {
        const proof = tree.merkleProof(i);
        expect(proof.root).toBe(tree.root());
        expect(verifyMerkleProof(proof)).toBe(true);
      }
    }
  });

  it('reads the root and proofs without hashing, and hashes only the new leaf\'s path on insert', () => {
    // WHY: root() and merkleProof() rebuilt every level each call — about 4 s for a root and 9 s for a proof on a full
    // tree, on the main thread, and sync verification asks for every tree's root.
    const tree = new UTXOMerkletree();
    tree.insertMany(Array.from({ length: 300 }, (_, i) => leafAt(i)));
    hashes.count = 0;
    tree.root();
    tree.merkleProof(17);
    expect(hashes.count).toBe(0);
    tree.insert(leafAt(300));
    expect(hashes.count).toBe(TREE_DEPTH);
  });

  it('clone() copies without rehashing, and the copies grow independently', () => {
    const tree = new UTXOMerkletree();
    tree.insertMany(Array.from({ length: 50 }, (_, i) => leafAt(i)));
    const before = tree.root();
    hashes.count = 0;
    const copy = tree.clone();
    expect(hashes.count).toBe(0);
    copy.insert(leafAt(50));
    expect(tree.root()).toBe(before);
    expect(tree.length).toBe(50);
    expect(copy.length).toBe(51);
    expect(copy.root()).toBe(referenceLevels(Array.from({ length: 51 }, (_, i) => leafAt(i)))[TREE_DEPTH]![0]);
  });
});
