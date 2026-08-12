// ABOUTME: planTransfer (SPEC §4.6) — builds an inspectable Plan for a shielded transfer: single-tree
// ABOUTME: TXO selection, change, broadcaster fee output, and circuit shape. No proving; pure/deterministic.

import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError, UnsupportedCircuitShapeError } from '../errors';
import { shapeKey, type CircuitShape } from '../prover/index';
import type { Plan, PlanSelection, PlanOutput, PlanSummary, DecodedBoundParams, CctpBinding } from './index';
import { verifyCctpBinding } from './adapt-params';
import type { WitnessInput } from './witness';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

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

// Greedy largest-first selection within one tree; returns the covering set or undefined.
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

/**
 * Plan a shielded transfer. Selects input notes from a SINGLE tree (a transaction proves against one
 * tree root) covering `sum(outputs) + fee`, preferring the tree that needs the fewest inputs. Produces
 * an inspectable `Plan` — the circuit shape counts every output that becomes a commitment: the
 * recipient note(s), the broadcaster fee note, and a change note when `inputTotal > spent`.
 *
 * Output ordering for the prover (Phase 0 Spike 2): the broadcaster fee note MUST be emitted FIRST,
 * because the relayer verifies the first decryptable note. The summary carries `feeOutput` separately;
 * the prove step is responsible for placing it first.
 */
export function planTransfer(params: PlanTransferParams): PlanSelection {
  const outputTotal = params.outputs.reduce((sum, o) => sum + o.value, 0n);
  const feeValue = params.fee?.value ?? 0n;
  const unshieldValue = params.unshield?.value ?? 0n;
  const target = outputTotal + feeValue + unshieldValue;
  if (target <= 0n) {
    throw new Error('planTransfer: total output (outputs + fee + unshield) must be positive');
  }

  const tokenHash = getTokenDataHash(getTokenDataERC20(params.tokenAddress));
  const eligible = params.txos.filter((t) => t.tokenHash === tokenHash);

  // Group eligible notes by tree, then pick the covering set that needs the fewest inputs.
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
  if (best === undefined) {
    throw new InsufficientBalanceError(
      `planTransfer: no single tree covers ${target.toString()} of token ${params.tokenAddress}`,
    );
  }

  const merkleRoot = params.roots.get(best.tree);
  if (merkleRoot === undefined) {
    throw new Error(`planTransfer: no merkle root supplied for tree ${best.tree}`);
  }

  const changeValue = best.total - target;
  const outputs: PlanOutput[] = params.outputs.map((o) => ({
    toShieldedAddress: o.toShieldedAddress,
    value: o.value,
    tokenAddress: params.tokenAddress,
    ...(o.memo !== undefined ? { memo: o.memo } : {}),
  }));
  const feeOutput: PlanOutput | undefined = params.fee
    ? { toShieldedAddress: params.fee.broadcasterShieldedAddress, value: params.fee.value, tokenAddress: params.tokenAddress }
    : undefined;

  // The unshield is the LAST output commitment (public), so it counts in the circuit shape.
  const commitments =
    outputs.length + (feeOutput ? 1 : 0) + (changeValue > 0n ? 1 : 0) + (params.unshield ? 1 : 0);
  const shape: CircuitShape = { nullifiers: best.selected.length, commitments };

  // Fail fast if the deployment has no circuit for this shape — before the signer is asked and proving
  // starts. A fragmented wallet whose covering set needs more inputs than any supported shape allows
  // lands here (multi-transaction batching is not yet implemented).
  if (params.supportedShapes !== undefined && !params.supportedShapes.has(shapeKey(shape))) {
    throw new UnsupportedCircuitShapeError(
      `planTransfer: no circuit artifact for shape ${shapeKey(shape)} (inputs=${shape.nullifiers}, commitments=${shape.commitments})`,
    );
  }

  const summary: PlanSummary = {
    tokenAddress: params.tokenAddress,
    inputTotal: best.total,
    outputs,
    changeValue,
    ...(feeOutput ? { feeOutput } : {}),
    ...(params.unshield ? { unshield: { recipient: params.unshield.recipient, value: params.unshield.value } } : {}),
  };

  // If the caller supplied a decoded CCTP binding, it must match the encoded adaptParams the proof
  // commits — otherwise the signer would inspect a destination the proof doesn't actually bind.
  const adaptBinding = params.unshield?.adaptBinding;
  if (adaptBinding !== undefined) {
    const encoded = params.unshield?.adaptParams;
    if (encoded === undefined || !verifyCctpBinding(encoded, adaptBinding.recipient, adaptBinding.destDomain, adaptBinding.maxFee)) {
      throw new Error('planTransfer: unshield.adaptBinding does not match unshield.adaptParams');
    }
  }

  const boundParams: DecodedBoundParams = {
    treeNumber: best.tree,
    minGasPrice: params.minGasPrice ?? 0n,
    unshield: params.unshield ? UNSHIELD_FLAG_UNSHIELD : UNSHIELD_FLAG_NONE,
    chainID: params.chainID,
    adaptContract: params.unshield?.adaptContract ?? ZERO_ADDRESS,
    adaptParams: params.unshield?.adaptParams ?? ZERO_BYTES32,
    ...(adaptBinding !== undefined ? { decodedAdaptParams: adaptBinding } : {}),
  };

  return { shape, merkleRoot, summary, boundParams, selectedInputs: best.selected };
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
