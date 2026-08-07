// ABOUTME: Native tx-history reconstruction (SPEC §5) — derives HistoryEntry[] from the wallet's own
// ABOUTME: scan state (owned notes + spent nullifiers), NOT a port of Railgun's getWalletTransactionHistory.

import { TransactNote } from '../core/index';
import type { TXO, SpentNullifier } from './balances';
import type { DecodedUnshield } from './event-decoder';

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
  /** Relayer fee paid (sends/unshields) — the in-band broadcaster fee. Populated in H3. */
  readonly broadcasterFee?: bigint;
  /** Shield fee charged (shield receives). */
  readonly shieldFee?: bigint;
  /** Protocol unshield fee (unshield entries) — from the on-chain Unshield event. */
  readonly unshieldFee?: bigint;
  /** Public recipient address (unshield entries). */
  readonly recipient?: string;
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

export interface ReconstructHistoryInput {
  readonly ownedTxos: readonly TXO[];
  readonly spentNullifiers: readonly SpentNullifier[];
  readonly unshields: readonly DecodedUnshield[];
  readonly nullifyingKey: bigint;
  /** Canonical 32-byte hash (no 0x) of the tracked token (USDC). */
  readonly usdcHash: string;
  readonly usdcAddress: `0x${string}`;
  /** Yield adapter address (lowercased-compared); an unshield to it marks a yield op. */
  readonly yieldAdapterAddress?: string;
}

/**
 * Full history reconstruction (H1 receives + H2 sends/unshields/yield). Each transaction the wallet
 * participated in is classified once, per token, from owned notes + spent nullifiers + Unshield events:
 *
 *  - receive tx (no own spend): `shield` / `transfer-received` per created note — unless the tx also
 *    carries an Unshield to the yield adapter, i.e. the USDC leg of a yield withdrawal → `yield-withdraw`.
 *  - spend tx (own inputs nullified): net delta = change − inputs (negative). Category by Unshield:
 *    to the adapter → `yield-deposit`; to any other address → `unshield` (+ recipient + protocol fee);
 *    none → `transfer-sent`.
 *
 * The broadcaster (relayer) fee inside a send is a non-owned output not recoverable here — H3 adds it
 * via sender-side decryption. `value` is the signed wallet delta for the token. USDC-scoped like the
 * rest of the SDK: aUSDC legs of yield ops aren't tracked, so a withdrawal is seen via its USDC return.
 */
export function reconstructHistory(input: ReconstructHistoryInput): HistoryEntry[] {
  const { ownedTxos, spentNullifiers, unshields, nullifyingKey, usdcHash, usdcAddress } = input;
  const yieldAdapter = input.yieldAdapterAddress?.toLowerCase();
  const isUsdc = (tokenHash: string): boolean => tokenHash === usdcHash;

  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));
  const unshieldsByTxid = new Map<string, DecodedUnshield[]>();
  for (const u of unshields) {
    const list = unshieldsByTxid.get(u.txid);
    if (list === undefined) unshieldsByTxid.set(u.txid, [u]);
    else list.push(u);
  }

  // Which owned notes we spent, and in which txid.
  const spendTxidOf = new Map<TXO, string>();
  for (const txo of ownedTxos) {
    const spend = spendByKey.get(nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position)));
    if (spend !== undefined) spendTxidOf.set(txo, spend.txid);
  }
  const ownSpendTxids = new Set(spendTxidOf.values());

  // Per-txid USDC aggregation.
  interface Agg {
    blockNumber: number;
    inputs: bigint;
    change: bigint;
    receives: TXO[];
  }
  const byTxid = new Map<string, Agg>();
  const agg = (txid: string, blockNumber: number): Agg => {
    let a = byTxid.get(txid);
    if (a === undefined) {
      a = { blockNumber, inputs: 0n, change: 0n, receives: [] };
      byTxid.set(txid, a);
    } else {
      a.blockNumber = Math.min(a.blockNumber, blockNumber);
    }
    return a;
  };
  for (const txo of ownedTxos) {
    if (!isUsdc(txo.tokenHash)) continue;
    const spentIn = spendTxidOf.get(txo);
    if (spentIn !== undefined) agg(spentIn, txo.blockNumber).inputs += txo.value;
    if (ownSpendTxids.has(txo.txid) && txo.origin === 'transact') {
      agg(txo.txid, txo.blockNumber).change += txo.value;
    } else {
      agg(txo.txid, txo.blockNumber).receives.push(txo);
    }
  }

  const entries: HistoryEntry[] = [];
  for (const [txid, a] of byTxid) {
    const txUnshields = unshieldsByTxid.get(txid) ?? [];
    const toAdapter = yieldAdapter !== undefined && txUnshields.some((u) => u.to.toLowerCase() === yieldAdapter);
    const external = txUnshields.filter((u) => yieldAdapter === undefined || u.to.toLowerCase() !== yieldAdapter);

    if (ownSpendTxids.has(txid)) {
      const net = a.change - a.inputs; // negative: shielded balance decreased
      if (toAdapter) {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'yield-deposit', tokenAddress: usdcAddress, value: net });
      } else if (external.length > 0) {
        const u = external[0]!;
        entries.push({
          txid,
          blockNumber: a.blockNumber,
          category: 'unshield',
          tokenAddress: usdcAddress,
          value: net,
          unshieldFee: u.fee,
          recipient: u.to,
        });
      } else {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'transfer-sent', tokenAddress: usdcAddress, value: net });
      }
      continue;
    }

    // Receive side: yield-withdraw if the tx also carries the adapter Unshield (the USDC return leg).
    if (toAdapter && a.receives.length > 0) {
      const sum = a.receives.reduce((acc, r) => acc + r.value, 0n);
      entries.push({ txid, blockNumber: a.blockNumber, category: 'yield-withdraw', tokenAddress: usdcAddress, value: sum });
      continue;
    }
    for (const r of a.receives) {
      entries.push({
        txid,
        blockNumber: r.blockNumber,
        category: r.origin === 'shield' ? 'shield' : 'transfer-received',
        tokenAddress: usdcAddress,
        value: r.value,
        ...(r.shieldFee !== undefined ? { shieldFee: r.shieldFee } : {}),
        ...(r.memo !== undefined ? { memo: r.memo } : {}),
        ...(r.senderRailgunAddress !== undefined ? { senderRailgunAddress: r.senderRailgunAddress } : {}),
      });
    }
  }
  return entries.sort(sortEntries);
}
