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
  verifyEDDSA,
  hashBoundParamsV2,
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

describe('core parity — note public key (npk)', () => {
  for (const [i, v] of load('npk-vectors.json').vectors.entries()) {
    it(`vector ${i}`, () => {
      // npk = poseidon([masterPublicKey, hexToBigInt(random)])
      expect(poseidon([B(v.masterPublicKey), BigInt('0x' + v.random)])).toBe(B(v.npk));
    });
  }
});

describe('core parity — boundParams hash (hashBoundParamsV2)', () => {
  for (const [i, v] of load('boundparams-hash-vectors.json').vectors.entries()) {
    it(`vector ${i}`, () => {
      expect(hashBoundParamsV2(v.boundParams)).toBe(B(v.boundParamsHash));
    });
  }
});

describe('core parity — EdDSA spend authorization (verifyEDDSA)', () => {
  for (const [i, v] of load('eddsa-spend-auth-vectors.json').vectors.entries()) {
    it(`vector ${i}`, () => {
      const signature = {
        R8: [B(v.signature.R8[0]), B(v.signature.R8[1])] as [bigint, bigint],
        S: B(v.signature.S),
      };
      expect(
        verifyEDDSA(B(v.message), signature, [B(v.spendingPublicKey[0]), B(v.spendingPublicKey[1])]),
      ).toBe(true);
    });
  }
});

describe('core parity — TransactionStructV2 (boundParams consistency)', () => {
  for (const [i, v] of load('transaction-struct-vectors.json').vectors.entries()) {
    it(`vector ${i} (shape ${v.shape.nullifiers}x${v.shape.commitments})`, () => {
      expect(hashBoundParamsV2(v.boundParams)).toBe(B(v.boundParamsHash));
    });
  }
});

// DEFERRED to Phase 2 (wallet layer) — these two Phase 0 vectors are NOT pure-core primitives and
// verify once the wallet layer exists. Kept as `it.todo` so they surface as PENDING in every test
// run (and in CI) until implemented — a standing reminder so the deferral is never silently dropped.
// Tracked also in SPEC.md Phase 1/2 acceptance and a GitHub issue.
describe('parity — DEFERRED to Phase 2 (wallet layer)', () => {
  it.todo('keyset-vectors.json — full seed→keyset→0zk derivation (needs wallet key-derivation)');
  it.todo('note-ciphertext-vectors.json — ECIES decrypt round-trip (needs viewing private key + shared key)');
});
