// ABOUTME: Native tx-history reconstruction (SPEC §5) — derives HistoryEntry[] from the wallet's own
// ABOUTME: scan state (owned notes + spent nullifiers), NOT a port of Railgun's getWalletTransactionHistory.

import { TransactNote } from '../core/index';
import type { TXO, SpentNullifier } from './balances';

export type HistoryCategory =
  | 'shield'
  | 'transfer-received'
  | 'transfer-sent'
  | 'unshield'
  | 'yield-deposit'
  | 'yield-withdraw';

/**
 * One value movement the wallet participated in. Flat per (txid, owned-note) — a consumer groups by
 * `txid` for a per-transaction view. `value` is the wallet delta for `tokenAddress`: positive for
 * receives, negative for sends (set by later phases). Amounts are token base units.
 */
export interface HistoryEntry {
  readonly txid: string;
  readonly blockNumber: number;
  readonly category: HistoryCategory;
  readonly tokenAddress: `0x${string}`;
  readonly value: bigint;
  /** Relayer fee paid (sends/unshields). */
  readonly broadcasterFee?: bigint;
  /** Shield fee charged (shield receives). */
  readonly shieldFee?: bigint;
  /** Sender's 0zk, if they disclosed it (transfer receives). */
  readonly senderRailgunAddress?: string;
  readonly memo?: string;
  /** Unix seconds — attached by `wallet.history()` from the block; absent in the pure reconstruction. */
  readonly timestamp?: number;
}

/** Resolve a 32-byte token hash to its address; return undefined to skip notes in unknown tokens. */
export type TokenAddressResolver = (tokenHash: string) => `0x${string}` | undefined;

const nullifierKey = (tree: number, nullifier: bigint): string => `${tree}:${nullifier.toString()}`;

const sortEntries = (a: HistoryEntry, b: HistoryEntry): number =>
  a.blockNumber - b.blockNumber || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);

/**
 * Reconstruct RECEIVE history (H1): shields the wallet deposited + transfers it received. Owned
 * transact-origin notes created in a tx where the wallet ALSO spent an input are its own change, not
 * incoming transfers, so they are excluded here — the corresponding send entry is produced by the
 * spend-side reconstruction (H2). Requires the nullifying key to detect the wallet's own spends;
 * a view-only wallet has it (derived from the viewing key), so this works for view-only too.
 */
export function reconstructReceiveHistory(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
  resolveToken: TokenAddressResolver,
): HistoryEntry[] {
  const spentSet = new Set(spentNullifiers.map((s) => nullifierKey(s.tree, s.nullifier)));
  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));

  // Txids in which THIS wallet spent an input — its transact outputs there are change, not receives.
  const ownSpendTxids = new Set<string>();
  for (const txo of ownedTxos) {
    const key = nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position));
    if (spentSet.has(key)) ownSpendTxids.add(spendByKey.get(key)!.txid);
  }

  const entries: HistoryEntry[] = [];
  for (const txo of ownedTxos) {
    const tokenAddress = resolveToken(txo.tokenHash);
    if (tokenAddress === undefined) continue;

    if (txo.origin === 'shield') {
      entries.push({
        txid: txo.txid,
        blockNumber: txo.blockNumber,
        category: 'shield',
        tokenAddress,
        value: txo.value,
        ...(txo.shieldFee !== undefined ? { shieldFee: txo.shieldFee } : {}),
      });
      continue;
    }
    // transact-origin: change (skip) if created in one of our own spends, else an incoming transfer.
    if (ownSpendTxids.has(txo.txid)) continue;
    entries.push({
      txid: txo.txid,
      blockNumber: txo.blockNumber,
      category: 'transfer-received',
      tokenAddress,
      value: txo.value,
      ...(txo.memo !== undefined ? { memo: txo.memo } : {}),
      ...(txo.senderRailgunAddress !== undefined ? { senderRailgunAddress: txo.senderRailgunAddress } : {}),
    });
  }
  return entries.sort(sortEntries);
}
