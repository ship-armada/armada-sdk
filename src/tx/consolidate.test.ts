// ABOUTME: Tests for planConsolidate — merging one token's notes into fewer self-owned notes: old trees first,
// ABOUTME: smallest first, supported shapes, per-proof USDC fee (own notes or a fee group), dust floor, 4-group cap.

import { describe, it, expect } from 'vitest';
import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError, NothingToConsolidateError, UnsupportedCircuitShapeError } from '../errors';
import { planConsolidate, txosAfterConsolidation, type PlanConsolidateParams } from './consolidate';
import { planSpend } from './plan';
import type { PlanSelection } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const SHARES = '0x6b175474e89094c44da98b954eedeac495271d0f' as const;
const HASH = { [USDC]: getTokenDataHash(getTokenDataERC20(USDC)), [SHARES]: getTokenDataHash(getTokenDataERC20(SHARES)) };
const BROADCASTER = '0zk_broadcaster';

// The armada-circuits v0.1.0-dev registered set (sparse: valid N depends on M).
const SUPPORTED = new Set([
  '1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
  '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4',
]);

let pos = 0;
type Token = keyof typeof HASH;
const note = (value: bigint, tree = 0, token: Token = USDC): TXO => ({
  tree, position: pos++, tokenHash: HASH[token], value, blockNumber: 1,
  txid: `0x${'ee'.repeat(32)}`, origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n,
});
const fee = (value: bigint) => ({ broadcasterShieldedAddress: BROADCASTER, value, tokenAddress: USDC });

const base = (txos: TXO[], over: Partial<PlanConsolidateParams> = {}): PlanConsolidateParams => ({
  txos,
  tokenAddress: USDC,
  roots: new Map([[0, 100n], [1, 101n], [2, 102n]]),
  currentTree: 0,
  chainID: 31337n,
  supportedShapes: SUPPORTED,
  ...over,
});

const shapeOf = (g: PlanSelection) => `${g.shape.nullifiers}x${g.shape.commitments}`;
const values = (g: PlanSelection) => g.selectedInputs.map((t) => t.value);
const inputSum = (g: PlanSelection) => g.selectedInputs.reduce((a, t) => a + t.value, 0n);
const feePaid = (gs: PlanSelection[]) => gs.reduce((a, g) => a + (g.summary.feeOutput?.value ?? 0n), 0n);

describe('planConsolidate — USDC run (fee paid by each group)', () => {
  it('merges the smallest notes into one self-owned note per group, paying the per-proof fee from each', () => {
    const groups = planConsolidate(base([note(5n), note(1n), note(3n), note(2n), note(4n), note(6n), note(7n)], { fee: fee(1n) }));
    // 6 smallest fit one 6x2 group (merged note + fee note); the lone 7 left over would merge nothing.
    expect(groups).toHaveLength(1);
    expect(values(groups[0]!)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(shapeOf(groups[0]!)).toBe('6x2');
    expect(groups[0]!.summary.changeValue).toBe(20n);
    expect(groups[0]!.summary.feeOutput).toEqual({ toShieldedAddress: BROADCASTER, value: 1n, tokenAddress: USDC });
    expect(groups[0]!.summary.outputs).toEqual([]);
  });

  it('moves old-tree notes first (a single old note is worth moving), then the current tree', () => {
    const groups = planConsolidate(
      base([note(1n, 1), note(1n, 1), note(1n, 1), note(10n, 0)], { currentTree: 1, fee: fee(1n) }),
    );
    expect(groups.map((g) => g.boundParams.treeNumber)).toEqual([0, 1]);
    expect(shapeOf(groups[0]!)).toBe('1x2'); // the old-tree note migrates on its own
    expect(groups[0]!.merkleRoot).toBe(100n);
    expect(shapeOf(groups[1]!)).toBe('3x2');
    expect(groups[1]!.merkleRoot).toBe(101n);
  });

  it('skips dust: never merges a group worth no more than its fee', () => {
    // Six 1-notes (worth 6) can't pay a fee of 10; the six 5-notes (worth 30) can.
    const txos = [...Array.from({ length: 6 }, () => note(1n)), ...Array.from({ length: 6 }, () => note(5n))];
    const groups = planConsolidate(base(txos, { fee: fee(10n) }));
    expect(groups).toHaveLength(1);
    expect(values(groups[0]!)).toEqual([5n, 5n, 5n, 5n, 5n, 5n]);
  });

  it('caps a run at 4 groups; the rest waits for the next run', () => {
    const groups = planConsolidate(base(Array.from({ length: 30 }, () => note(10n)), { fee: fee(1n) }));
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => shapeOf(g) === '6x2')).toBe(true);
    expect(feePaid(groups)).toBe(4n);
  });

  it('without a fee, groups carry only the merged note (Nx1, up to 8 inputs)', () => {
    const groups = planConsolidate(base(Array.from({ length: 9 }, () => note(1n))));
    expect(groups.map(shapeOf)).toEqual(['8x1']); // the 9th note alone would merge nothing
    expect(groups[0]!.summary.changeValue).toBe(8n);
  });

  it('throws NothingToConsolidateError when nothing is worth merging', () => {
    expect(() => planConsolidate(base([note(10n)], { fee: fee(1n) }))).toThrow(NothingToConsolidateError);
    expect(() => planConsolidate(base([note(1n), note(1n)], { fee: fee(5n) }))).toThrow(NothingToConsolidateError);
    expect(() => planConsolidate(base([], { fee: fee(1n) }))).toThrow(NothingToConsolidateError);
  });

  it('ignores other tokens and zero-value notes', () => {
    const groups = planConsolidate(
      base([note(2n), note(3n), note(0n), note(50n, 0, SHARES), note(60n, 0, SHARES)], { fee: fee(1n) }),
    );
    expect(groups).toHaveLength(1);
    expect(values(groups[0]!)).toEqual([2n, 3n]);
  });
});

