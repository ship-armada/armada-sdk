// ABOUTME: Native receive-history reconstruction (H1) — shields + incoming transfers, with the
// ABOUTME: wallet's own change correctly excluded via nullifier matching.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import type { TXO, SpentNullifier } from './balances';
import { reconstructReceiveHistory } from './history';

const USDC_HASH = 'aa'.repeat(32);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const NK = 987654321n;
const tx = (n: string): string => `0x${n.repeat(32)}`;

// Only USDC resolves — a note in any other token is skipped.
const resolveToken = (hash: string): `0x${string}` | undefined => (hash === USDC_HASH ? USDC : undefined);

function txo(over: Partial<TXO> & Pick<TXO, 'tree' | 'position' | 'value' | 'txid' | 'origin'>): TXO {
  return { tokenHash: USDC_HASH, blockNumber: 10, random: '00'.repeat(16), notePublicKey: 0n, ...over };
}

describe('reconstructReceiveHistory (H1)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('emits shield + incoming-transfer entries and excludes the wallet\'s own change', () => {
    // WHY: a transact-origin note created in a tx where WE spent an input is change, not an incoming
    // transfer — misclassifying it would double-count the sender's outflow as a receive.
    const shieldNote = txo({ tree: 0, position: 0, value: 1_000_000n, txid: tx('11'), origin: 'shield', shieldFee: 5_000n });
    const received = txo({ tree: 0, position: 1, value: 250_000n, txid: tx('22'), origin: 'transact', blockNumber: 20, memo: 'gm', senderRailgunAddress: '0zk_alice' });
    // A spend we authored at position 1... use a distinct input note we own that got nullified.
    const spentInput = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('11'), origin: 'transact', blockNumber: 5 });
    const changeNote = txo({ tree: 0, position: 6, value: 400_000n, txid: tx('33'), origin: 'transact', blockNumber: 30 });

    // The spend tx (0x33) nullified our input note (position 5); change (position 6) landed in 0x33.
    const spent: SpentNullifier[] = [
      { tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: tx('33'), blockNumber: 30 },
    ];

    const entries = reconstructReceiveHistory([shieldNote, received, spentInput, changeNote], spent, NK, resolveToken);

    // shield (0x11), incoming transfer (0x22), and the spentInput itself (a transact note NOT created
    // in a tx where we spent → it's an earlier receive). The change note (0x33) is excluded.
    const byTxid = new Map(entries.map((e) => [e.txid, e]));
    expect(byTxid.get(tx('33'))).toBeUndefined(); // change excluded
    expect(byTxid.get(tx('11'))).toMatchObject({ category: 'shield', value: 1_000_000n, shieldFee: 5_000n, tokenAddress: USDC });
    expect(byTxid.get(tx('22'))).toMatchObject({ category: 'transfer-received', value: 250_000n, memo: 'gm', senderRailgunAddress: '0zk_alice' });
    expect(entries).toHaveLength(3); // shield + received + the pre-spend input receive
  });

  it('skips notes in non-USDC tokens', () => {
    const other = txo({ tree: 0, position: 0, value: 1n, txid: tx('44'), origin: 'shield', tokenHash: 'bb'.repeat(32) });
    expect(reconstructReceiveHistory([other], [], NK, resolveToken)).toHaveLength(0);
  });

  it('sorts by block then txid', () => {
    const a = txo({ tree: 0, position: 0, value: 1n, txid: tx('bb'), origin: 'shield', blockNumber: 50 });
    const b = txo({ tree: 0, position: 1, value: 1n, txid: tx('aa'), origin: 'shield', blockNumber: 10 });
    const entries = reconstructReceiveHistory([a, b], [], NK, resolveToken);
    expect(entries.map((e) => e.blockNumber)).toEqual([10, 50]);
  });
});
