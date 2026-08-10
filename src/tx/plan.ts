// ABOUTME: planTransfer (SPEC §4.6) — builds an inspectable Plan for a shielded transfer: single-tree
// ABOUTME: TXO selection, change, broadcaster fee output, and circuit shape. No proving; pure/deterministic.

import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TXO } from '../sync/index';
import { InsufficientBalanceError } from '../errors';
import type { CircuitShape } from '../prover/index';
import type { Plan, PlanOutput, PlanSummary, DecodedBoundParams } from './index';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

export interface TransferOutputRequest {
  readonly toRailgunAddress: string;
  readonly value: bigint;
  readonly memo?: string;
}

/** The broadcaster (relayer) fee, paid as a shielded output note to the broadcaster's 0zk address. */
export interface FeeRequest {
  readonly broadcasterRailgunAddress: string;
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
   * input) — e.g. the cross-chain-unshield CCTP tuple from `encodeCctpBinding`. Omitted for a plain
   * same-chain unshield (defaults to `ZERO_BYTES32`). `adaptContract` stays `ZERO_ADDRESS`: this is
   * an unshield-to-pool, not a relay-adapt cross-contract call.
   */
  readonly unshield?: { readonly recipient: `0x${string}`; readonly value: bigint; readonly adaptParams?: `0x${string}` };
  /** Per-tree merkle roots (the input notes' tree must have an entry). */
  readonly roots: ReadonlyMap<number, bigint>;
  readonly chainID: bigint;
  readonly minGasPrice?: bigint;
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
export function planTransfer(params: PlanTransferParams): Plan {
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
    toRailgunAddress: o.toRailgunAddress,
    value: o.value,
    tokenAddress: params.tokenAddress,
    ...(o.memo !== undefined ? { memo: o.memo } : {}),
  }));
  const feeOutput: PlanOutput | undefined = params.fee
    ? { toRailgunAddress: params.fee.broadcasterRailgunAddress, value: params.fee.value, tokenAddress: params.tokenAddress }
    : undefined;

  // The unshield is the LAST output commitment (public), so it counts in the circuit shape.
  const commitments =
    outputs.length + (feeOutput ? 1 : 0) + (changeValue > 0n ? 1 : 0) + (params.unshield ? 1 : 0);
  const shape: CircuitShape = { nullifiers: best.selected.length, commitments };

  const summary: PlanSummary = {
    tokenAddress: params.tokenAddress,
    inputTotal: best.total,
    outputs,
    changeValue,
    ...(feeOutput ? { feeOutput } : {}),
    ...(params.unshield ? { unshield: { recipient: params.unshield.recipient, value: params.unshield.value } } : {}),
  };

  const boundParams: DecodedBoundParams = {
    treeNumber: best.tree,
    minGasPrice: params.minGasPrice ?? 0n,
    unshield: params.unshield ? UNSHIELD_FLAG_UNSHIELD : UNSHIELD_FLAG_NONE,
    chainID: params.chainID,
    adaptContract: ZERO_ADDRESS,
    adaptParams: params.unshield?.adaptParams ?? ZERO_BYTES32,
  };

  return { shape, merkleRoot, summary, boundParams, selectedInputs: best.selected };
}
