// ABOUTME: Tests for planSpend — the shape-aware orchestrator that returns one supported-shape group, or
// ABOUTME: splits a fragmented single-recipient transfer across several, submitted as one atomic transact([...]).

import { describe, it, expect } from 'vitest';
import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError, TooFragmentedError, UnsupportedCircuitShapeError } from '../errors';
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
const feeTotal = (gs: PlanSelection[]) => gs.reduce((a, g) => a + (g.summary.feeOutput?.value ?? 0n), 0n);
const conserves = (g: PlanSelection) =>
  g.summary.outputs.reduce((a, o) => a + o.value, 0n) + (g.summary.feeOutput?.value ?? 0n) + g.summary.changeValue ===
  sumInputs(g);
const withoutShapes = (...keys: string[]) => new Set([...SUPPORTED].filter((k) => !keys.includes(k)));

describe('planSpend — single group', () => {
  it('returns one group when the shape is supported', () => {
    const groups = planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 3n }], txos: [txo(6n), txo(4n)] });
    expect(groups).toHaveLength(1);
    expect(shapeOf(groups[0]!)).toBe('1x2'); // 1 input (the 6-note), recipient + change
  });
});

describe('planSpend — split (the 5x3 class)', () => {
  it('splits a 5-input recipient+fee+change transfer into supported groups', () => {
    // Five 3-value notes; R=12, F=1 → single group needs all 5 (target 13, change 2) = 5x3 (unsupported).
    // Split at 2 groups charges 2F (target 14, change 1): 4x2 (fee + recipient) then 1x2 (recipient + change).
    const txos = [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)];
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 12n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      txos,
    });
    expect(groups.map(shapeOf)).toEqual(['4x2', '1x2']);
    // The per-proof fee is charged once per group: 2 groups → 2F, carried by group 0.
    expect(feeTotal(groups)).toBe(2n);
    expect(groups[0]!.summary.feeOutput?.value).toBe(2n);
    // Change appears only in the last group and totals the overshoot.
    expect(groups.slice(0, -1).every((g) => g.summary.changeValue === 0n)).toBe(true);
    expect(groups[groups.length - 1]!.summary.changeValue).toBe(1n);
    // Recipient receives the full 12 across the group portions; memo-less portions.
    expect(recipientTotal(groups)).toBe(12n);
    for (const g of groups) expect(conserves(g)).toBe(true);
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

  it('spreads a fee larger than one group\'s inputs across groups instead of failing', () => {
    // Twenty 1-value notes; R=2, F=5 → single group 7x2 unsupported. Split at 2 groups charges 2F=10:
    // group 0 (8 notes) is all fee, group 1 (4 notes) carries the remaining 2 fee + the 2 recipient.
    const txos = Array.from({ length: 20 }, () => txo(1n));
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 2n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 5n },
      txos,
    });
    expect(groups.map(shapeOf)).toEqual(['8x1', '4x2']);
    expect(groups.map((g) => g.summary.feeOutput?.value)).toEqual([8n, 2n]);
    expect(feeTotal(groups)).toBe(10n);
    expect(recipientTotal(groups)).toBe(2n);
    for (const g of groups) expect(conserves(g)).toBe(true);
  });

  it('sizes groups from the registered shape set, not a fixed cap (sparse M=2 support)', () => {
    // A deployment whose M=2 shapes stop at N=4. Twelve 1-value notes, R=9, F=1: at 2 groups the fee+recipient
    // group must be ≤4 inputs; the remaining recipient-only group uses 7x1.
    const supported = withoutShapes('5x2', '6x2');
    const txos = Array.from({ length: 12 }, () => txo(1n));
    const groups = planSpend({
      ...base,
      supportedShapes: supported,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 9n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      txos,
    });
    expect(groups.map(shapeOf)).toEqual(['4x2', '7x1']);
    for (const g of groups) expect(supported.has(shapeOf(g))).toBe(true);
    expect(recipientTotal(groups)).toBe(9n);
    expect(feeTotal(groups)).toBe(2n);
  });

  it('keeps a single proof when the split fee absorbs the change into a supported shape', () => {
    // Five 3-value notes; R=13, F=1 → 5x3 at 1 proof (change 1). At the 2-proof fee (2F) the change is
    // exactly consumed, leaving a supported 5x2 — one proof, paying the 2-proof fee (≥ F per proof).
    const txos = [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)];
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 13n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      txos,
    });
    expect(groups.map(shapeOf)).toEqual(['5x2']);
    expect(feeTotal(groups)).toBe(2n);
    expect(recipientTotal(groups)).toBe(13n);
  });
});

