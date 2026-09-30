// ABOUTME: Wallet scan orchestrator (SPEC §4.4) — folds decoded pool events into per-tree merkletrees,
// ABOUTME: detects owned TXOs via injected decryptors, records nullifiers, verifies roots, projects balances.

import { TransactNote, encodeAddress } from '../core/index';
import { UTXOMerkletree, type MerkleProof } from './merkletree';
import {
  computeBalances,
  type TXO,
  type SpentNullifier,
  type PendingSpend,
  type TokenBalance,
  type BalanceOptions,
  type NoteOrigin,
} from './balances';
import type {
  DecodedPoolEvents,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedUnshield,
} from './event-decoder';
import { RootMismatchError, PositionGapError } from '../errors';

/** The wallet-relevant fields a decryptor recovers from a commitment it owns. */
export interface OwnedNote {
  readonly tokenHash: string;
  readonly value: bigint;
  /** 16-byte note random (hex, no 0x) — carried into the TXO so the spend witness can be rebuilt. */
  readonly random: string;
  /** Note public key `poseidon(masterPublicKey, random)`. */
  readonly notePublicKey: bigint;
  /** Memo the sender attached, if any (transfer receives). */
  readonly memo?: string;
  /** Sender's 0zk, present only if they disclosed it (`showSenderAddressToRecipient`). */
  readonly senderShieldedAddress?: string;
}

/** An output the wallet AUTHORED (recovered sender-side) — a transfer, broadcaster fee, or change. */
export interface SentOutput {
  readonly txid: string;
  readonly blockNumber: number;
  readonly tokenHash: string;
  readonly value: bigint;
  readonly recipientShieldedAddress: string;
  /** OutputType: 0 Transfer, 1 BroadcasterFee, 2 Change. */
  readonly outputType: number;
  readonly memo?: string;
}

/** Returns the owned note if the commitment belongs to the wallet, else `undefined`. */
export type Decryptor<C> = (commitment: C) => Promise<OwnedNote | undefined>;

/** Map a decrypted transact note to an `OwnedNote` — the transact-decryptor's note→result adapter. */
export function ownedNoteFromTransactNote(note: TransactNote): OwnedNote {
  return {
    tokenHash: note.tokenHash,
    value: note.value,
    random: note.random,
    notePublicKey: note.notePublicKey,
    ...(note.memoText !== undefined && note.memoText !== '' ? { memo: note.memoText } : {}),
    ...(note.senderAddressData !== undefined
      ? { senderShieldedAddress: encodeAddress(note.senderAddressData) }
      : {}),
  };
}

/**
 * Per-commitment-type decryptors. `transact` wraps `tryDecryptCommitment`; `shield` (optional) is the
 * seam for shield-note ownership (ShieldNote ECDH via shieldKey) — omit it and shield leaves still
 * build the tree, they just don't contribute TXOs yet.
 */
export interface WalletDecryptors {
  readonly transact: Decryptor<DecodedTransactCommitment>;
  readonly shield?: Decryptor<DecodedShieldCommitment>;
  /** Sender-side recovery of notes the wallet AUTHORED (transfer/fee outputs), for send history. */
  readonly sentTransact?: (c: DecodedTransactCommitment) => Promise<SentOutput | undefined>;
}

/** The wallet-owned deltas produced by applying one event batch (for `note:received`/`balance:updated`). */
export interface ApplyResult {
  readonly ownedTxos: TXO[];
  readonly nullifiers: SpentNullifier[];
}

/** JSON-serializable snapshot of a `WalletScanState` (bigints as decimal strings) for persistence. */
export interface ScanStateSnapshot {
  readonly trees: ReadonlyArray<{ readonly tree: number; readonly leaves: readonly string[] }>;
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

// Compare two commitment roots regardless of 0x-prefix / leading-zero padding.
function sameRoot(a: string, b: string): boolean {
  const norm = (h: string): bigint => BigInt(h.startsWith('0x') ? h : `0x${h}`);
  return norm(a) === norm(b);
}

// Tree-scoped nullifier key — the shared identity for spent/pending/spendable matching. Tree scope is
// load-bearing: the same position in two trees yields the same nullifier value (Railgun 9.5.4).
function nullifierKey(tree: number, nullifier: bigint): string {
  return `${tree}:${nullifier.toString()}`;
}

/**
 * Accumulates wallet state across incremental scan batches. Leaves from ALL commitment types are
 * inserted into per-`treeNumber` merkletrees in `(tree, position)` order (append-only, position-gap
 * checked); commitments the wallet owns become TXOs; nullifiers are recorded tree-scoped. Balances are
 * a pure projection over the accumulated TXO/nullifier sets.
 */
export class WalletScanState {
  private readonly trees = new Map<number, UTXOMerkletree>();
  private readonly nextPosition = new Map<number, number>();
  private readonly txos: TXO[] = [];
  private readonly spent: SpentNullifier[] = [];
  private readonly unshields: DecodedUnshield[] = [];
  private readonly sent: SentOutput[] = [];
  // Relayer fee paid in a gasless shield WE co-authored, per txid (issue #88 lever 2) — the value of the
  // fee note (a shield commitment to the relayer) that rides in the same Shield event as our own note.
  private readonly shieldRelayerFeeByTxid = new Map<string, bigint>();

