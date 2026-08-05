// ABOUTME: Tests for the incremental UTXO merkletree — self-consistent build/prove/verify, edge cases,
// ABOUTME: and a differential cross-check that reconstructs the captured merkle-vectors tree.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initPoseidonPromise, verifyMerkleProof, poseidon } from '../core/index';
import { UTXOMerkletree } from './merkletree';

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