describe('planSpend — change folded into the fee', () => {
  it('pays a change no bigger than the fee to the broadcaster rather than splitting (one proof, cheaper)', () => {
    // Six 10s + a 2; R=55, F=3 → target 58 takes the six 10s with change 2 → 6x3 (unregistered). Folding
    // the 2 into the fee gives a registered 6x2 at fee 5; a split would have charged 2F = 6.
    const txos = [txo(10n), txo(10n), txo(10n), txo(10n), txo(10n), txo(10n), txo(2n)];
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 55n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 3n },
      txos,
    });
    expect(groups.map(shapeOf)).toEqual(['6x2']);
    expect(feeTotal(groups)).toBe(5n);
    expect(groups[0]!.summary.changeValue).toBe(0n);
    expect(recipientTotal(groups)).toBe(55n);
    expect(conserves(groups[0]!)).toBe(true);
  });

  it('lets an unshield through that no split could carry', () => {
    // Five 3s; unshield 13, F=1 → change 1 → 5x3 (unregistered). Folded: fee 2 + unshield 13 = 5x2.
    const groups = planSpend({
      ...base,
      outputs: [],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      unshield: { recipient: `0x${'ab'.repeat(20)}`, value: 13n },
      txos: [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)],
    });
    expect(groups.map(shapeOf)).toEqual(['5x2']);
    expect(feeTotal(groups)).toBe(2n);
    expect(groups[0]!.summary.unshield?.value).toBe(13n);
    expect(groups[0]!.summary.changeValue).toBe(0n);
    expect(feeTotal(groups) + 13n).toBe(sumInputs(groups[0]!)); // every input is accounted for
  });

  it('does not fold when the change is bigger than the fee (a split is cheaper)', () => {
    // Five 3s; R=12, F=1 → change 2 > F → splits (2F) instead of paying 3.
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 12n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      txos: [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)],
    });
    expect(groups).toHaveLength(2);
    expect(feeTotal(groups)).toBe(2n);
  });

  it('does not fold when the no-change shape is unregistered too', () => {
    // Seven 10s; R=64, F=3 → change 3 → 7x3; folded would be 7x2, also unregistered → splits.
    const groups = planSpend({
      ...base,
      outputs: [{ toShieldedAddress: RECIPIENT, value: 64n }],
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 3n },
      txos: Array.from({ length: 7 }, () => txo(10n)),
    });
    expect(groups.length).toBeGreaterThan(1);
    expect(feeTotal(groups)).toBe(6n);
  });

  it('does not fold without a fee note (nothing to fold into)', () => {
    // Seven 3s, no fee; R=20 → change 1 → 7x2 unregistered → splits, keeping the change.
    const groups = planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 20n }], txos: Array.from({ length: 7 }, () => txo(3n)) });
    expect(groups.length).toBeGreaterThan(1);
    expect(groups[groups.length - 1]!.summary.changeValue).toBe(1n);
  });
});