  /**
   * Fold a decoded event batch into wallet state. Batches MUST arrive in scan order (ascending
   * block/position) — the append-only merkletree requires each leaf's position to equal the tree's
   * current length. Returns the owned TXOs + nullifiers newly seen in this batch.
   */
  async apply(events: DecodedPoolEvents, decryptors: WalletDecryptors): Promise<ApplyResult> {
    // Unify shield + transact commitments into a single position-ordered leaf stream for tree building.
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
      const { tree, position, hash, blockNumber, txid } = leaf.c;
      this.insertLeaf(tree, position, hash);

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
        this.txos.push(txo);
        ownedTxos.push(txo);
      }

      // Sender-side: a note WE authored (transfer/fee output) — recovered for send history. Change
      // is filtered by the decryptor (it's already handled receive-side as an owned TXO above).
      if (leaf.kind === 'transact' && decryptors.sentTransact !== undefined) {
        const sent = await decryptors.sentTransact(leaf.c);
        if (sent !== undefined) this.sent.push(sent);
      }
    }

    // Record the relayer fee for shields WE co-authored (issue #88 lever 2): for each txid where we own
    // a shield note, the remaining (non-owned) shield GROSS is the relayer's fee note — its net value
    // plus its own protocol shield fee, i.e. what the user actually paid the relayer. A shield tx is
    // per-user, so a txid's commitments are our note(s) + the fee note only. Zero for a non-gasless shield.
    for (const [txid, ownedGross] of shieldOwnedByTxid) {
      const relayerGross = (shieldTotalByTxid.get(txid) ?? ownedGross) - ownedGross;
      if (relayerGross > 0n) this.shieldRelayerFeeByTxid.set(txid, relayerGross);
    }

    const nullifiers: SpentNullifier[] = events.nullifiers.map((n) => ({
      tree: n.tree,
      nullifier: n.nullifier,
      txid: n.txid,
      blockNumber: n.blockNumber,
    }));
    this.spent.push(...nullifiers);

    // Unshields are public (not commitments) — recorded globally like nullifiers; history matches
    // them to the wallet's own spend txids. (Pruning to our txids is a possible future optimization.)
    this.unshields.push(...events.unshields);

