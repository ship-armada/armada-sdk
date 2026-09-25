// ABOUTME: maxTransferAmount (pure) — the largest single-recipient transfer the planner can build from the wallet's
// ABOUTME: notes, fee included: checks each "whole notes minus k per-proof fees" candidate against planSpend itself.

import { getTokenDataERC20, getTokenDataHash } from '../core/index';
import { InsufficientBalanceError, TooFragmentedError, UnsupportedCircuitShapeError } from '../errors';
import { MAX_SPLIT_GROUPS, planSpend, type PlanTransferParams } from './plan';
import { maxSupportedInputCount } from './shapes';

/** The planner request for a transfer, less its recipient output (the max doesn't depend on who receives it). */
export type MaxTransferParams = Omit<PlanTransferParams, 'outputs' | 'unshield'>;

// The recipient is irrelevant to which notes are selected or how they group; any address plans the same.
const PROBE_RECIPIENT = '0zk_max_transfer_probe';

/**
 * The largest amount a single-recipient transfer can send (SPEC §4.6), fee included — what a wallet's
 * "Max" should offer. Returns 0 when nothing can be sent.
 *
 * A transfer spends notes from ONE tree, largest first, and a split into k proofs pays the per-proof fee
 * k times, so the fee steps up with the amount and the max isn't simply "balance minus a fee". At the
 * max the spend uses its notes up exactly (any change could have been sent instead), so the candidates
 * are, per tree, "the n largest notes minus k fees" for every n a batch can spend and every k up to the
 * batch cap. Each is checked with `planSpend` itself — the same rules `planTransfer` applies — and the
 * largest that plans wins.
 */
export function maxTransferAmount(params: MaxTransferParams): bigint {
  for (const amount of candidateAmounts(params)) {
    if (plans(params, amount)) return amount;
  }
  return 0n;
}

/** Every "n largest notes of one tree minus k per-proof fees" amount, largest first, without duplicates. */
function candidateAmounts(params: MaxTransferParams): bigint[] {
  const tokenHash = getTokenDataHash(getTokenDataERC20(params.tokenAddress));
  const byTree = new Map<number, bigint[]>();
  for (const txo of params.txos) {
    if (txo.tokenHash !== tokenHash || txo.value <= 0n) continue;
    const values = byTree.get(txo.tree);
    if (values) values.push(txo.value);
    else byTree.set(txo.tree, [txo.value]);
  }

  const perProofFee = params.fee?.value ?? 0n;
  // Without a shape set the planner never splits: one proof, any number of notes.
  const maxProofs = params.supportedShapes === undefined ? 1 : MAX_SPLIT_GROUPS;
  const maxNotes = params.supportedShapes === undefined
    ? Number.POSITIVE_INFINITY
    : MAX_SPLIT_GROUPS * maxSupportedInputCount(params.supportedShapes);

  const candidates = new Set<bigint>();
  for (const values of byTree.values()) {
    values.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    let notesTotal = 0n;
    for (let n = 0; n < values.length && n < maxNotes; n += 1) {
      notesTotal += values[n]!;
      for (let proofs = 1; proofs <= maxProofs; proofs += 1) {
        const amount = notesTotal - perProofFee * BigInt(proofs);
        if (amount > 0n) candidates.add(amount);
      }
    }
  }
  return [...candidates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// Whether the planner can build a transfer of `amount`; only "can't be planned" outcomes count as no.
function plans(params: MaxTransferParams, amount: bigint): boolean {
  try {
    planSpend({ ...params, outputs: [{ toShieldedAddress: PROBE_RECIPIENT, value: amount }] });
    return true;
  } catch (err) {
    if (
      err instanceof InsufficientBalanceError ||
      err instanceof TooFragmentedError ||
      err instanceof UnsupportedCircuitShapeError
    ) {
      return false;
    }
    throw err;
  }
}
