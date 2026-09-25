// ABOUTME: planConsolidate (pure) — merge ONE token's notes into fewer self-owned notes in one atomic batch:
// ABOUTME: old trees first (migrating them to the current tree), then smallest first; per-proof USDC relayer fee.

import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError, NothingToConsolidateError } from '../errors';
import {
  MAX_SPLIT_GROUPS,
  assembleSelection,
  selectWithinTree,
  shapeSupported,
  type Cover,
  type SelectionContext,
} from './plan';
import { maxInputCountForOutputs } from './shapes';
import type { PlanOutput, PlanSelection } from './index';

export interface PlanConsolidateParams {
  /** Candidate spendable notes — every token and tree the wallet holds. */
  readonly txos: readonly TXO[];
  /** The ONE token whose notes this run merges. */
  readonly tokenAddress: `0x${string}`;
  /**
   * The relayer's PER-PROOF fee, paid as a note to the broadcaster in `tokenAddress` (the pool's USDC —
   * the only token the relayer counts). Every proof in the batch pays it once. Omit for no fee note.
   */
  readonly fee?: {
    readonly broadcasterShieldedAddress: string;
    readonly value: bigint;
    readonly tokenAddress: `0x${string}`;
  };
  /** Per-tree merkle roots — an entry for every tree the chosen notes sit in. */
  readonly roots: ReadonlyMap<number, bigint>;
  /** The pool's current (latest) tree. Notes in older trees are merged first, moving them here. */
  readonly currentTree: number;
  readonly chainID: bigint;
  readonly minGasPrice?: bigint;
  /** Registered circuit shapes (`NxM`). Required: every group's size comes from it. */
  readonly supportedShapes: ReadonlySet<string>;
}

/**
 * Plan a consolidation (SPEC §4.6): merge one token's notes into fewer notes owned by the wallet itself,
 * as up to `MAX_SPLIT_GROUPS` proofs submitted atomically in one `transact([...])`.
 *
 * - **Order:** notes in older trees first (spending them moves their value into the current tree, which
 *   the single-tree spend planner then sees as one balance), then the current tree, smallest first.
 * - **Groups:** each spends notes from ONE tree and returns their value as a single self-owned note
 *   (the group's change), sized to the largest registered shape for its outputs.
 * - **Fee:** every proof pays `fee.value`. When the token IS the fee token, each group pays its own fee
 *   note; otherwise the merged groups carry no fee note and one extra fee-token group pays for every
 *   proof in the batch (the relayer sums fee notes across the batch).
 * - **Worth doing:** a current-tree group must merge ≥2 notes; an old-tree note may move alone. A group
 *   paying its own fee must be worth more than it (dust is left in place).
 *
 * Throws `NothingToConsolidateError` when no group is worth making, and `InsufficientBalanceError` when a
 * non-fee-token run's fee can't be covered. Never `TooFragmentedError`: what doesn't fit waits for the
 * next run.
 */
export function planConsolidate(params: PlanConsolidateParams): PlanSelection[] {
  const fee = params.fee;
  const feeInToken = fee !== undefined && fee.tokenAddress.toLowerCase() === params.tokenAddress.toLowerCase();
  const needsFeeGroup = fee !== undefined && !feeInToken;

  const merged = mergeGroups(
    params,
    MAX_SPLIT_GROUPS - (needsFeeGroup ? 1 : 0),
    feeInToken ? fee : undefined,
  );
  if (merged.length === 0) {
    throw new NothingToConsolidateError(
      `planConsolidate: nothing worth merging for token ${params.tokenAddress}`,
    );
  }
  if (!needsFeeGroup) return merged;
  return [...merged, feeGroup(params, fee, fee.value * BigInt(merged.length + 1))];
}

type Fee = NonNullable<PlanConsolidateParams['fee']>;

/** The token's positive-value notes grouped by tree: older trees first, each tree's notes smallest first. */
function notesByTreeInMergeOrder(txos: readonly TXO[], tokenAddress: `0x${string}`): [number, TXO[]][] {
  const tokenHash = getTokenDataHash(getTokenDataERC20(tokenAddress));
  const byTree = new Map<number, TXO[]>();
  for (const txo of txos) {
    if (txo.tokenHash !== tokenHash || txo.value <= 0n) continue;
    const bucket = byTree.get(txo.tree);
    if (bucket) bucket.push(txo);
    else byTree.set(txo.tree, [txo]);
  }
  return [...byTree.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tree, notes]) => [tree, notes.sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))]);
}

// The request fields every group shares; `tokenAddress` is the group's token.
function selectionContext(params: PlanConsolidateParams, tokenAddress: `0x${string}`): SelectionContext {
  return {
    tokenAddress,
    chainID: params.chainID,
    ...(params.minGasPrice !== undefined ? { minGasPrice: params.minGasPrice } : {}),
  };
}

function coverOf(params: PlanConsolidateParams, tree: number, selected: TXO[]): Cover {
  const merkleRoot = params.roots.get(tree);
  if (merkleRoot === undefined) throw new Error(`planConsolidate: no merkle root supplied for tree ${tree}`);
  return { tree, selected, total: selected.reduce((s, t) => s + t.value, 0n), merkleRoot };
}