    return { ownedTxos, nullifiers };
  }

  private insertLeaf(tree: number, position: number, hash: string): void {
    let merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      merkletree = new UTXOMerkletree();
      this.trees.set(tree, merkletree);
      this.nextPosition.set(tree, 0);
    }
    const expected = this.nextPosition.get(tree)!;
    if (position !== expected) {
      throw new PositionGapError(`scan: merkle position gap in tree ${tree}: expected ${expected}, got ${position}`, {
        expected,
        received: position,
      });
    }
    merkletree.insert(hash);
    this.nextPosition.set(tree, expected + 1);
  }

  /** Current commitment root of `tree` (no-0x hex); the empty-tree root if unseen. */
  treeRoot(tree: number): string {
    const merkletree = this.trees.get(tree);
    return (merkletree ?? new UTXOMerkletree()).root();
  }

  /** Tree numbers with at least one inserted leaf, ascending. */
  treeNumbers(): number[] {
    return [...this.trees.keys()].sort((a, b) => a - b);
  }

  /** All owned notes ever received (spent or not) — the receive side of history reconstruction. */
  ownedTxos(): readonly TXO[] {
    return this.txos;
  }

  /** All spent-note markers seen (with txid/block) — the spend side of history reconstruction. */
  spentNullifiers(): readonly SpentNullifier[] {
    return this.spent;
  }

  /** All public withdrawals seen — matched to the wallet's own spend txids for unshield/yield history. */
  unshieldEvents(): readonly DecodedUnshield[] {
    return this.unshields;
  }

  /** Notes the wallet authored (recovered sender-side) — the recipient/fee detail of its own sends. */
  sentOutputs(): readonly SentOutput[] {
    return this.sent;
  }

  /** Per-txid relayer fee paid in a gasless shield we co-authored (issue #88) — feeds history recovery. */
  shieldRelayerFees(): ReadonlyMap<string, bigint> {
    return this.shieldRelayerFeeByTxid;
  }

  /**
   * Verify each tree's locally-built root against the on-chain root (0x-prefixed or bare). Throws a
   * typed `RootMismatchError` (code `ROOT_MISMATCH`) carrying tree context on the first mismatch.
   */
  verifyRoots(expectedRoots: ReadonlyMap<number, string>): void {
    for (const [tree, expected] of expectedRoots) {
      const actual = this.treeRoot(tree);
      if (!sameRoot(actual, expected)) {
        throw new RootMismatchError(`tree ${tree}: expected root ${expected}, built ${actual}`);
      }
    }
  }

  /**
   * Per-token spendable/pending/pendingSpent over all accumulated TXOs + spent nullifiers, with `holds`
   * (optimistic in-flight spends, issue #55) excluded from spendable.
   */
  balances(nullifyingKey: bigint, options: BalanceOptions, holds: readonly PendingSpend[] = []): TokenBalance[] {
    return computeBalances(this.txos, this.spent, nullifyingKey, options, holds);
  }

  get txoCount(): number {
    return this.txos.length;
  }

  /** Number of leaves inserted into `tree`. */
  treeLength(tree: number): number {
    return this.trees.get(tree)?.length ?? 0;
  }

  /** Merkle proof for a note at `(tree, position)` — the spend witness's `pathElements`/`leavesIndices`. */
  merkleProof(tree: number, position: number): MerkleProof {
    const merkletree = this.trees.get(tree);
    if (merkletree === undefined) {
      throw new Error(`merkleProof: unknown tree ${tree}`);
    }
    return merkletree.merkleProof(position);
  }

  /**
   * Unspent owned TXOs (tree-scoped nullifier–filtered), ready to hand to `planTransfer`. Excludes any
   * note whose `(tree, getNullifier(nullifyingKey, position))` appears in the recorded spent set OR in
   * `holds`, the optimistic in-flight spends (issue #55) — so a note with a submitted-but-unconfirmed
   * spend is not reselected before its `Nullified` event is scanned.
   */
  spendableTxos(nullifyingKey: bigint, holds: readonly PendingSpend[] = []): TXO[] {
    const spentSet = new Set(this.spent.map((s) => nullifierKey(s.tree, s.nullifier)));
    const pendingSet = new Set(holds.map((p) => nullifierKey(p.tree, p.nullifier)));
    return this.txos.filter((t) => {
      const key = nullifierKey(t.tree, TransactNote.getNullifier(nullifyingKey, t.position));
      return !spentSet.has(key) && !pendingSet.has(key);
    });
  }

  /**
   * An independent copy of this state. A sync applies its batch to a copy and replaces the live state
   * only once the copy is verified and saved, so readers never see a half-applied batch and a failed
   * sync simply discards its copy. Tree hashing is lazy, so this is array copies, not re-hashing.
   */
  clone(): WalletScanState {
    const copy = new WalletScanState();
    for (const [tree, merkletree] of this.trees) {
      const t = new UTXOMerkletree();
      t.insertMany(merkletree.getLeaves());
      copy.trees.set(tree, t);
    }
    for (const [tree, next] of this.nextPosition) copy.nextPosition.set(tree, next);
    copy.txos.push(...this.txos);
    copy.spent.push(...this.spent);
    copy.unshields.push(...this.unshields);
    copy.sent.push(...this.sent);
    for (const [txid, fee] of this.shieldRelayerFeeByTxid) copy.shieldRelayerFeeByTxid.set(txid, fee);
    return copy;
  }

  /** JSON-serializable snapshot of the accumulated tree/TXO/nullifier state, for persistence. */
  snapshot(): ScanStateSnapshot {
    return {
      trees: [...this.trees.entries()].map(([tree, merkletree]) => ({ tree, leaves: [...merkletree.getLeaves()] })),
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

  /** Rebuild a `WalletScanState` from a snapshot — trees are re-derived from their leaves. */
  static restore(snapshot: ScanStateSnapshot): WalletScanState {
    const state = new WalletScanState();
    for (const { tree, leaves } of snapshot.trees) {
      const merkletree = new UTXOMerkletree();
      merkletree.insertMany(leaves);
      state.trees.set(tree, merkletree);
      state.nextPosition.set(tree, leaves.length);
    }
    for (const t of snapshot.txos) {
      state.txos.push({
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
      state.spent.push({ tree: s.tree, nullifier: BigInt(s.nullifier), txid: s.txid, blockNumber: s.blockNumber });
    }
    for (const u of snapshot.unshields) {
      state.unshields.push({
        to: u.to,
        tokenData: { ...u.tokenData },
        amount: BigInt(u.amount),
        fee: BigInt(u.fee),
        blockNumber: u.blockNumber,
        txid: u.txid,
      });
    }
    for (const s of snapshot.sent) {
      state.sent.push({
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
      state.shieldRelayerFeeByTxid.set(txid, BigInt(fee));
    }
    return state;
  }
}
