// ABOUTME: WalletNotes (F1, #143) — the private half of a wallet's scan: its owned notes, the nullifiers and unshields
// ABOUTME: of its own spends, notes it authored, and gasless relayer fees. Persisted encrypted, with a format version.

import { TransactNote } from '../core/index';
import type { TXO, SpentNullifier, NoteOrigin } from './balances';
import type { DecodedNullifier, DecodedUnshield } from './event-decoder';
import type { SentOutput } from './scan-engine';

/** The persisted format of `WalletNotesSnapshot`; a stored record of another version is a cache miss (rescan). */
export const WALLET_NOTES_VERSION = 1;

/** JSON-serializable snapshot of a wallet's notes (bigints as decimal strings) for persistence. */
export interface WalletNotesSnapshot {
  readonly txos: ReadonlyArray<{
    readonly tree: number;
    readonly position: number;
    readonly tokenHash: string;
    readonly value: string;
    readonly blockNumber: number;
    readonly txid: string;
    readonly origin: NoteOrigin;
    readonly memo?: string;
    readonly senderShieldedAddress?: string;
    readonly shieldFee?: string;
    readonly random: string;
    readonly notePublicKey: string;
  }>;
  readonly spent: ReadonlyArray<{
    readonly tree: number;
    readonly nullifier: string;
    readonly txid: string;
    readonly blockNumber: number;
  }>;
  readonly unshields: ReadonlyArray<{
    readonly to: string;
    readonly tokenData: { readonly tokenType: number; readonly tokenAddress: string; readonly tokenSubID: string };
    readonly amount: string;
    readonly fee: string;
    readonly blockNumber: number;
    readonly txid: string;
  }>;
  readonly sent: ReadonlyArray<{
    readonly txid: string;
    readonly blockNumber: number;
    readonly tokenHash: string;
    readonly value: string;
    readonly recipientShieldedAddress: string;
    readonly outputType: number;
    readonly memo?: string;
  }>;
  /**
   * Per-txid relayer fee (GROSS — the relayer note's value + its own protocol shield fee, i.e. what the
   * user paid the relayer) for gasless shields we co-authored (issue #88). Optional so snapshots written
   * before this field restore cleanly (treated as none). `[txid, feeString]` pairs.
   */
  readonly shieldRelayerFees?: ReadonlyArray<readonly [string, string]>;
}

// Tree-scoped nullifier key — the shared identity for spent/pending/spendable matching. Tree scope is
// load-bearing: the same position in two trees yields the same nullifier value (Railgun 9.5.4).
export function nullifierKey(tree: number, nullifier: bigint): string {
  return `${tree}:${nullifier.toString()}`;
}

export class WalletNotes {
  private readonly txos: TXO[] = [];
  private readonly spent: SpentNullifier[] = [];
  private readonly unshields: DecodedUnshield[] = [];
  private readonly sent: SentOutput[] = [];
  // Relayer fee paid in a gasless shield WE co-authored, per txid (issue #88 lever 2) — the value of the
  // fee note (a shield commitment to the relayer) that rides in the same Shield event as our own note.
  private readonly shieldRelayerFeeByTxid = new Map<string, bigint>();
  // The nullifier keys of our own notes — how a spend event is recognized as ours. Built on first use (it needs the
  // nullifying key, which a restored snapshot doesn't carry) and kept up to date as notes arrive.
  private ownNullifierKeys: Set<string> | undefined;
  private ownNullifyingKey: bigint | undefined;

  addOwned(txo: TXO): void {
    this.txos.push(txo);
    if (this.ownNullifierKeys !== undefined && this.ownNullifyingKey !== undefined) {
      this.ownNullifierKeys.add(nullifierKey(txo.tree, TransactNote.getNullifier(this.ownNullifyingKey, txo.position)));
    }
  }

  addSent(output: SentOutput): void {
    this.sent.push(output);
  }

  setShieldRelayerFee(txid: string, fee: bigint): void {
    this.shieldRelayerFeeByTxid.set(txid, fee);
  }

  /**
   * Record the spends in one event batch that are ours: the nullifiers of our own notes, and the unshields of the
   * transactions they're in. Everything else is someone else's and is dropped. A transaction's nullifiers and
   * unshields are always in the same batch (one block), so the match is exact. Returns our nullifiers.
   */
  recordSpends(
    nullifiers: readonly DecodedNullifier[],
    unshields: readonly DecodedUnshield[],
    nullifyingKey: bigint,
  ): SpentNullifier[] {
    const ownKeys = this.ownKeys(nullifyingKey);
    const ours: SpentNullifier[] = nullifiers
      .filter((n) => ownKeys.has(nullifierKey(n.tree, n.nullifier)))
      .map((n) => ({ tree: n.tree, nullifier: n.nullifier, txid: n.txid, blockNumber: n.blockNumber }));
    this.spent.push(...ours);
    const ourTxids = new Set(ours.map((n) => n.txid));
    this.unshields.push(...unshields.filter((u) => ourTxids.has(u.txid)));
    return ours;
  }

