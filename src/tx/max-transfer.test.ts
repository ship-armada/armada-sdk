// ABOUTME: Tests for maxTransferAmount — the largest single-recipient transfer the wallet can plan, fee included,
// ABOUTME: across single-proof and split plans, per tree; checked against a brute-force search over every amount.

import { describe, it, expect } from 'vitest';
import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { maxTransferAmount } from './max-transfer';
import { planSpend } from './plan';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f' as const;
const USDC_HASH = getTokenDataHash(getTokenDataERC20(USDC));
const DAI_HASH = getTokenDataHash(getTokenDataERC20(DAI));
const BROADCASTER = '0zk_broadcaster';

// The armada-circuits v0.1.0-dev registered set (sparse: valid N depends on M).
const SUPPORTED = new Set([
  '1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
  '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4',
]);

let pos = 0;
const txo = (value: bigint, tree = 0, tokenHash = USDC_HASH): TXO => ({
  tree, position: pos++, tokenHash, value, blockNumber: 1,
  txid: `0x${'ee'.repeat(32)}`, origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n,
});

const roots = new Map<number, bigint>([[0, 111n], [1, 222n], [2, 333n]]);
const fee = (value: bigint) => ({ broadcasterShieldedAddress: BROADCASTER, value });
const params = (txos: TXO[], feeValue: bigint) => ({
  txos,
  tokenAddress: USDC,
  ...(feeValue > 0n ? { fee: fee(feeValue) } : {}),
  roots,
  chainID: 31337n,
  supportedShapes: SUPPORTED,
});

// Whether the planner can build a transfer of `amount` from these notes at all.
function plannable(txos: TXO[], feeValue: bigint, amount: bigint): boolean {
  try {
    planSpend({ ...params(txos, feeValue), outputs: [{ toShieldedAddress: '0zk_recipient', value: amount }] });
    return true;
  } catch {
    return false;
  }
}

describe('maxTransferAmount', () => {
  it('is the notes minus one fee when a single proof carries them all', () => {
    expect(maxTransferAmount(params([txo(10n)], 1n))).toBe(9n);
  });

  it('finds single-proof amounts above the notes minus a split\'s fees', () => {
    // Six 10s and a 2, fee 3. Every note (62) needs 7 inputs → a 2-proof split → 62 − 6 = 56. But the six
    // 10s alone plan as one 6x2 proof (recipient + fee, no change): 60 − 3 = 57, which is larger.
    const txos = [txo(10n), txo(10n), txo(10n), txo(10n), txo(10n), txo(10n), txo(2n)];
    expect(maxTransferAmount(params(txos, 3n))).toBe(57n);
  });

  it('prices a split when it carries more than any single proof', () => {
    // Seven 10s, fee 3: one proof takes at most six (6x2) → 57; two proofs take all seven → 70 − 6 = 64.
    const txos = Array.from({ length: 7 }, () => txo(10n));
    expect(maxTransferAmount(params(txos, 3n))).toBe(64n);
  });

  it('spends from one tree only — the best tree, not the total balance', () => {
    // 70 in total, but a transfer spends one tree: tree 0 gives 30 − 1, tree 1 gives 40 − 1.
    const txos = [txo(30n, 0), txo(20n, 1), txo(20n, 1)];
    expect(maxTransferAmount(params(txos, 1n))).toBe(39n);
  });

  it('is every note when there is no fee', () => {
    expect(maxTransferAmount(params([txo(5n), txo(5n)], 0n))).toBe(10n);
  });

  it('ignores other tokens\' notes', () => {
    expect(maxTransferAmount(params([txo(10n), txo(1_000n, 0, DAI_HASH)], 1n))).toBe(9n);
  });

  it('is zero when nothing can be sent', () => {
    expect(maxTransferAmount(params([], 1n))).toBe(0n);
    expect(maxTransferAmount(params([txo(1n)], 1n))).toBe(0n); // the only note just covers the fee
  });

  it('stops at what the batch cap can carry when the wallet is too fragmented to send it all', () => {
    // Forty 1s, fee 1: four proofs carry at most 4 × 8 notes, so the max is well short of 40 − fees.
    const txos = Array.from({ length: 40 }, () => txo(1n));
    const max = maxTransferAmount(params(txos, 1n));
    expect(max).toBeGreaterThan(0n);
    expect(plannable(txos, 1n, max)).toBe(true);
    expect(plannable(txos, 1n, max + 1n)).toBe(false);
  });

  it('matches a brute-force search over every amount, across random wallets', () => {
    // Seeded mulberry32 (32-bit integer math, so no float precision loss) so a failure reproduces.
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    for (let run = 0; run < 300; run += 1) {
      const feeValue = BigInt(rand(4)); // 0..3, including no fee
      // Up to 3 trees and 40 notes: past what one batch can spend, so the 4-proof cap is exercised too.
      const trees = 1 + rand(3);
      const txos = Array.from({ length: 1 + rand(40) }, () => txo(BigInt(1 + rand(20)), rand(trees)));
      const total = txos.reduce((s, t) => s + t.value, 0n);
      let expected = 0n;
      for (let amount = total; amount > 0n; amount -= 1n) {
        if (plannable(txos, feeValue, amount)) {
          expected = amount;
          break;
        }
      }
      const context = `run ${run}: fee ${feeValue}, notes ${txos.map((t) => `${t.value}@${t.tree}`).join(',')}`;
      expect(maxTransferAmount(params(txos, feeValue)), context).toBe(expected);
    }
  });
});
