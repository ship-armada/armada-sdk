// ABOUTME: Tests for planTransfer (§4.6) — TXO selection, change/fee math, circuit shape, single-tree
// ABOUTME: constraint, fewest-inputs preference, token filtering, and the insufficient-balance error.

import { describe, it, expect } from 'vitest';
import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError } from '../errors';
import { planTransfer } from './plan';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f' as const;
const USDC_HASH = getTokenDataHash(getTokenDataERC20(USDC));
const DAI_HASH = getTokenDataHash(getTokenDataERC20(DAI));

const RECIPIENT = '0zk_recipient';
const BROADCASTER = '0zk_broadcaster';

const txo = (tree: number, value: bigint, tokenHash = USDC_HASH, position = 0): TXO => ({
  tree, position, tokenHash, value, blockNumber: 1, random: '00'.repeat(16), notePublicKey: 0n,
});
const roots = new Map<number, bigint>([[0, 111n], [1, 222n]]);

const base = {
  tokenAddress: USDC,
  outputs: [{ toRailgunAddress: RECIPIENT, value: 3n }],
  roots,
  chainID: 31337n,
};

describe('planTransfer (§4.6)', () => {
  it('selects a covering note, computes change, fee output, and shape', () => {
    const plan = planTransfer({
      ...base,
      txos: [txo(0, 6n, USDC_HASH, 0), txo(0, 4n, USDC_HASH, 1)],
      fee: { broadcasterRailgunAddress: BROADCASTER, value: 1n },
    });
    // Largest-first: the single 6-note covers 3+1, so only 1 input.
    expect(plan.shape.nullifiers).toBe(1);
    // commitments = recipient(1) + fee(1) + change(1)
    expect(plan.shape.commitments).toBe(3);
    expect(plan.summary.inputTotal).toBe(6n);
    expect(plan.summary.changeValue).toBe(2n); // 6 - 3 - 1
    expect(plan.summary.outputs).toEqual([{ toRailgunAddress: RECIPIENT, value: 3n, tokenAddress: USDC }]);
    expect(plan.summary.feeOutput).toEqual({ toRailgunAddress: BROADCASTER, value: 1n, tokenAddress: USDC });
    expect(plan.merkleRoot).toBe(111n);
    expect(plan.boundParams.treeNumber).toBe(0);
    expect(plan.boundParams.unshield).toBe(0);
    expect(plan.boundParams.chainID).toBe(31337n);
    expect(plan.boundParams.adaptContract).toBe('0x0000000000000000000000000000000000000000');
    expect(plan.boundParams.adaptParams).toBe(`0x${'00'.repeat(32)}`);
  });

  it('omits the change commitment on an exact spend', () => {
    const plan = planTransfer({
      ...base,
      txos: [txo(0, 4n)],
      fee: { broadcasterRailgunAddress: BROADCASTER, value: 1n },
    });
    expect(plan.summary.changeValue).toBe(0n);
    expect(plan.shape.commitments).toBe(2); // recipient + fee, no change
  });

  it('omits the fee output when no fee is requested', () => {
    const plan = planTransfer({ ...base, txos: [txo(0, 5n)] });
    expect(plan.summary.feeOutput).toBeUndefined();
    expect(plan.summary.changeValue).toBe(2n);
    expect(plan.shape.commitments).toBe(2); // recipient + change
  });

  it('accumulates multiple inputs when no single note covers the spend', () => {
    const plan = planTransfer({
      ...base,
      outputs: [{ toRailgunAddress: RECIPIENT, value: 5n }],
      txos: [txo(0, 2n, USDC_HASH, 0), txo(0, 2n, USDC_HASH, 1), txo(0, 2n, USDC_HASH, 2)],
    });
    expect(plan.shape.nullifiers).toBe(3);
    expect(plan.summary.inputTotal).toBe(6n);
    expect(plan.summary.changeValue).toBe(1n);
  });

  it('enforces the single-tree constraint (balance split across trees cannot combine)', () => {
    expect(() =>
      planTransfer({
        ...base,
        outputs: [{ toRailgunAddress: RECIPIENT, value: 5n }],
        txos: [txo(0, 3n), txo(1, 3n)], // neither tree alone covers 5
      }),
    ).toThrow(InsufficientBalanceError);
  });

  it('prefers the tree that needs the fewest inputs', () => {
    const plan = planTransfer({
      ...base,
      outputs: [{ toRailgunAddress: RECIPIENT, value: 5n }],
      txos: [txo(0, 10n), txo(1, 3n, USDC_HASH, 0), txo(1, 3n, USDC_HASH, 1)],
    });
    // Tree 0 covers with 1 input; tree 1 would need 2 → pick tree 0.
    expect(plan.boundParams.treeNumber).toBe(0);
    expect(plan.shape.nullifiers).toBe(1);
    expect(plan.merkleRoot).toBe(111n);
  });

  it('ignores notes of other tokens', () => {
    expect(() =>
      planTransfer({ ...base, txos: [txo(0, 100n, DAI_HASH)] }),
    ).toThrow(InsufficientBalanceError);
  });

  it('throws InsufficientBalanceError when balance cannot cover amount + fee', () => {
    expect(() =>
      planTransfer({
        ...base,
        txos: [txo(0, 3n)],
        fee: { broadcasterRailgunAddress: BROADCASTER, value: 1n }, // needs 4, have 3
      }),
    ).toThrow(InsufficientBalanceError);
  });
});