describe('planConsolidate — non-fee token run (shares + a USDC fee group)', () => {
  it('merges share notes with no fee note, and one USDC group pays the fee for every proof', () => {
    const shares = Array.from({ length: 10 }, () => note(100n, 0, SHARES));
    const groups = planConsolidate(base([...shares, note(5n), note(50n)], { tokenAddress: SHARES, fee: fee(2n) }));
    // Share groups: 8 + 2 (Nx1). Fee group: the fewest USDC notes covering 2 × 3 proofs = 6.
    expect(groups.map(shapeOf)).toEqual(['8x1', '2x1', '1x2']);
    const [a, b, feeGroup] = groups;
    expect(a!.summary.feeOutput).toBeUndefined();
    expect(b!.summary.feeOutput).toBeUndefined();
    expect(a!.summary.tokenAddress).toBe(SHARES);
    expect(feeGroup!.summary.tokenAddress).toBe(USDC);
    expect(values(feeGroup!)).toEqual([50n]);
    expect(feeGroup!.summary.feeOutput?.value).toBe(6n);
    expect(feeGroup!.summary.changeValue).toBe(44n);
  });

  it('leaves room for the fee group within the 4-group cap', () => {
    const shares = Array.from({ length: 40 }, () => note(100n, 0, SHARES));
    const groups = planConsolidate(base([...shares, note(50n)], { tokenAddress: SHARES, fee: fee(1n) }));
    expect(groups).toHaveLength(4);
    expect(groups.filter((g) => g.summary.tokenAddress === SHARES)).toHaveLength(3);
    expect(feePaid(groups)).toBe(4n);
  });

  it('throws InsufficientBalanceError when no USDC can pay the fee', () => {
    const shares = Array.from({ length: 5 }, () => note(100n, 0, SHARES));
    expect(() => planConsolidate(base(shares, { tokenAddress: SHARES, fee: fee(1n) }))).toThrow(InsufficientBalanceError);
    expect(() =>
      planConsolidate(base([...shares, note(1n)], { tokenAddress: SHARES, fee: fee(1n) })),
    ).toThrow(InsufficientBalanceError); // 1 USDC can't cover 2 proofs × 1
  });

  it('the fee group prefers a cover that leaves change — the merge tag rides on that change note (#102)', () => {
    // Fee 2 × 2 proofs = 4. The 4-note alone covers it EXACTLY (no change → no note to carry the
    // consolidation tag), so the group also takes the 1-note and returns 1 as change.
    const shares = Array.from({ length: 3 }, () => note(100n, 0, SHARES));
    const groups = planConsolidate(base([...shares, note(4n), note(1n)], { tokenAddress: SHARES, fee: fee(2n) }));
    expect(groups.map(shapeOf)).toEqual(['3x1', '2x2']);
    expect(groups[1]!.summary.feeOutput?.value).toBe(4n);
    expect(groups[1]!.summary.changeValue).toBe(1n);
  });

  it('falls back to an exact fee cover (no change note) only when the USDC allows nothing else', () => {
    const shares = Array.from({ length: 3 }, () => note(100n, 0, SHARES));
    const groups = planConsolidate(base([...shares, note(4n)], { tokenAddress: SHARES, fee: fee(2n) }));
    expect(groups.map(shapeOf)).toEqual(['3x1', '1x1']);
    expect(groups[1]!.summary.changeValue).toBe(0n);
  });
});