  private ownKeys(nullifyingKey: bigint): Set<string> {
    if (this.ownNullifierKeys === undefined || this.ownNullifyingKey !== nullifyingKey) {
      this.ownNullifyingKey = nullifyingKey;
      this.ownNullifierKeys = new Set(
        this.txos.map((t) => nullifierKey(t.tree, TransactNote.getNullifier(nullifyingKey, t.position))),
      );
    }
    return this.ownNullifierKeys;
  }

  /** All owned notes ever received (spent or not). */
  ownedTxos(): readonly TXO[] {
    return this.txos;
  }

  /** The spends of our own notes (with txid/block). */
  spentNullifiers(): readonly SpentNullifier[] {
    return this.spent;
  }

  /** The public withdrawals in transactions we spent in. */
  unshieldEvents(): readonly DecodedUnshield[] {
    return this.unshields;
  }

  /** Notes the wallet authored (recovered sender-side). */
  sentOutputs(): readonly SentOutput[] {
    return this.sent;
  }

  /** Per-txid relayer fee paid in a gasless shield we co-authored (issue #88). */
  shieldRelayerFees(): ReadonlyMap<string, bigint> {
    return this.shieldRelayerFeeByTxid;
  }

  clone(): WalletNotes {
    const copy = new WalletNotes();
    copy.txos.push(...this.txos);
    copy.spent.push(...this.spent);
    copy.unshields.push(...this.unshields);
    copy.sent.push(...this.sent);
    for (const [txid, fee] of this.shieldRelayerFeeByTxid) copy.shieldRelayerFeeByTxid.set(txid, fee);
    if (this.ownNullifierKeys !== undefined) copy.ownNullifierKeys = new Set(this.ownNullifierKeys);
    copy.ownNullifyingKey = this.ownNullifyingKey;
    return copy;
  }

  snapshot(): WalletNotesSnapshot {
    return {
      txos: this.txos.map((t) => ({
        tree: t.tree,
        position: t.position,
        tokenHash: t.tokenHash,
        value: t.value.toString(),
        blockNumber: t.blockNumber,
        txid: t.txid,
        origin: t.origin,
        ...(t.memo !== undefined ? { memo: t.memo } : {}),
        ...(t.senderShieldedAddress !== undefined ? { senderShieldedAddress: t.senderShieldedAddress } : {}),
        ...(t.shieldFee !== undefined ? { shieldFee: t.shieldFee.toString() } : {}),
        random: t.random,
        notePublicKey: t.notePublicKey.toString(),
      })),
      spent: this.spent.map((s) => ({
        tree: s.tree,
        nullifier: s.nullifier.toString(),
        txid: s.txid,
        blockNumber: s.blockNumber,
      })),
      unshields: this.unshields.map((u) => ({
        to: u.to,
        tokenData: { ...u.tokenData },
        amount: u.amount.toString(),
        fee: u.fee.toString(),
        blockNumber: u.blockNumber,
        txid: u.txid,
      })),
      sent: this.sent.map((s) => ({
        txid: s.txid,
        blockNumber: s.blockNumber,
        tokenHash: s.tokenHash,
        value: s.value.toString(),
        recipientShieldedAddress: s.recipientShieldedAddress,
        outputType: s.outputType,
        ...(s.memo !== undefined ? { memo: s.memo } : {}),
      })),
      shieldRelayerFees: [...this.shieldRelayerFeeByTxid.entries()].map(([txid, fee]) => [txid, fee.toString()]),
    };
  }

  static restore(snapshot: WalletNotesSnapshot): WalletNotes {
    const notes = new WalletNotes();
    for (const t of snapshot.txos) {
      notes.txos.push({
        tree: t.tree,
        position: t.position,
        tokenHash: t.tokenHash,
        value: BigInt(t.value),
        blockNumber: t.blockNumber,
        txid: t.txid,
        origin: t.origin,
        ...(t.memo !== undefined ? { memo: t.memo } : {}),
        ...(t.senderShieldedAddress !== undefined ? { senderShieldedAddress: t.senderShieldedAddress } : {}),
        ...(t.shieldFee !== undefined ? { shieldFee: BigInt(t.shieldFee) } : {}),
        random: t.random,
        notePublicKey: BigInt(t.notePublicKey),
      });
    }
    for (const s of snapshot.spent) {
      notes.spent.push({ tree: s.tree, nullifier: BigInt(s.nullifier), txid: s.txid, blockNumber: s.blockNumber });
    }
    for (const u of snapshot.unshields) {
      notes.unshields.push({
        to: u.to,
        tokenData: { ...u.tokenData },
        amount: BigInt(u.amount),
        fee: BigInt(u.fee),
        blockNumber: u.blockNumber,
        txid: u.txid,
      });
    }
    for (const s of snapshot.sent) {
      notes.sent.push({
        txid: s.txid,
        blockNumber: s.blockNumber,
        tokenHash: s.tokenHash,
        value: BigInt(s.value),
        recipientShieldedAddress: s.recipientShieldedAddress,
        outputType: s.outputType,
        ...(s.memo !== undefined ? { memo: s.memo } : {}),
      });
    }
    // `shieldRelayerFees` is optional — pre-lever-2 snapshots restore as none (issue #88).
    for (const [txid, fee] of snapshot.shieldRelayerFees ?? []) {
      notes.shieldRelayerFeeByTxid.set(txid, BigInt(fee));
    }
    return notes;
  }
}
