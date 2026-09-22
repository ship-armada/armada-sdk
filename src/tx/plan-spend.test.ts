// ABOUTME: Tests for planSpend — the shape-aware orchestrator that returns one supported-shape group, or
// ABOUTME: splits a fragmented single-recipient transfer across several, submitted as one atomic transact([...]).

import { describe, it, expect } from 'vitest';
import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { TooFragmentedError, UnsupportedCircuitShapeError } from '../errors';
import { planSpend } from './plan';
import type { PlanSelection } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const USDC_HASH = getTokenDataHash(getTokenDataERC20(USDC));
const RECIPIENT = '0zk_recipient';
const BROADCASTER = '0zk_broadcaster';

// The armada-circuits v0.1.0-dev registered set (sparse: valid N depends on M).
const SUPPORTED = new Set([
  '1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
  '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4',
]);

let pos = 0;
const txo = (value: bigint, tree = 0): TXO => ({
  tree, position: pos++, tokenHash: USDC_HASH, value, blockNumber: 1,
  txid: `0x${'ee'.repeat(32)}`, origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n,
});

const base = { tokenAddress: USDC, roots: new Map<number, bigint>([[0, 111n]]), chainID: 31337n, supportedShapes: SUPPORTED };
const shapeOf = (s: PlanSelection) => `${s.shape.nullifiers}x${s.shape.commitments}`;
const sumInputs = (s: PlanSelection) => s.selectedInputs.reduce((a, t) => a + t.value, 0n);
const recipientTotal = (gs: PlanSelection[]) =>
  gs.flatMap((g) => g.summary.outputs).reduce((a, o) => a + o.value, 0n);

describe('planSpend — single group', () => {
  it('returns one group when the shape is supported', () => {
    const groups = planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 3n }], txos: [txo(6n), txo(4n)] });
    expect(groups).toHaveLength(1);
    expect(shapeOf(groups[0]!)).toBe('1x2'); // 1 input (the 6-note), recipient + change
  });
});

describe('planSpend — split (the 5x3 class)', () => {
  it('splits a 5-input recipient+fee+change transfer into supported groups', () => {
    // Five 3-value notes; R=13, F=1 → target 14 needs all 5 (sum 15, change 1). Single group = 5x3 (unsupported).
    const txos = [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)];
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 13n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      txos,
    });
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(SUPPORTED.has(shapeOf(g))).toBe(true);
    // Fee note appears exactly once, in group 0.
    expect(groups.filter((g) => g.summary.feeOutput).length).toBe(1);
    expect(groups[0]!.summary.feeOutput?.value).toBe(1n);
    // Change appears only in the last group and totals the overshoot.
    expect(groups.slice(0, -1).every((g) => g.summary.changeValue === 0n)).toBe(true);
    expect(groups[groups.length - 1]!.summary.changeValue).toBe(1n);
    // Recipient receives the full 13 across the group portions.
    expect(recipientTotal(groups)).toBe(13n);
    // Per-group value conservation.
    for (const g of groups) {
      const outs = g.summary.outputs.reduce((a, o) => a + o.value, 0n) + (g.summary.feeOutput?.value ?? 0n) + g.summary.changeValue;
      expect(outs).toBe(sumInputs(g));
    }
    // Inputs are disjoint and cover exactly the 5 notes.
    const positions = groups.flatMap((g) => g.selectedInputs.map((t) => t.position));
    expect(new Set(positions).size).toBe(5);
  });

  it('splits a 7-input no-fee transfer (7x2 → supported groups)', () => {
    const txos = Array.from({ length: 7 }, () => txo(3n)); // 21 total
    const groups = planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 20n }], txos }); // change 1
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(SUPPORTED.has(shapeOf(g))).toBe(true);
    expect(groups.filter((g) => g.summary.feeOutput).length).toBe(0);
    expect(recipientTotal(groups)).toBe(20n);
    expect(groups[groups.length - 1]!.summary.changeValue).toBe(1n);
  });
});

describe('planSpend — limits', () => {
  it('throws TooFragmentedError past the batch cap', () => {
    const txos = Array.from({ length: 25 }, () => txo(1n)); // needs 25 inputs → 5 groups > cap(4)
    expect(() => planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 25n }], txos })).toThrow(TooFragmentedError);
  });

  it('does not split an unshield — surfaces UnsupportedCircuitShapeError', () => {
    const txos = [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)]; // 5 inputs, fee+change+unshield = 5x3
    expect(() =>
      planSpend({
        ...base,
        outputs: [],
        fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
        unshield: { recipient: `0x${'ab'.repeat(20)}`, value: 13n },
        txos,
      }),
    ).toThrow(UnsupportedCircuitShapeError);
  });
});

describe('planSpend — randomized invariants (seeded)', () => {
  it('every split is conservative, supported, fee-once, change-last, inputs-disjoint', () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x9e3779b9;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

    let splitCases = 0;
    for (let iter = 0; iter < 400; iter += 1) {
      const noteCount = 1 + rand(20);
      const txos = Array.from({ length: noteCount }, () => txo(BigInt(1 + rand(9))));
      const total = txos.reduce((a, t) => a + t.value, 0n);
      if (total < 2n) continue;
      const fee = rand(2) === 0 ? BigInt(1 + rand(3)) : 0n;
      // Recipient value in (0, total - fee] so the spend is fundable.
      const room = total - fee;
      if (room <= 0n) continue;
      const R = 1n + BigInt(rand(Number(room)));

      let groups: PlanSelection[];
      try {
        groups = planSpend({
          ...base,
          outputs: [{ toShieldedAddress: RECIPIENT, value: R }],
          ...(fee > 0n ? { fee: { broadcasterShieldedAddress: BROADCASTER, value: fee } } : {}),
          txos,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(TooFragmentedError); // the only acceptable failure for a funded transfer
        continue;
      }

      if (groups.length > 1) splitCases += 1;
      // 1. every group shape supported.
      for (const g of groups) expect(SUPPORTED.has(shapeOf(g))).toBe(true);
      // 2. recipient gets exactly R.
      expect(recipientTotal(groups)).toBe(R);
      // 3. fee once, in group 0.
      const feeGroups = groups.filter((g) => g.summary.feeOutput);
      expect(feeGroups.length).toBe(fee > 0n ? 1 : 0);
      if (fee > 0n) expect(groups[0]!.summary.feeOutput?.value).toBe(fee);
      // 4. change only in the last group.
      expect(groups.slice(0, -1).every((g) => g.summary.changeValue === 0n)).toBe(true);
      // 5. per-group conservation.
      for (const g of groups) {
        const outs = g.summary.outputs.reduce((a, o) => a + o.value, 0n) + (g.summary.feeOutput?.value ?? 0n) + g.summary.changeValue;
        expect(outs).toBe(sumInputs(g));
      }
      // 6. inputs disjoint; group count within cap.
      const positions = groups.flatMap((g) => g.selectedInputs.map((t) => t.position));
      expect(new Set(positions).size).toBe(positions.length);
      expect(groups.length).toBeLessThanOrEqual(4);
    }
    expect(splitCases).toBeGreaterThan(0); // the corpus actually exercised the split path
  });
});
