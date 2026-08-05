// ABOUTME: Differential parity runner — feeds the Phase 0 captured inputs into @armada/sdk/core and
// ABOUTME: asserts byte-identical outputs vs the recorded stock-engine values (SPEC §2 acceptance gate).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  poseidon,
  initPoseidonPromise,
  TransactNote,
  verifyMerkleProof,
} from '../../src/core/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(join(HERE, name), 'utf8'));
const B = (x: string): bigint => BigInt(x);

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('core parity — poseidon(BN254)', () => {
  for (const [i, v] of load('poseidon-vectors.json').vectors.entries()) {
    it(`vector ${i} (${v.inputs.length} inputs)`, () => {
      expect(poseidon(v.inputs.map(B))).toBe(B(v.output));
    });
  }
});

describe('core parity — commitment hash (TransactNote.getHash)', () => {
  for (const [i, v] of load('commitment-vectors.json').vectors.entries()) {
    it(`vector ${i}`, () => {
      expect(TransactNote.getHash(B(v.npk), v.tokenHash, B(v.value))).toBe(B(v.commitment));
    });
  }
});

describe('core parity — nullifier (TransactNote.getNullifier)', () => {
  for (const [i, v] of load('nullifier-vectors.json').vectors.entries()) {
    it(`vector ${i} (leaf ${v.leafIndex})`, () => {
      expect(TransactNote.getNullifier(B(v.nullifyingKey), v.leafIndex)).toBe(B(v.nullifier));
    });
  }
});

describe('core parity — merkle proof (verifyMerkleProof)', () => {
  for (const [i, v] of load('merkle-vectors.json').vectors.entries()) {
    it(`vector ${i} (tree ${v.treeNumber}, leaf ${v.leafIndex})`, () => {
      expect(
        verifyMerkleProof({ leaf: v.leaf, elements: v.pathElements, indices: v.pathIndices, root: v.root }),
      ).toBe(true);
    });
  }
});
