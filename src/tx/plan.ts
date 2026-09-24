// ABOUTME: planTransfer / planSpend (SPEC §4.6) — build inspectable Plan(s) for a shielded spend: single-tree
// ABOUTME: TXO selection, change, broadcaster fee, circuit shape, and multi-group split. No proving; pure.

import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import {
  InsufficientBalanceError,
  UnsupportedCircuitShapeError,
  TooFragmentedError,
  InvalidRequestError,
} from '../errors';
import { shapeKey, type CircuitShape } from '../prover/index';
import type { Plan, PlanSelection, PlanOutput, PlanSummary, DecodedBoundParams, CctpBinding } from './index';
import { verifyCctpBinding } from './adapt-params';
import { isSupportedShape, maxSupportedInputCount } from './shapes';
import type { WitnessInput } from './witness';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

/** Max groups in one atomic batch (proving is serial; this bounds worst-case latency). Beyond → consolidate. */
export const MAX_SPLIT_GROUPS = 4;

export interface TransferOutputRequest {
  readonly toShieldedAddress: string;
  readonly value: bigint;
  readonly memo?: string;
}

/**
 * The broadcaster (relayer) fee, paid as a shielded output note to the broadcaster's 0zk address.
 * `value` is the PER-PROOF fee: a split batch of k proofs pays `k × value` (each proof costs the
 * broadcaster its own verification gas), carried by fee notes in the batch's leading groups.
 */
export interface FeeRequest {
  readonly broadcasterShieldedAddress: string;
  readonly value: bigint;
}

export interface PlanTransferParams {
  /** Candidate spendable notes (typically the wallet's unspent TXOs for the chain). */
  readonly txos: readonly TXO[];
  readonly tokenAddress: `0x${string}`;
  readonly outputs: readonly TransferOutputRequest[];
  readonly fee?: FeeRequest;
  /**
   * Unshield output — sends `value` to an EVM `recipient` (funds leave the pool). Modelled as the
   * LAST output commitment (a public `UnshieldNoteERC20`, npk = recipient), so it counts toward the
   * spend target + circuit shape but carries no ciphertext.
   *
   * `adaptParams` binds a destination commitment into `boundParams.adaptParams` (a SNARK public
   * input) — e.g. the cross-chain-unshield CCTP tuple from `encodeCctpBinding`, or a yield re-shield
   * binding. Omitted for a plain same-chain unshield (defaults to `ZERO_BYTES32`).
   *
   * `adaptContract` is the cross-contract-call target committed by the proof. Defaults to
   * `ZERO_ADDRESS` (a plain unshield-to-pool). Set it to the adapter address for a relay-adapt call
   * (e.g. the yield adapter for `lendAndShield`/`redeemAndShield`), where `recipient` is that adapter.
   */
  readonly unshield?: {
    readonly recipient: `0x${string}`;
    readonly value: bigint;
    readonly adaptParams?: `0x${string}`;
    readonly adaptContract?: `0x${string}`;
    /**
     * The DECODED cross-chain binding matching `adaptParams` — carried through to the signer as
     * `boundParams.decodedAdaptParams` so an external/policy signer can inspect the CCTP destination it
     * authorizes. When provided it MUST encode to `adaptParams` (asserted), else the plan is rejected.
     */
    readonly adaptBinding?: CctpBinding;
  };
  /** Per-tree merkle roots (the input notes' tree must have an entry). */
  readonly roots: ReadonlyMap<number, bigint>;
  readonly chainID: bigint;
  readonly minGasPrice?: bigint;
  /**
   * Shape keys (`<nullifiers>x<commitments>`) the deployment has circuit artifacts for. When provided,
   * `planSpend` splits a fragmented single-recipient transfer across groups that all land on registered
   * shapes, and rejects anything it can't fit with `UnsupportedCircuitShapeError`; `planTransfer` (single
   * group only) rejects an unregistered shape outright. Either way this fails fast, before the signer is
   * asked and 30s of proving is spent. Omit to skip the check (and never split).
   */
  readonly supportedShapes?: ReadonlySet<string>;
}