describe('planSpend — limits', () => {
  it('throws TooFragmentedError past the batch cap', () => {
    // Needs 33 inputs; the largest shape is 8x1, so 4 groups hold at most 32 → 5 groups > cap(4).
    const txos = Array.from({ length: 33 }, () => txo(1n));
    expect(() => planSpend({ ...base, outputs: [{ toShieldedAddress: RECIPIENT, value: 33n }], txos })).toThrow(TooFragmentedError);
  });

  it('never emits an empty group: a single note that no shape can carry surfaces UnsupportedCircuitShapeError', () => {
    // A deployment without 1x3: one 10-note spending recipient + fee + change has nowhere to go.
    expect(() =>
      planSpend({
        ...base,
        supportedShapes: withoutShapes('1x3'),
        outputs: [{ toShieldedAddress: RECIPIENT, value: 3n }],
        fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
        txos: [txo(10n)],
      }),
    ).toThrow(UnsupportedCircuitShapeError);
  });

  it('throws TooFragmentedError (not InsufficientBalanceError) when the balance covers one proof\'s fee but not a split\'s', () => {
    // Seven 1-value notes; R=6, F=1 → target 7 = 7x2 (unsupported). Splitting needs 2F → target 8 > 7. The
    // balance is enough for one proof — the notes are what's wrong, so consolidating is the remedy.
    const txos = Array.from({ length: 7 }, () => txo(1n));
    expect(() =>
      planSpend({
        ...base,
        outputs: [{ toShieldedAddress: RECIPIENT, value: 6n }],
        fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
        txos,
      }),
    ).toThrow(TooFragmentedError);
  });

  it('still throws InsufficientBalanceError when no tree covers the amount plus one fee', () => {
    expect(() =>
      planSpend({
        ...base,
        outputs: [{ toShieldedAddress: RECIPIENT, value: 10n }],
        fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
        txos: [txo(3n), txo(3n)],
      }),
    ).toThrow(InsufficientBalanceError);
  });

  it('does not split an unshield — surfaces UnsupportedCircuitShapeError', () => {
    // 5 inputs, fee + change + unshield = 5x3; the change (2) is more than the fee (1), so it isn't folded.
    const txos = [txo(3n), txo(3n), txo(3n), txo(3n), txo(3n)];
    expect(() =>
      planSpend({
        ...base,
        outputs: [],
        fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
        unshield: { recipient: `0x${'ab'.repeat(20)}`, value: 12n },
        txos,
      }),
    ).toThrow(UnsupportedCircuitShapeError);
  });
});

describe('planSpend — randomized invariants (seeded)', () => {
  it('every plan is conservative, supported, fee-per-proof, change-last, inputs-disjoint', () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x9e3779b9;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

    let splitCases = 0;
    for (let iter = 0; iter < 400; iter += 1) {
      const noteCount = 1 + rand(20);
      const txos = Array.from({ length: noteCount }, () => txo(BigInt(1 + rand(9))));
      const total = txos.reduce((a, t) => a + t.value, 0n);
      if (total < 2n) continue;
      // Fees up to 12 — larger than many single notes, so the fee regularly spans groups.
      const fee = rand(2) === 0 ? BigInt(1 + rand(12)) : 0n;
      // Recipient value in (0, total - fee] so a single proof is fundable.
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
        // The only acceptable failure for a transfer fundable at one proof is fragmentation: too many notes
        // for the batch cap, or a split whose per-proof fees the balance can't also cover.
        expect(err).toBeInstanceOf(TooFragmentedError);
        continue;
      }

      if (groups.length > 1) splitCases += 1;
      // 1. every group shape supported.
      for (const g of groups) expect(SUPPORTED.has(shapeOf(g))).toBe(true);
      // 2. recipient gets exactly R.
      expect(recipientTotal(groups)).toBe(R);
      // 3. the fee is at least one per-proof fee per proof, within the batch cap: a whole number of
      //    per-proof fees, or one proof's fee plus a folded change of at most one more fee (no change left).
      const paid = feeTotal(groups);
      if (fee === 0n) {
        expect(paid).toBe(0n);
      } else {
        expect(paid >= fee * BigInt(groups.length)).toBe(true);
        expect(paid <= fee * 4n).toBe(true);
        const folded = paid % fee !== 0n;
        if (folded) {
          expect(groups).toHaveLength(1);
          expect(paid <= fee * 2n).toBe(true);
          expect(groups[0]!.summary.changeValue).toBe(0n);
        }
      }
      // 4. change only in the last group.
      expect(groups.slice(0, -1).every((g) => g.summary.changeValue === 0n)).toBe(true);
      // 5. per-group conservation; no empty group.
      for (const g of groups) {
        expect(conserves(g)).toBe(true);
        expect(g.selectedInputs.length).toBeGreaterThan(0);
      }
      // 6. inputs disjoint; group count within cap.
      const positions = groups.flatMap((g) => g.selectedInputs.map((t) => t.position));
      expect(new Set(positions).size).toBe(positions.length);
      expect(groups.length).toBeLessThanOrEqual(4);
    }
    expect(splitCases).toBeGreaterThan(0); // the corpus actually exercised the split path
  });
});