function feeNote(fee: Fee, value: bigint): PlanOutput {
  return { toShieldedAddress: fee.broadcasterShieldedAddress, value, tokenAddress: fee.tokenAddress };
}

/**
 * The merge groups for the run's token, in merge order, up to `maxGroups`. `ownFee` is set when each
 * group pays its own per-proof fee note (the token is the fee token).
 */
function mergeGroups(params: PlanConsolidateParams, maxGroups: number, ownFee: Fee | undefined): PlanSelection[] {
  const context = selectionContext(params, params.tokenAddress);
  const outputs = ownFee ? 2 : 1; // the merged note, plus the fee note when the group pays it
  const cap = maxInputCountForOutputs(params.supportedShapes, outputs);
  const groups: PlanSelection[] = [];

  for (const [tree, notes] of notesByTreeInMergeOrder(params.txos, params.tokenAddress)) {
    const isOldTree = tree < params.currentTree;
    let next = 0;
    while (next < notes.length && groups.length < maxGroups) {
      // The largest registered group from here (the set is sparse, so check the exact shape).
      let size = Math.min(cap, notes.length - next);
      while (size > 0 && !shapeSupported(params.supportedShapes, { nullifiers: size, commitments: outputs })) size -= 1;
      if (size === 0) break;
      const cover = coverOf(params, tree, notes.slice(next, next + size));
      next += size;

      const mergesSomething = isOldTree || size >= 2;
      const worthItsFee = ownFee === undefined || cover.total > ownFee.value;
      if (!mergesSomething || !worthItsFee) continue;

      groups.push(
        assembleSelection(context, cover, {
          outputs: [],
          ...(ownFee ? { feeOutput: feeNote(ownFee, ownFee.value) } : {}),
          changeValue: ownFee ? cover.total - ownFee.value : cover.total,
        }),
      );
    }
    if (groups.length === maxGroups) break;
  }
  return groups;
}

/**
 * The group that pays a non-fee-token run's fee: the fewest fee-token notes in one tree that cover
 * `feeTotal` (every proof's per-proof fee), returning the rest to the wallet as a self-owned note.
 * It prefers a cover that leaves SOME change: the consolidation's self-metadata tag rides on a change
 * note, and without one a fresh scan reads this merge as an anonymous send. An exact cover (no change)
 * is the fallback when the wallet's fee-token notes allow nothing else.
 */
function feeGroup(params: PlanConsolidateParams, fee: Fee, feeTotal: bigint): PlanSelection {
  const group = feeGroupCovering(params, fee, feeTotal, feeTotal + 1n) ?? feeGroupCovering(params, fee, feeTotal, feeTotal);
  if (group === undefined) {
    throw new InsufficientBalanceError(
      `planConsolidate: no single tree's ${fee.tokenAddress} notes cover the ${feeTotal.toString()} fee for this consolidation`,
    );
  }
  return group;
}

// The fee group spending the fewest fee-token notes in one tree worth at least `target` (≥ `feeTotal`).
function feeGroupCovering(
  params: PlanConsolidateParams,
  fee: Fee,
  feeTotal: bigint,
  target: bigint,
): PlanSelection | undefined {
  const context = selectionContext(params, fee.tokenAddress);
  for (const [tree, notes] of notesByTreeInMergeOrder(params.txos, fee.tokenAddress)) {
    const pick = selectWithinTree(notes, target);
    if (pick === undefined) continue;
    const change = pick.total - feeTotal;
    const shape = { nullifiers: pick.selected.length, commitments: change > 0n ? 2 : 1 };
    if (!shapeSupported(params.supportedShapes, shape)) continue;
    return assembleSelection(context, coverOf(params, tree, pick.selected), {
      outputs: [],
      feeOutput: feeNote(fee, feeTotal),
      changeValue: change,
    });
  }
  return undefined;
}

/**
 * The wallet's notes as they would be once `consolidation` confirms: its inputs gone, and each group's
 * merged note (its change) added to `currentTree`. For PLANNING ONLY — the added notes carry placeholder
 * positions and no spend witness, so a plan over them answers "would this spend work afterwards?" but
 * can never be proved.
 */
export function txosAfterConsolidation(
  txos: readonly TXO[],
  consolidation: readonly PlanSelection[],
  currentTree: number,
): TXO[] {
  const spent = new Set(consolidation.flatMap((g) => g.selectedInputs.map((t) => `${t.tree}:${t.position}`)));
  const remaining = txos.filter((t) => !spent.has(`${t.tree}:${t.position}`));
  const merged = consolidation
    .filter((g) => g.summary.changeValue > 0n)
    .map((g, i): TXO => ({
      tree: currentTree,
      position: Number.MAX_SAFE_INTEGER - i, // placeholder: never a real leaf index
      tokenHash: getTokenDataHash(getTokenDataERC20(g.summary.tokenAddress)),
      value: g.summary.changeValue,
      blockNumber: 0,
      txid: '',
      origin: 'transact',
      random: '00'.repeat(16),
      notePublicKey: 0n,
    }));
  return [...remaining, ...merged];
}
