// ABOUTME: Native tx-history reconstruction (SPEC §5) — derives HistoryEntry[] from the wallet's own
// ABOUTME: scan state (owned notes + spent nullifiers), NOT a port of Railgun's getWalletTransactionHistory.

import { TransactNote, OutputType } from '../core/index';
import type { TXO, SpentNullifier } from './balances';
import type { DecodedUnshield } from './event-decoder';
import type { SentOutput } from './scan-engine';

/** A recipient output of one of the wallet's own sends (recovered sender-side). */
export interface SentRecipient {
  readonly recipientShieldedAddress: string;
  readonly value: bigint;
  readonly memo?: string;
}

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
  readonly senderShieldedAddress?: string;
  /** Recipient outputs of a send (transfer-sent), recovered sender-side — recipient 0zk + amount + memo. */
  readonly sentOutputs?: readonly SentRecipient[];
  readonly memo?: string;
  /** Unix seconds — attached by `wallet.history()` from the block; absent in the pure reconstruction. */
  readonly timestamp?: number;
}

/** Resolve a 32-byte token hash to its address; return undefined to skip notes in unknown tokens. */
export type TokenAddressResolver = (tokenHash: string) => `0x${string}` | undefined;

const nullifierKey = (tree: number, nullifier: bigint): string => `${tree}:${nullifier.toString()}`;

const sortEntries = (a: HistoryEntry, b: HistoryEntry): number =>
  a.blockNumber - b.blockNumber || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);

/** The wallet's unique note id — stable across syncs (a leaf never moves once inserted). */
const noteId = (txo: TXO): string => `${txo.tree}:${txo.position}`;

/**
 * Txids in which THIS wallet spent an input — its transact-origin outputs there are its own change,
 * not incoming transfers. Requires the nullifying key (a view-only wallet has it). Shared by the
 * receive reconstruction and the incremental `newReceivedNotes` detector so they never diverge.
 */
export function ownSpendTxids(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
): Set<string> {
  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));
  const txids = new Set<string>();
  for (const txo of ownedTxos) {
    const spend = spendByKey.get(nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position)));
    if (spend !== undefined) txids.add(spend.txid);
  }
  return txids;
}

/**
 * Incoming-transfer notes (transact-origin owned notes that aren't our own change, i.e. NOT shields
 * and NOT change from our own spends) whose note id is not yet in `seen`. ADDS the returned notes' ids
 * to `seen` — so a caller drives incremental `note:received` emission: seed a baseline on the first
 * call (ignore the return), then emit the delta each subsequent call.
 */
export function newReceivedNotes(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
  seen: Set<string>,
): TXO[] {
  const ownSpends = ownSpendTxids(ownedTxos, spentNullifiers, nullifyingKey);
  const fresh: TXO[] = [];
  for (const txo of ownedTxos) {
    if (txo.origin === 'shield' || ownSpends.has(txo.txid)) continue;
    const id = noteId(txo);
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(txo);
  }
  return fresh;
}

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
  const ownSpends = ownSpendTxids(ownedTxos, spentNullifiers, nullifyingKey);

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
    if (ownSpends.has(txo.txid)) continue;
    entries.push({
      txid: txo.txid,
      blockNumber: txo.blockNumber,
      category: 'transfer-received',
      tokenAddress,
      value: txo.value,
      ...(txo.memo !== undefined ? { memo: txo.memo } : {}),
      ...(txo.senderShieldedAddress !== undefined ? { senderShieldedAddress: txo.senderShieldedAddress } : {}),
    });
  }
  return entries.sort(sortEntries);
}

export interface ReconstructHistoryInput {
  readonly ownedTxos: readonly TXO[];
  readonly spentNullifiers: readonly SpentNullifier[];
  readonly unshields: readonly DecodedUnshield[];
  /** Notes the wallet authored (recovered sender-side) — recipient/fee detail of its own sends. */
  readonly sentOutputs: readonly SentOutput[];
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
  const { ownedTxos, spentNullifiers, unshields, sentOutputs, nullifyingKey, usdcHash, usdcAddress } = input;
  const yieldAdapter = input.yieldAdapterAddress?.toLowerCase();
  const isUsdc = (tokenHash: string): boolean => tokenHash === usdcHash;

  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));
  const unshieldsByTxid = new Map<string, DecodedUnshield[]>();
  for (const u of unshields) {
    const list = unshieldsByTxid.get(u.txid);
    if (list === undefined) unshieldsByTxid.set(u.txid, [u]);
    else list.push(u);
  }
  // Our authored outputs per txid (USDC only) — recipient transfers + broadcaster fee.
  const sentByTxid = new Map<string, SentOutput[]>();
  for (const s of sentOutputs) {
    if (!isUsdc(s.tokenHash)) continue;
    const list = sentByTxid.get(s.txid);
    if (list === undefined) sentByTxid.set(s.txid, [s]);
    else list.push(s);
  }

  // Which owned notes we spent, and in which spend. The whole Nullify marker is kept (not just its
  // txid) because the spend's own block — not the input note's origin block — dates the send entry.
  const spendOf = new Map<TXO, SpentNullifier>();
  for (const txo of ownedTxos) {
    const spend = spendByKey.get(nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position)));
    if (spend !== undefined) spendOf.set(txo, spend);
  }
  const ownSpendTxids = new Set([...spendOf.values()].map((s) => s.txid));

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
    const spentIn = spendOf.get(txo);
    if (spentIn !== undefined) agg(spentIn.txid, spentIn.blockNumber).inputs += txo.value;
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
      // Sender-side detail: split our authored outputs into recipient transfers vs the broadcaster fee.
      const outs = sentByTxid.get(txid) ?? [];
      const transfers = outs.filter((o) => (o.outputType ?? OutputType.Transfer) === OutputType.Transfer);
      const broadcasterFee = outs
        .filter((o) => o.outputType === OutputType.BroadcasterFee)
        .reduce((acc, o) => acc + o.value, 0n);
      const feeField = broadcasterFee > 0n ? { broadcasterFee } : {};
      const recipients: SentRecipient[] = transfers.map((o) => ({
        recipientShieldedAddress: o.recipientShieldedAddress,
        value: o.value,
        ...(o.memo !== undefined ? { memo: o.memo } : {}),
      }));
      const sentField = recipients.length > 0 ? { sentOutputs: recipients } : {};

      if (toAdapter) {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'yield-deposit', tokenAddress: usdcAddress, value: net, ...feeField });
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
          ...feeField,
        });
      } else {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'transfer-sent', tokenAddress: usdcAddress, value: net, ...feeField, ...sentField });
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
        ...(r.senderShieldedAddress !== undefined ? { senderShieldedAddress: r.senderShieldedAddress } : {}),
      });
    }
  }
  return entries.sort(sortEntries);
}
