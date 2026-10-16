// ABOUTME: Tests for TreeStore (F1, #143) — the chain-public half of a scan: per-tree append-only merkletrees with
// ABOUTME: position-gap checks, roots, proofs, cheap clones, and rebuilding from persisted leaves.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, verifyMerkleProof } from '../core/index';
import { TreeStore } from './tree-store';
import { UTXOMerkletree } from './merkletree';
import { PositionGapError } from '../errors';

const leafHex = (n: number): string => n.toString(16).padStart(64, '0');

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('TreeStore (F1, #143)', () => {
  it('appends leaves per tree and serves roots and proofs that match a plain merkletree', () => {
    const store = new TreeStore();
    store.insertLeaf(0, 0, leafHex(1));
    store.insertLeaf(0, 1, leafHex(2));
    store.insertLeaf(1, 0, leafHex(3));
    const reference = new UTXOMerkletree();
    reference.insertMany([leafHex(1), leafHex(2)]);
    expect(store.treeNumbers()).toEqual([0, 1]);
    expect(store.length(0)).toBe(2);
    expect(store.root(0)).toBe(reference.root());
    expect(verifyMerkleProof(store.merkleProof(1, 0))).toBe(true);
    expect(store.root(7)).toBe(new UTXOMerkletree().root()); // an unseen tree has the empty root
    expect(store.length(7)).toBe(0);
  });

  it('rejects a leaf that is not the next position of its tree', () => {
    const store = new TreeStore();
    store.insertLeaf(0, 0, leafHex(1));
    expect(() => store.insertLeaf(0, 2, leafHex(2))).toThrow(PositionGapError);
    expect(() => store.insertLeaf(3, 1, leafHex(2))).toThrow(PositionGapError);
  });

  it('throws for a proof in a tree it has never seen', () => {
    expect(() => new TreeStore().merkleProof(4, 0)).toThrow(/unknown tree 4/);
  });

  it('clones into an independent store', () => {
    const store = new TreeStore();
    store.insertLeaf(0, 0, leafHex(1));
    const copy = store.clone();
    copy.insertLeaf(0, 1, leafHex(2));
    expect(store.length(0)).toBe(1);
    expect(copy.length(0)).toBe(2);
  });

  it('rebuilds from persisted leaves', () => {
    const store = new TreeStore();
    [1, 2, 3].forEach((n, i) => store.insertLeaf(0, i, leafHex(n)));
    const rebuilt = TreeStore.fromLeaves([{ tree: 0, leaves: store.leaves(0) }]);
    expect(rebuilt.root(0)).toBe(store.root(0));
    rebuilt.insertLeaf(0, 3, leafHex(4)); // and keeps appending from the right position
    expect(rebuilt.length(0)).toBe(4);
  });
});
