// ABOUTME: Balance aggregation (SPEC §4.4) — per-token spendable/pending from a wallet's decrypted
// ABOUTME: TXO set, spent-nullifier events, and a finality threshold. Collapses Railgun's POI buckets.

import { TransactNote } from '../core/index';

/**
 * A wallet-owned commitment (a decrypted note) located in the UTXO merkletree. `tree`/`position`
 * come from the commitment's insertion context; `blockNumber` is the block the commitment landed in.
 * `tokenHash` is the canonical 32-byte token hash (no `0x`); address mapping is the caller's job.
 */
export interface TXO {
  readonly tree: number;
  readonly position: number;
  readonly tokenHash: string;
  readonly value: bigint;
  readonly blockNumber: number;
  /** 16-byte note random (hex, no 0x) — required to rebuild the spend witness (`randomIn`). */
  readonly random: string;
  /** Note public key `poseidon(masterPublicKey, random)` — the commitment's npk. */
  readonly notePublicKey: bigint;
}

/**
 * A spent-note marker from a Nullify event, scoped to its owning UTXO tree. The tree scope is
 * load-bearing: `getNullifier(nullifyingKey, position)` does NOT include the tree, so the same
 * position in two different trees yields the SAME nullifier. Spentness must therefore be matched
 * per `(tree, nullifier)` to avoid cross-tree collisions (Railgun 9.5.4 fix).
 */
export interface SpentNullifier {
  readonly tree: number;
  readonly nullifier: bigint;
}

/** Per-token aggregated balance. `tokenHash` is the canonical 32-byte hash (no `0x`). */
export interface TokenBalance {
  readonly tokenHash: string;
  readonly spendable: bigint;
  readonly pending: bigint;
}

export interface BalanceOptions {
  /** Current chain head block. */
  readonly currentBlock: number;
  /** Confirmations required before a TXO is spendable; TXOs newer than this are `pending`. */
  readonly finalityThreshold: number;
}

// Composite key for tree-scoped nullifier matching.
function spentKey(tree: number, nullifier: bigint): string {
  return `${tree}:${nullifier.toString()}`;
}

/**
 * Aggregate a wallet's TXOs into per-token spendable/pending balances.
 *
 * - A TXO is **spent** (contributes to neither) iff its tree-scoped nullifier
 *   `(txo.tree, getNullifier(nullifyingKey, txo.position))` appears in `spentNullifiers`.
 * - An unspent TXO is **spendable** once it has at least `finalityThreshold` confirmations
 *   (`blockNumber <= currentBlock - finalityThreshold`), otherwise **pending**.
 *
 * Pure and deterministic: output is sorted by `tokenHash`.
 */
export function computeBalances(
  txos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
  options: BalanceOptions,
): TokenBalance[] {
  const spentSet = new Set(spentNullifiers.map((s) => spentKey(s.tree, s.nullifier)));
  const finalityCutoff = options.currentBlock - options.finalityThreshold;

  const perToken = new Map<string, { spendable: bigint; pending: bigint }>();
  for (const txo of txos) {
    const nullifier = TransactNote.getNullifier(nullifyingKey, txo.position);
    if (spentSet.has(spentKey(txo.tree, nullifier))) {
      continue; // spent — no longer part of the balance
    }
    const bucket = perToken.get(txo.tokenHash) ?? { spendable: 0n, pending: 0n };
    if (txo.blockNumber <= finalityCutoff) {
      bucket.spendable += txo.value;
    } else {
      bucket.pending += txo.value;
    }
    perToken.set(txo.tokenHash, bucket);
  }

  return [...perToken.entries()]
    .map(([tokenHash, b]) => ({ tokenHash, spendable: b.spendable, pending: b.pending }))
    .sort((a, b) => (a.tokenHash < b.tokenHash ? -1 : a.tokenHash > b.tokenHash ? 1 : 0));
}

/** Build a TXO from a decrypted note plus its merkletree location and commitment block. */
export function txoFromNote(
  note: TransactNote,
  tree: number,
  position: number,
  blockNumber: number,
): TXO {
  return {
    tree,
    position,
    tokenHash: note.tokenHash,
    value: note.value,
    blockNumber,
    random: note.random,
    notePublicKey: note.notePublicKey,
  };
}