describe('planConsolidate — randomized invariants (seeded)', () => {
  it('every run is single-tree per group, supported, value-conserving, ordered, fee-correct, capped', () => {
    let seed = 0x2545f491;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    let runs = 0;
    for (let iter = 0; iter < 300; iter += 1) {
      const currentTree = rand(3);
      const txos = Array.from({ length: rand(40) }, () =>
        note(BigInt(rand(20)), rand(currentTree + 1), rand(3) === 0 ? SHARES : USDC),
      );
      const token: Token = rand(2) === 0 ? USDC : SHARES;
      const perProof = BigInt(rand(4)); // 0 → no fee
      const params = base(txos, { tokenAddress: token, currentTree, ...(perProof > 0n ? { fee: fee(perProof) } : {}) });
      let groups: PlanSelection[];
      try {
        groups = planConsolidate(params);
      } catch (err) {
        expect(err instanceof NothingToConsolidateError || err instanceof InsufficientBalanceError).toBe(true);
        continue;
      }
      runs += 1;
      expect(groups.length).toBeLessThanOrEqual(4);
      const tokenGroups = groups.filter((g) => g.summary.tokenAddress === token);
      const feeGroups = groups.filter((g) => g.summary.tokenAddress !== token);
      expect(feeGroups.length).toBe(perProof > 0n && token !== USDC ? 1 : 0);
      // Fee: one per-proof fee per proof, all in USDC.
      expect(feePaid(groups)).toBe(perProof * BigInt(groups.length));
      let lastTree = -1;
      for (const g of groups) {
        expect(SUPPORTED.has(shapeOf(g))).toBe(true);
        expect(new Set(g.selectedInputs.map((t) => t.tree))).toEqual(new Set([g.boundParams.treeNumber]));
        expect(inputSum(g)).toBe(g.summary.changeValue + (g.summary.feeOutput?.value ?? 0n));
        expect(g.summary.outputs).toEqual([]);
      }
      for (const g of tokenGroups) {
        // Old trees before the current tree; smallest first within a group.
        expect(g.boundParams.treeNumber).toBeGreaterThanOrEqual(lastTree);
        lastTree = g.boundParams.treeNumber;
        expect(values(g)).toEqual([...values(g)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
        expect(g.selectedInputs.every((t) => t.tokenHash === HASH[token] && t.value > 0n)).toBe(true);
        if (g.boundParams.treeNumber === currentTree) expect(g.selectedInputs.length).toBeGreaterThanOrEqual(2);
        if (perProof > 0n && token === USDC) expect(inputSum(g) > perProof).toBe(true);
      }
      const positions = groups.flatMap((g) => g.selectedInputs.map((t) => t.position));
      expect(new Set(positions).size).toBe(positions.length);
    }
    expect(runs).toBeGreaterThan(50);
  });
});

describe('txosAfterConsolidation', () => {
  it('replaces the merged inputs with one note per group, in the current tree', () => {
    const old = note(9n, 0);
    const dust = [note(1n, 1), note(2n, 1), note(3n, 1)];
    const untouched = note(40n, 1, SHARES);
    const txos = [old, ...dust, untouched];
    const groups = planConsolidate(base(txos, { currentTree: 1, fee: fee(1n) }));
    const after = txosAfterConsolidation(txos, groups, 1);

    expect(after).toContain(untouched);
    expect(after).not.toContain(old);
    for (const d of dust) expect(after).not.toContain(d);
    const merged = after.filter((t) => t !== untouched);
    expect(merged.map((t) => [t.tree, t.value, t.tokenHash])).toEqual([
      [1, 8n, HASH[USDC]], // 9 − fee 1, moved to the current tree
      [1, 5n, HASH[USDC]], // 1 + 2 + 3 − fee 1
    ]);
    // Positions never collide with real notes (they're placeholders for planning only).
    const positions = after.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('turns a blocked unshield (no 5x3 circuit) into one that plans', () => {
    const txos = Array.from({ length: 5 }, () => note(3n));
    const unshield = {
      tokenAddress: USDC,
      outputs: [],
      unshield: { recipient: `0x${'ab'.repeat(20)}` as const, value: 13n },
      fee: { broadcasterShieldedAddress: BROADCASTER, value: 1n },
      roots: new Map([[0, 100n]]),
      chainID: 31337n,
      supportedShapes: SUPPORTED,
    };
    expect(() => planSpend({ ...unshield, txos })).toThrow(UnsupportedCircuitShapeError);

    const groups = planConsolidate(base(txos, { fee: fee(1n) }));
    const plans = planSpend({ ...unshield, txos: txosAfterConsolidation(txos, groups, 0) });
    expect(plans).toHaveLength(1);
  });
});
