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
import { isSupportedShape } from './shapes';
import type { WitnessInput } from './witness';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

/**
 * Max input notes per split group. 6 = the largest N supported at M=2 (`6x2`), so a split group carrying
 * a recipient portion + (fee OR change) is always a supported shape, and pure-portion middle groups
 * (`Nx1`) are supported for any N ≤ 6 too. Uniform cap keeps every split group provably in-range without
 * per-group shape gymnastics. (M=1 also supports 7,8 but the uniform-6 rule trades a little capacity for
 * a much simpler correctness argument.)
 */
const SPLIT_GROUP_MAX_INPUTS = 6;

/** Max groups in one atomic batch (proving is serial; this bounds worst-case latency). Beyond → consolidate. */
const MAX_SPLIT_GROUPS = 4;

export interface TransferOutputRequest {
  readonly toShieldedAddress: string;
  readonly value: bigint;
  readonly memo?: string;
}

/** The broadcaster (relayer) fee, paid as a shielded output note to the broadcaster's 0zk address. */
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
   * `planTransfer` rejects a plan whose shape isn't in the set with `UnsupportedCircuitShapeError` —
   * fail-fast, before the signer is asked and 30s of proving is spent. Omit to skip the check.
   */
  readonly supportedShapes?: ReadonlySet<string>;
}

/** Railgun unshield flag (boundParams). NONE = plain transfer; UNSHIELD = a normal unshield. */
const UNSHIELD_FLAG_NONE = 0;
const UNSHIELD_FLAG_UNSHIELD = 1;