/** Railgun unshield flag (boundParams). NONE = plain transfer; UNSHIELD = a normal unshield. */
const UNSHIELD_FLAG_NONE = 0;
const UNSHIELD_FLAG_UNSHIELD = 1;

// Greedy largest-first selection within one tree; returns the covering set (largest-first) or undefined.
export function selectWithinTree(txos: readonly TXO[], target: bigint): { selected: TXO[]; total: bigint } | undefined {
  const sorted = [...txos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const selected: TXO[] = [];
  let total = 0n;
  for (const txo of sorted) {
    if (total >= target) break;
    selected.push(txo);
    total += txo.value;
  }
  return total >= target ? { selected, total } : undefined;
}

export interface Cover {
  readonly tree: number;
  readonly selected: TXO[];
  readonly total: bigint;
  readonly merkleRoot: bigint;
}

/** Pick the single tree that covers `target` with the fewest input notes (largest-first within a tree). */
function pickFewestInputCover(params: PlanTransferParams, target: bigint): Cover | undefined {
  const tokenHash = getTokenDataHash(getTokenDataERC20(params.tokenAddress));
  const eligible = params.txos.filter((t) => t.tokenHash === tokenHash);

  const byTree = new Map<number, TXO[]>();
  for (const txo of eligible) {
    const bucket = byTree.get(txo.tree);
    if (bucket) bucket.push(txo);
    else byTree.set(txo.tree, [txo]);
  }

  let best: { tree: number; selected: TXO[]; total: bigint } | undefined;
  for (const [tree, txos] of byTree) {
    const pick = selectWithinTree(txos, target);
    if (pick && (best === undefined || pick.selected.length < best.selected.length)) {
      best = { tree, selected: pick.selected, total: pick.total };
    }
  }
  if (best === undefined) return undefined;
  const merkleRoot = params.roots.get(best.tree);
  if (merkleRoot === undefined) throw new Error(`planTransfer: no merkle root supplied for tree ${best.tree}`);
  return { ...best, merkleRoot };
}

/** The output components of one group/plan, from which the shape + summary + boundParams are derived. */
export interface GroupOutputs {
  readonly outputs: readonly PlanOutput[];
  readonly feeOutput?: PlanOutput;
  readonly changeValue: bigint;
  /** Present only for an unshield leg (single-group path); split groups are plain transfers. */
  readonly unshield?: { readonly recipient: `0x${string}`; readonly value: bigint };
}

/** The request fields a group's summary + boundParams are built from (token, chain, gas price, unshield binding). */
export type SelectionContext = Pick<PlanTransferParams, 'tokenAddress' | 'chainID' | 'minGasPrice' | 'unshield'>;

/** Assemble one PlanSelection from a chosen cover + its resolved output components. Pure. */
export function assembleSelection(params: SelectionContext, cover: Cover, parts: GroupOutputs): PlanSelection {
  const commitments =
    parts.outputs.length + (parts.feeOutput ? 1 : 0) + (parts.changeValue > 0n ? 1 : 0) + (parts.unshield ? 1 : 0);
  const shape: CircuitShape = { nullifiers: cover.selected.length, commitments };

  const summary: PlanSummary = {
    tokenAddress: params.tokenAddress,
    inputTotal: cover.total,
    outputs: parts.outputs,
    changeValue: parts.changeValue,
    ...(parts.feeOutput ? { feeOutput: parts.feeOutput } : {}),
    ...(parts.unshield ? { unshield: parts.unshield } : {}),
  };

  const adaptBinding = params.unshield?.adaptBinding;
  const boundParams: DecodedBoundParams = {
    treeNumber: cover.tree,
    minGasPrice: params.minGasPrice ?? 0n,
    unshield: parts.unshield ? UNSHIELD_FLAG_UNSHIELD : UNSHIELD_FLAG_NONE,
    chainID: params.chainID,
    adaptContract: parts.unshield ? params.unshield?.adaptContract ?? ZERO_ADDRESS : ZERO_ADDRESS,
    adaptParams: parts.unshield ? params.unshield?.adaptParams ?? ZERO_BYTES32 : ZERO_BYTES32,
    ...(parts.unshield && adaptBinding !== undefined ? { decodedAdaptParams: adaptBinding } : {}),
  };

  return { shape, merkleRoot: cover.merkleRoot, summary, boundParams, selectedInputs: cover.selected };
}

/** The recipient/fee/change output components for a whole-spend single group (recipients + fee + unshield). */
function singleGroupOutputs(params: PlanTransferParams, changeValue: bigint): GroupOutputs {
  const outputs: PlanOutput[] = params.outputs.map((o) => ({
    toShieldedAddress: o.toShieldedAddress,
    value: o.value,
    tokenAddress: params.tokenAddress,
    ...(o.memo !== undefined ? { memo: o.memo } : {}),
  }));
  const feeOutput: PlanOutput | undefined = params.fee
    ? { toShieldedAddress: params.fee.broadcasterShieldedAddress, value: params.fee.value, tokenAddress: params.tokenAddress }
    : undefined;
  return {
    outputs,
    ...(feeOutput ? { feeOutput } : {}),
    changeValue,
    ...(params.unshield ? { unshield: { recipient: params.unshield.recipient, value: params.unshield.value } } : {}),
  };
}

function spendTarget(params: PlanTransferParams): bigint {
  const outputTotal = params.outputs.reduce((sum, o) => sum + o.value, 0n);
  const target = outputTotal + (params.fee?.value ?? 0n) + (params.unshield?.value ?? 0n);
  if (target <= 0n) {
    throw new InvalidRequestError('planTransfer: total output (outputs + fee + unshield) must be positive');
  }
  return target;
}

function assertAdaptBinding(params: PlanTransferParams): void {
  const adaptBinding = params.unshield?.adaptBinding;
  if (adaptBinding === undefined) return;
  const encoded = params.unshield?.adaptParams;
  if (encoded === undefined || !verifyCctpBinding(encoded, adaptBinding.recipient, adaptBinding.destDomain, adaptBinding.maxFee)) {
    throw new InvalidRequestError('planTransfer: unshield.adaptBinding does not match unshield.adaptParams');
  }
}

/** Whether `shape` has a registered circuit. An absent set means "don't check" (always supported). */
export function shapeSupported(supported: ReadonlySet<string> | undefined, shape: CircuitShape): boolean {
  return supported === undefined || isSupportedShape(supported, shape.nullifiers, shape.commitments);
}

/** Select the fewest-input single-tree cover for the whole spend and assemble it as ONE group. */
function planSingleGroup(params: PlanTransferParams, caller: string): PlanSelection {
  const target = spendTarget(params);
  const cover = pickFewestInputCover(params, target);
  if (cover === undefined) {
    throw new InsufficientBalanceError(
      `${caller}: no single tree covers ${target.toString()} of token ${params.tokenAddress}`,
    );
  }
  assertAdaptBinding(params);
  return assembleSelection(params, cover, singleGroupOutputs(params, cover.total - target));
}

/**
 * Plan a shielded transfer as a SINGLE group (SPEC §4.6). Selects input notes from one tree covering
 * `sum(outputs) + fee + unshield`, preferring the tree that needs the fewest inputs. Throws
 * `UnsupportedCircuitShapeError` when the resulting shape isn't in `supportedShapes` — use `planSpend`
 * for the fragmented case that splits across multiple supported-shape groups.
 *
 * The broadcaster fee note MUST be emitted FIRST by the prover (the relayer verifies the first
 * decryptable note); the summary carries `feeOutput` separately for that.
 */
export function planTransfer(params: PlanTransferParams): PlanSelection {
  const selection = planSingleGroup(params, 'planTransfer');
  if (!shapeSupported(params.supportedShapes, selection.shape)) {
    throw new UnsupportedCircuitShapeError(
      `planTransfer: no circuit artifact for shape ${shapeKey(selection.shape)} (inputs=${selection.shape.nullifiers}, commitments=${selection.shape.commitments})`,
    );
  }
  return selection;
}

/**
 * How much of the fee, the recipient value, and the change fall inside one group's value window
 * `[from, to)`. A split lays the spend out on one value line — fee `[0, fee)`, then recipient, then
 * change up to the cover total — and each group takes the next contiguous window of it, so a portion
 * that doesn't fit in one group (e.g. a fee larger than a group's notes) simply continues in the next.
 */
function portionsInWindow(
  fee: bigint,
  recipient: bigint,
  coverTotal: bigint,
  from: bigint,
  to: bigint,
): { fee: bigint; recipient: bigint; change: bigint } {
  const overlap = (start: bigint, end: bigint): bigint => {
    const lo = start > from ? start : from;
    const hi = end < to ? end : to;
    return hi > lo ? hi - lo : 0n;
  };
  return {
    fee: overlap(0n, fee),
    recipient: overlap(fee, fee + recipient),
    change: overlap(fee + recipient, coverTotal),
  };
}

/**
 * Split a fragmented single-recipient transfer across multiple supported-shape groups, submitted as one
 * atomic `transact([...])`. Groups take the cover's notes (largest-first) in order, each as many as a
 * registered shape allows for the outputs its value window needs (`portionsInWindow`): a fee portion
 * (emitted first, so the relayer counts it), a recipient portion, and/or change. Every group spends at
 * least one note, and the recipient receives one note per group that carries a recipient portion.
 * Throws `TooFragmentedError` when the notes need more than `MAX_SPLIT_GROUPS` groups (consolidate first —
 * a separate sequential flow), and `UnsupportedCircuitShapeError` when no registered shape fits a group.
 */
function splitTransfer(
  params: PlanTransferParams,
  cover: Cover,
  feeTotal: bigint,
  supported: ReadonlySet<string>,
): PlanSelection[] {
  const recipient = params.outputs[0]!; // caller guarantees exactly one recipient, no unshield
  const maxInputs = maxSupportedInputCount(supported);
  const groups: PlanSelection[] = [];
  let next = 0; // index of the first note not yet assigned to a group
  let from = 0n; // value consumed by the groups so far
  let memoPlaced = false;

  // One candidate group of `n` notes starting at `next`, assembled so its shape can be checked.
  const candidate = (n: number): { selection: PlanSelection; total: bigint; carriesRecipient: boolean } => {
    const notes = cover.selected.slice(next, next + n);
    const total = notes.reduce((s, t) => s + t.value, 0n);
    const portions = portionsInWindow(feeTotal, recipient.value, cover.total, from, from + total);
    const outputs: PlanOutput[] =
      portions.recipient > 0n
        ? [{
            toShieldedAddress: recipient.toShieldedAddress,
            value: portions.recipient,
            tokenAddress: params.tokenAddress,
            // The memo rides on the first recipient note only.
            ...(!memoPlaced && recipient.memo !== undefined ? { memo: recipient.memo } : {}),
          }]
        : [];
    const feeOutput: PlanOutput | undefined =
      portions.fee > 0n
        ? { toShieldedAddress: params.fee!.broadcasterShieldedAddress, value: portions.fee, tokenAddress: params.tokenAddress }
        : undefined;
    const groupCover: Cover = { tree: cover.tree, selected: notes, total, merkleRoot: cover.merkleRoot };
    const selection = assembleSelection(params, groupCover, {
      outputs,
      ...(feeOutput ? { feeOutput } : {}),
      changeValue: portions.change,
    });
    return { selection, total, carriesRecipient: portions.recipient > 0n };
  };

  while (next < cover.selected.length) {
    if (groups.length === MAX_SPLIT_GROUPS) {
      throw new TooFragmentedError(
        `planSpend: spend needs ${cover.selected.length} input notes, more than ${MAX_SPLIT_GROUPS} supported-shape groups can hold; consolidate small notes first`,
      );
    }
    // Take the largest group a registered shape allows (fewest proofs overall).
    let chosen: ReturnType<typeof candidate> | undefined;
    for (let n = Math.min(maxInputs, cover.selected.length - next); n >= 1; n -= 1) {
      const c = candidate(n);
      if (shapeSupported(supported, c.selection.shape)) {
        chosen = c;
        break;
      }
    }
    if (chosen === undefined) {
      throw new UnsupportedCircuitShapeError(
        `planSpend: no registered circuit shape fits split group ${groups.length + 1} (starting at input ${next + 1} of ${cover.selected.length})`,
      );
    }
    groups.push(chosen.selection);
    next += chosen.selection.selectedInputs.length;
    from += chosen.total;
    memoPlaced ||= chosen.carriesRecipient;
  }
  return groups;
}

/**
 * Plan a shielded spend as ONE OR MORE supported-shape groups, submitted atomically. Tries a single
 * group first (fewest inputs); if that shape isn't registered, and the spend is a splittable
 * single-recipient transfer, splits it across supported-shape groups (recipient receives multiple
 * notes). Unshields / multi-recipient spends aren't split — they surface `UnsupportedCircuitShapeError`.
 * Very fragmented wallets that exceed the batch cap raise `TooFragmentedError`.
 *
 * A split of k proofs pays the per-proof fee k times. Since the fee is part of the spend target, it
 * changes which notes are selected and how they group, so each k from 2 up is tried in turn and the
 * first plan that fits in at most k proofs wins. The fee paid is therefore always at least one
 * per-proof fee per proof; it can exceed that when the larger fee happens to let the notes fit in fewer
 * proofs (e.g. it absorbs the change, dropping an output) — still the cheapest fee that yields a plan.
 */
export function planSpend(params: PlanTransferParams): PlanSelection[] {
  const single = planSingleGroup(params, 'planSpend');
  const supported = params.supportedShapes;
  if (supported === undefined || shapeSupported(supported, single.shape)) return [single];

  // Single-group shape unsupported. Split only a plain single-recipient transfer (no unshield leg).
  const splittable = params.unshield === undefined && params.outputs.length === 1;
  if (!splittable) {
    throw new UnsupportedCircuitShapeError(
      `planSpend: no circuit for shape ${shapeKey(single.shape)} and this spend is not splittable ` +
        `(inputs=${single.shape.nullifiers}, commitments=${single.shape.commitments})`,
    );
  }

  const recipientValue = params.outputs[0]!.value;
  const perProofFee = params.fee?.value ?? 0n;
  for (let proofs = 2; proofs <= MAX_SPLIT_GROUPS; proofs += 1) {
    const feeTotal = perProofFee * BigInt(proofs);
    const target = recipientValue + feeTotal;
    const cover = pickFewestInputCover(params, target);
    if (cover === undefined) {
      throw new InsufficientBalanceError(
        `planSpend: no single tree covers ${target.toString()} of token ${params.tokenAddress} ` +
          `(the transfer needs ${proofs} proofs, each paying the broadcaster fee)`,
      );
    }
    const groups = splitTransfer(params, cover, feeTotal, supported);
    if (groups.length <= proofs) return groups;
  }
  throw new TooFragmentedError(
    `planSpend: spend does not fit in ${MAX_SPLIT_GROUPS} supported-shape groups; consolidate small notes first`,
  );
}

/** A single plan or the groups of a split spend, as a list. */
export function planList(plan: Plan | readonly Plan[]): readonly Plan[] {
  return 'selectedInputs' in plan ? [plan] : plan;
}

/**
 * Build the witness inputs for a plan from its OWN captured merkle proofs (SPEC §4.6). Reading
 * `plan.merkleProofs` — snapshotted at plan time alongside `plan.merkleRoot` — rather than deriving
 * proofs from live scan state is what keeps the path elements consistent with the proved root: a sync
 * that appends to the tree between planning and proving no longer produces an unprovable stale-root
 * witness. Throws if a proof is missing (a plan that wasn't built by the wallet).
 */
export function planWitnessInputs(plan: Plan): WitnessInput[] {
  return plan.selectedInputs.map((txo, i) => {
    const merkleProofElements = plan.merkleProofs[i];
    if (merkleProofElements === undefined) {
      throw new Error(`planWitnessInputs: plan is missing a captured merkle proof for input ${i}`);
    }
    return { random: txo.random, value: txo.value, position: txo.position, merkleProofElements };
  });
}
