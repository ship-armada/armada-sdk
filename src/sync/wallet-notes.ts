// ABOUTME: WalletNotes (F1, #143) — the private half of a wallet's scan: its owned notes, the nullifiers and unshields
// ABOUTME: of its own spends, notes it authored, and gasless relayer fees. Persisted encrypted, with a format version.

import { TransactNote } from '../core/index';
import type { TXO, SpentNullifier, NoteOrigin } from './balances';
import type {
  DecodedNullifier,
  DecodedPoolEvents,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedUnshield,
} from './event-decoder';
import type { ApplyResult, SentOutput, WalletDecryptors } from './scan-engine';

/**
 * The persisted format of `WalletNotesSnapshot`; a stored record of another version is a cache miss (rescan).
 * 2: block timestamps (#135).
 */
export const WALLET_NOTES_VERSION = 2;

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
  /** `[block, timestamp]` for the blocks of the wallet's own entries (#135). Optional: absent means none known. */
  readonly blockTimestamps?: ReadonlyArray<readonly [number, number]>;
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
  // The timestamp of each block holding one of our entries, recorded during sync so history() needs no RPC (#135).
  private readonly blockTimes = new Map<number, number>();
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

  /**
   * Fold a decoded event batch into the wallet's notes: commitments the wallet owns become TXOs (via `decryptors`),
   * notes it authored are recovered sender-side, and its own spends are recorded. Batches MUST arrive in scan order.
   * The trees are not touched (see `TreeStore.applyLeaves`). Returns the owned TXOs + the wallet's own nullifiers newly
   * seen in this batch.
   */
  async apply(events: DecodedPoolEvents, decryptors: WalletDecryptors): Promise<ApplyResult> {
    // Unify shield + transact commitments into a single position-ordered stream.
    type Leaf =
      | { readonly kind: 'shield'; readonly c: DecodedShieldCommitment }
      | { readonly kind: 'transact'; readonly c: DecodedTransactCommitment };
    const leaves: Leaf[] = [
      ...events.shields.map((c): Leaf => ({ kind: 'shield', c })),
      ...events.transacts.map((c): Leaf => ({ kind: 'transact', c })),
    ].sort((a, b) => a.c.tree - b.c.tree || a.c.position - b.c.position);

    // Per-txid shield GROSS totals (issue #88 lever 2). A gasless shield emits both the user's note AND
    // the relayer's fee note in one Shield event/txid, each with a PLAINTEXT value AND a plaintext
    // protocol shield fee (the `fees[]` array). The relayer fee (a note we don't own) is recoverable as
    // (total shield GROSS in the txid) − (our owned shield GROSS), with no decryption of the relayer's
    // note — `gross = commitment value + its shield fee`. Accumulated here, reconciled after the loop.
    const shieldTotalByTxid = new Map<string, bigint>();
    const shieldOwnedByTxid = new Map<string, bigint>();

    const ownedTxos: TXO[] = [];
    for (const leaf of leaves) {
      const { tree, position, blockNumber, txid } = leaf.c;

      if (leaf.kind === 'shield') {
        // Accumulate the GROSS shield value per commitment (net committed value + its protocol shield
        // fee, both plaintext in the Shield event). Summing gross — not just the net commitment value —
        // makes the relayer fee derived below the amount the user actually PAID the relayer (its note +
        // the shield fee taken from it), so a recovered gasless shield reconstructs the full deposit.
        shieldTotalByTxid.set(txid, (shieldTotalByTxid.get(txid) ?? 0n) + leaf.c.value + (leaf.c.fee ?? 0n));
      }

      const owned =
        leaf.kind === 'transact'
          ? await decryptors.transact(leaf.c)
          : await decryptors.shield?.(leaf.c);
      if (owned !== undefined) {
        if (leaf.kind === 'shield') {
          // Our own shield gross (net note + its shield fee) — subtracted from the txid gross total
          // below so what remains is the relayer fee note's GROSS.
          shieldOwnedByTxid.set(txid, (shieldOwnedByTxid.get(txid) ?? 0n) + owned.value + (leaf.c.fee ?? 0n));
        }
        const shieldFee = leaf.kind === 'shield' ? leaf.c.fee : undefined;
        const txo: TXO = {
          tree,
          position,
          tokenHash: owned.tokenHash,
          value: owned.value,
          blockNumber,
          txid,
          origin: leaf.kind,
          ...(owned.memo !== undefined ? { memo: owned.memo } : {}),
          ...(owned.senderShieldedAddress !== undefined
            ? { senderShieldedAddress: owned.senderShieldedAddress }
            : {}),
          ...(shieldFee !== undefined ? { shieldFee } : {}),
          random: owned.random,
          notePublicKey: owned.notePublicKey,
        };
        this.addOwned(txo);
        ownedTxos.push(txo);
      }

      // Sender-side: a note WE authored (transfer/fee output) — recovered for send history. Change
      // is filtered by the decryptor (it's already handled receive-side as an owned TXO above).
      if (leaf.kind === 'transact' && decryptors.sentTransact !== undefined) {
        const sent = await decryptors.sentTransact(leaf.c);
        if (sent !== undefined) this.addSent(sent);
      }
    }

    // Record the relayer fee for shields WE co-authored (issue #88 lever 2): for each txid where we own
    // a shield note, the remaining (non-owned) shield GROSS is the relayer's fee note — its net value
    // plus its own protocol shield fee, i.e. what the user actually paid the relayer. A shield tx is
    // per-user, so a txid's commitments are our note(s) + the fee note only. Zero for a non-gasless shield.
    for (const [txid, ownedGross] of shieldOwnedByTxid) {
      const relayerGross = (shieldTotalByTxid.get(txid) ?? ownedGross) - ownedGross;
      if (relayerGross > 0n) this.setShieldRelayerFee(txid, relayerGross);
    }

    // Only our own spends are kept: the nullifiers of our notes, and the unshields in those transactions (history
    // matches them to our spend txids). Every other pool nullifier and unshield is someone else's (SYNC-9).
    const nullifiers = this.recordSpends(events.nullifiers, events.unshields, decryptors.nullifyingKey);

    return { ownedTxos, nullifiers };
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

  /**
   * Keep the timestamps, from `times` (every pool-event block in a batch), of the blocks holding our entries. Called
   * after `apply` with the same batch.
   */
  recordBlockTimestamps(times: ReadonlyMap<number, number>): void {
    for (const entry of [...this.txos, ...this.spent, ...this.unshields, ...this.sent]) {
      if (this.blockTimes.has(entry.blockNumber)) continue;
      const time = times.get(entry.blockNumber);
      if (time !== undefined) this.blockTimes.set(entry.blockNumber, time);
    }
  }

  /** The timestamp of `block`, if it holds one of our entries and sync recorded it. */
  blockTimestamp(block: number): number | undefined {
    return this.blockTimes.get(block);
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
    for (const [block, time] of this.blockTimes) copy.blockTimes.set(block, time);
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
      blockTimestamps: [...this.blockTimes.entries()],
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
    for (const [block, time] of snapshot.blockTimestamps ?? []) notes.blockTimes.set(block, time);
    return notes;
  }
}
