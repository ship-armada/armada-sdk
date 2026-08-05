// ABOUTME: Tests for balance aggregation (SPEC §4.4) — spendable/pending buckets, finality windowing,
// ABOUTME: and the tree-scoped spentness guard (9.5.4 cross-tree nullifier-collision regression).

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import { computeBalances, txoFromNote, type TXO, type SpentNullifier } from './balances';

// Two arbitrary 32-byte token hashes (no 0x).
const TOKEN_A = 'aa'.repeat(32);
const TOKEN_B = 'bb'.repeat(32);
const NULLIFYING_KEY = 1234567890123456789n;

// Helper: the tree-scoped spent marker for a TXO, using the real nullifier function.
const spentFor = (tree: number, position: number): SpentNullifier => ({
  tree,
  nullifier: TransactNote.getNullifier(NULLIFYING_KEY, position),
});

const txo = (over: Partial<TXO> & Pick<TXO, 'tree' | 'position' | 'value'>): TXO => ({
  tokenHash: TOKEN_A,
  blockNumber: 100,
  ...over,
});

describe('balance aggregation (§4.4)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('sums unspent, final TXOs into spendable per token', () => {
    const txos: TXO[] = [
      txo({ tree: 0, position: 0, value: 100n, tokenHash: TOKEN_A }),
      txo({ tree: 0, position: 1, value: 50n, tokenHash: TOKEN_A }),
      txo({ tree: 0, position: 2, value: 7n, tokenHash: TOKEN_B }),
    ];
    const balances = computeBalances(txos, [], NULLIFYING_KEY, {
      currentBlock: 1000,
      finalityThreshold: 10,
    });
    expect(balances).toEqual([
      { tokenHash: TOKEN_A, spendable: 150n, pending: 0n },
      { tokenHash: TOKEN_B, spendable: 7n, pending: 0n },
    ]);
  });

  it('excludes spent TXOs (tree-scoped nullifier match)', () => {
    const txos: TXO[] = [
      txo({ tree: 0, position: 0, value: 100n }),
      txo({ tree: 0, position: 1, value: 50n }),
    ];
    const balances = computeBalances(txos, [spentFor(0, 1)], NULLIFYING_KEY, {
      currentBlock: 1000,
      finalityThreshold: 10,
    });
    // Position 1 in tree 0 is spent → only position 0 remains.
    expect(balances).toEqual([{ tokenHash: TOKEN_A, spendable: 100n, pending: 0n }]);
  });

  it('does NOT cross-match nullifiers across trees (9.5.4 regression guard)', () => {
    // Same position (5) in two trees ⇒ identical nullifier value. Spending it in tree 0 must
    // NOT mark the tree-1 TXO spent.
    const txos: TXO[] = [
      txo({ tree: 0, position: 5, value: 100n }),
      txo({ tree: 1, position: 5, value: 200n }),
    ];
    const nullifier0 = TransactNote.getNullifier(NULLIFYING_KEY, 5);
    // Sanity: the two trees really do share the nullifier value (the collision the fix guards).
    expect(TransactNote.getNullifier(NULLIFYING_KEY, 5)).toEqual(nullifier0);

    const balances = computeBalances(txos, [spentFor(0, 5)], NULLIFYING_KEY, {
      currentBlock: 1000,
      finalityThreshold: 10,
    });
    // Tree 0's position-5 TXO is spent; tree 1's position-5 TXO survives despite the shared nullifier.
    expect(balances).toEqual([{ tokenHash: TOKEN_A, spendable: 200n, pending: 0n }]);
  });

  it('buckets TXOs newer than the finality window as pending', () => {
    const txos: TXO[] = [
      txo({ tree: 0, position: 0, value: 100n, blockNumber: 900 }), // final
      txo({ tree: 0, position: 1, value: 30n, blockNumber: 995 }), // within window ⇒ pending
    ];
    const balances = computeBalances(txos, [], NULLIFYING_KEY, {
      currentBlock: 1000,
      finalityThreshold: 10, // cutoff = 990
    });
    expect(balances).toEqual([{ tokenHash: TOKEN_A, spendable: 100n, pending: 30n }]);
  });

  it('a TXO exactly at the finality cutoff is spendable', () => {
    const txos: TXO[] = [txo({ tree: 0, position: 0, value: 42n, blockNumber: 990 })];
    const balances = computeBalances(txos, [], NULLIFYING_KEY, {
      currentBlock: 1000,
      finalityThreshold: 10, // cutoff = 990, inclusive
    });
    expect(balances).toEqual([{ tokenHash: TOKEN_A, spendable: 42n, pending: 0n }]);
  });

  it('returns an empty array for no TXOs', () => {
    expect(computeBalances([], [], NULLIFYING_KEY, { currentBlock: 1, finalityThreshold: 0 })).toEqual([]);
  });

  it('txoFromNote pulls tokenHash + value from a decrypted note', () => {
    // A minimal null note gives a deterministic tokenHash/value without needing full key material.
    const note = TransactNote.createNullUnshieldNote(
      { tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenType: 0, tokenSubID: '0x00' },
      500n,
    );
    const built = txoFromNote(note, 2, 17, 640);
    expect(built).toEqual({
      tree: 2,
      position: 17,
      tokenHash: note.tokenHash,
      value: 500n,
      blockNumber: 640,
    });
  });
});
