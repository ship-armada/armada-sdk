// ABOUTME: Balance aggregation (SPEC §4.4) — per-token spendable/pending from a wallet's decrypted
// ABOUTME: TXO set, spent-nullifier events, and a finality threshold. Collapses the stock proof-buckets.

import { TransactNote } from '../core/index';

/**
 * A wallet-owned commitment (a decrypted note) located in the UTXO merkletree. `tree`/`position`
 * come from the commitment's insertion context; `blockNumber` is the block the commitment landed in.
 * `tokenHash` is the canonical 32-byte token hash (no `0x`); address mapping is the caller's job.
 */
/** Whether an owned note was created by a Shield event (self-deposit) or a Transact (transfer/change). */
export type NoteOrigin = 'shield' | 'transact';

export interface TXO {
  readonly tree: number;
  readonly position: number;
  readonly tokenHash: string;
  readonly value: bigint;
  readonly blockNumber: number;
  /** Transaction that created this commitment — groups a wallet's receives per tx for history. */
  readonly txid: string;
  /** Which event created it — distinguishes a received shield from a received transfer/change. */
  readonly origin: NoteOrigin;
  /** Memo the sender attached (transfer receives), if any. */
  readonly memo?: string;
  /** Sender's 0zk, present only if disclosed (transfer receives). */
  readonly senderShieldedAddress?: string;
  /** The shield fee charged on this deposit (shield origin only) — from the Shield event's `fees`. */
  readonly shieldFee?: bigint;
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
  /** Transaction + block that spent the note — locates/dates the spend for send/unshield history. */
  readonly txid: string;
  readonly blockNumber: number;
}

/**
 * Per-token aggregated balance. `tokenHash` is the canonical 32-byte hash (no `0x`); `tokenAddress`
 * is its registered ERC-20 address, present for every registered token and `undefined` only for a
 * hash absent from the SDK's token registry (see `withTokenAddresses`). `computeBalances` leaves
 * `tokenAddress` unset — the aggregation is pure over hashes; the address is attached at a layer
 * that holds the registry.
 */
export interface TokenBalance {
  readonly tokenHash: string;
  readonly tokenAddress?: `0x${string}`;
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

/**
 * Canonical registry-key form of a token hash: the 32-byte hex with any leading `0x` removed.
 * Owned-note hashes surface both with and without the prefix depending on their source, so the
 * token registry is always keyed and queried through this normalizer.
 */
export function tokenHashKey(tokenHash: string): string {
  return tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash;
}

/**
 * Attach each balance's registered ERC-20 address via `resolve`. A hash with no registered token
 * keeps `tokenAddress` unset and its row is retained — a real balance is never hidden just because
 * its address can't be resolved. Pure: the address lookup is the caller's registry.
 */
export function withTokenAddresses(
  balances: readonly TokenBalance[],
  resolve: (tokenHash: string) => `0x${string}` | undefined,
): TokenBalance[] {
  return balances.map((b) => {
    const tokenAddress = resolve(b.tokenHash);
    return { ...b, ...(tokenAddress !== undefined ? { tokenAddress } : {}) };
  });
}

/** Build a TXO from a decrypted note plus its merkletree location, commitment block, and event context. */
export function txoFromNote(
  note: TransactNote,
  tree: number,
  position: number,
  blockNumber: number,
  txid: string,
  origin: NoteOrigin,
): TXO {
  return {
    tree,
    position,
    tokenHash: note.tokenHash,
    value: note.value,
    blockNumber,
    txid,
    origin,
    random: note.random,
    notePublicKey: note.notePublicKey,
  };
}