// Greedy largest-first selection within one tree; returns the covering set (largest-first) or undefined.
function selectWithinTree(txos: readonly TXO[], target: bigint): { selected: TXO[]; total: bigint } | undefined {
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

interface Cover {
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
interface GroupOutputs {
  readonly outputs: readonly PlanOutput[];
  readonly feeOutput?: PlanOutput;
  readonly changeValue: bigint;
  /** Present only for an unshield leg (single-group path); split groups are plain transfers. */
  readonly unshield?: { readonly recipient: `0x${string}`; readonly value: bigint };
}

/** Assemble one PlanSelection from a chosen cover + its resolved output components. Pure. */
function assembleSelection(params: PlanTransferParams, cover: Cover, parts: GroupOutputs): PlanSelection {
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
  const target = spendTarget(params);
  const cover = pickFewestInputCover(params, target);
  if (cover === undefined) {
    throw new InsufficientBalanceError(
      `planTransfer: no single tree covers ${target.toString()} of token ${params.tokenAddress}`,
    );
  }
  assertAdaptBinding(params);
  const selection = assembleSelection(params, cover, singleGroupOutputs(params, cover.total - target));

  if (params.supportedShapes !== undefined && !params.supportedShapes.has(shapeKey(selection.shape))) {
    throw new UnsupportedCircuitShapeError(
      `planTransfer: no circuit artifact for shape ${shapeKey(selection.shape)} (inputs=${selection.shape.nullifiers}, commitments=${selection.shape.commitments})`,
    );
  }
  return selection;
}

/** Split an array (already largest-first) into `g` contiguous near-even chunks (sizes differ by ≤1). */
function partitionEven<T>(items: readonly T[], g: number): T[][] {
  const chunks: T[][] = [];
  const base = Math.floor(items.length / g);
  const rem = items.length % g;
  let i = 0;
  for (let c = 0; c < g; c += 1) {
    const size = base + (c < rem ? 1 : 0);
    chunks.push(items.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/**
 * Split a fragmented single-recipient transfer across multiple supported-shape groups, submitted as one
 * atomic `transact([...])`. Each group spends a disjoint chunk of the SAME cover set (all one tree),
 * carries a portion of the recipient value, the fee note lands in group 0, and change lands in the last
 * group — so every group is `Nx1` or `Nx2` (both dense/supported for N ≤ 6). Throws `TooFragmentedError`
 * when it would need more than `MAX_SPLIT_GROUPS` groups (consolidate first — a separate sequential flow).
 */
function splitTransfer(params: PlanTransferParams, cover: Cover, target: bigint): PlanSelection[] {
  const recipient = params.outputs[0]!; // caller guarantees exactly one recipient, no unshield
  const feeValue = params.fee?.value ?? 0n;
  const change = cover.total - target;
  const hasFee = feeValue > 0n;
  const hasChange = change > 0n;

  const g = Math.max(
    Math.ceil(cover.selected.length / SPLIT_GROUP_MAX_INPUTS),
    hasFee && hasChange ? 2 : 1, // fee + change must live in DIFFERENT groups to keep each at M ≤ 2
  );
  if (g > MAX_SPLIT_GROUPS) {
    throw new TooFragmentedError(
      `planSpend: spend needs ${cover.selected.length} input notes across ${g} groups (> ${MAX_SPLIT_GROUPS}); consolidate small notes first`,
    );
  }

  const chunks = partitionEven(cover.selected, g);
  const groups: PlanSelection[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const inputSum = chunk.reduce((s, t) => s + t.value, 0n);
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const feeThis = isFirst && hasFee ? feeValue : 0n;
    const changeThis = isLast ? change : 0n;
    const portion = inputSum - feeThis - changeThis;
    if (portion < 0n) {
      // A group's inputs can't cover its fee/change obligation — pathological (huge fee vs note sizes).
      throw new InvalidRequestError('planSpend: split produced a negative recipient portion');
    }
    const outputs: PlanOutput[] =
      portion > 0n
        ? [{
            toShieldedAddress: recipient.toShieldedAddress,
            value: portion,
            tokenAddress: params.tokenAddress,
            ...(isFirst && recipient.memo !== undefined ? { memo: recipient.memo } : {}),
          }]
        : [];
    const feeOutput: PlanOutput | undefined =
      feeThis > 0n
        ? { toShieldedAddress: params.fee!.broadcasterShieldedAddress, value: feeValue, tokenAddress: params.tokenAddress }
        : undefined;
    const groupCover: Cover = { tree: cover.tree, selected: chunk, total: inputSum, merkleRoot: cover.merkleRoot };
    const selection = assembleSelection(params, groupCover, {
      outputs,
      ...(feeOutput ? { feeOutput } : {}),
      changeValue: changeThis,
    });
    if (params.supportedShapes !== undefined && !params.supportedShapes.has(shapeKey(selection.shape))) {
      // Should be unreachable given the uniform ≤6 cap + fee/change separation; guard loudly if the
      // supported set ever omits a dense M≤2 shape a split relies on.
      throw new UnsupportedCircuitShapeError(
        `planSpend: split produced unsupported shape ${shapeKey(selection.shape)} (group ${i + 1}/${chunks.length})`,
      );
    }
    groups.push(selection);
  }
  return groups;
}

/**
 * Plan a shielded spend as ONE OR MORE supported-shape groups, submitted atomically. Tries a single
 * group first (fewest inputs); if that shape isn't registered, and the spend is a splittable
 * single-recipient transfer, splits it across supported-shape groups (recipient receives multiple
 * notes). Unshields / multi-recipient spends aren't split — they surface `UnsupportedCircuitShapeError`.
 * Very fragmented wallets that exceed the batch cap raise `TooFragmentedError`.
 */
export function planSpend(params: PlanTransferParams): PlanSelection[] {
  const target = spendTarget(params);
  const cover = pickFewestInputCover(params, target);
  if (cover === undefined) {
    throw new InsufficientBalanceError(
      `planSpend: no single tree covers ${target.toString()} of token ${params.tokenAddress}`,
    );
  }
  assertAdaptBinding(params);

  const single = assembleSelection(params, cover, singleGroupOutputs(params, cover.total - target));
  const supported = params.supportedShapes === undefined || params.supportedShapes.has(shapeKey(single.shape));
  if (supported) return [single];

  // Single-group shape unsupported. Split only a plain single-recipient transfer (no unshield leg).
  const splittable = params.unshield === undefined && params.outputs.length === 1;
  if (splittable) return splitTransfer(params, cover, target);

  throw new UnsupportedCircuitShapeError(
    `planSpend: no circuit for shape ${shapeKey(single.shape)} and this spend is not splittable ` +
      `(inputs=${single.shape.nullifiers}, commitments=${single.shape.commitments})`,
  );
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
