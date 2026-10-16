// ABOUTME: Wallet scan orchestrator (SPEC §4.4) — folds decoded pool events into per-tree merkletrees (TreeStore) and
// ABOUTME: the wallet's notes (WalletNotes): owned TXOs via injected decryptors, its own spends; verifies roots, balances.

import { TransactNote, encodeAddress } from '../core/index';
import type { MerkleProof } from './merkletree';
import { TreeStore } from './tree-store';
import { WalletNotes, nullifierKey, type WalletNotesSnapshot } from './wallet-notes';
import {
  computeBalances,
  type TXO,
  type SpentNullifier,
  type PendingSpend,
  type TokenBalance,
  type BalanceOptions,
} from './balances';
import type {
  DecodedPoolEvents,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedUnshield,
} from './event-decoder';
import { RootMismatchError } from '../errors';

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
  /** The wallet's nullifying key — how its own spends are recognized among the pool's nullifiers. */
  readonly nullifyingKey: bigint;
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

/** JSON-serializable snapshot of a `WalletScanState` (bigints as decimal strings): its trees' leaves + its notes. */
export interface ScanStateSnapshot extends WalletNotesSnapshot {
  readonly trees: ReadonlyArray<{ readonly tree: number; readonly leaves: readonly string[] }>;
}

// Compare two commitment roots regardless of 0x-prefix / leading-zero padding.
function sameRoot(a: string, b: string): boolean {
  const norm = (h: string): bigint => BigInt(h.startsWith('0x') ? h : `0x${h}`);
  return norm(a) === norm(b);
}

/**
 * Accumulates wallet state across incremental scan batches: the chain-public trees (`TreeStore`) and the wallet's
 * private notes (`WalletNotes`). Leaves from ALL commitment types are inserted into per-`treeNumber` merkletrees in
 * `(tree, position)` order (append-only, position-gap checked); commitments the wallet owns become TXOs; the
 * wallet's own spends are recorded tree-scoped. Balances are a pure projection over the TXO/nullifier sets.
 */
export class WalletScanState {
  constructor(
    private readonly tree: TreeStore = new TreeStore(),
    private readonly notes: WalletNotes = new WalletNotes(),
  ) {}

  /**
   * Fold a decoded event batch into wallet state. Batches MUST arrive in scan order (ascending
   * block/position) — the append-only merkletree requires each leaf's position to equal the tree's
   * current length. Returns the owned TXOs + the wallet's own nullifiers newly seen in this batch.
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
      this.tree.insertLeaf(tree, position, hash);

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
        this.notes.addOwned(txo);
        ownedTxos.push(txo);
      }

      // Sender-side: a note WE authored (transfer/fee output) — recovered for send history. Change
      // is filtered by the decryptor (it's already handled receive-side as an owned TXO above).
      if (leaf.kind === 'transact' && decryptors.sentTransact !== undefined) {
        const sent = await decryptors.sentTransact(leaf.c);
        if (sent !== undefined) this.notes.addSent(sent);
      }
    }

    // Record the relayer fee for shields WE co-authored (issue #88 lever 2): for each txid where we own
    // a shield note, the remaining (non-owned) shield GROSS is the relayer's fee note — its net value
    // plus its own protocol shield fee, i.e. what the user actually paid the relayer. A shield tx is
    // per-user, so a txid's commitments are our note(s) + the fee note only. Zero for a non-gasless shield.
    for (const [txid, ownedGross] of shieldOwnedByTxid) {
      const relayerGross = (shieldTotalByTxid.get(txid) ?? ownedGross) - ownedGross;
      if (relayerGross > 0n) this.notes.setShieldRelayerFee(txid, relayerGross);
    }

    // Only our own spends are kept: the nullifiers of our notes, and the unshields in those transactions (history
    // matches them to our spend txids). Every other pool nullifier and unshield is someone else's (SYNC-9).
    const nullifiers = this.notes.recordSpends(events.nullifiers, events.unshields, decryptors.nullifyingKey);

    return { ownedTxos, nullifiers };
  }

  /** The chain-public trees. */
  get trees(): TreeStore {
    return this.tree;
  }

  /** The wallet's private notes. */
  get walletNotes(): WalletNotes {
    return this.notes;
  }

  /** Current commitment root of `tree` (no-0x hex); the empty-tree root if unseen. */
  treeRoot(tree: number): string {
    return this.tree.root(tree);
  }

  /** Tree numbers with at least one inserted leaf, ascending. */
  treeNumbers(): number[] {
    return this.tree.treeNumbers();
  }

  /** All owned notes ever received (spent or not) — the receive side of history reconstruction. */
  ownedTxos(): readonly TXO[] {
    return this.notes.ownedTxos();
  }

  /** The spends of the wallet's own notes (with txid/block) — the spend side of history reconstruction. */
  spentNullifiers(): readonly SpentNullifier[] {
    return this.notes.spentNullifiers();
  }

  /** The public withdrawals in transactions the wallet spent in — for unshield/yield history. */
  unshieldEvents(): readonly DecodedUnshield[] {
    return this.notes.unshieldEvents();
  }

  /** Notes the wallet authored (recovered sender-side) — the recipient/fee detail of its own sends. */
  sentOutputs(): readonly SentOutput[] {
    return this.notes.sentOutputs();
  }

  /** Per-txid relayer fee paid in a gasless shield we co-authored (issue #88) — feeds history recovery. */
  shieldRelayerFees(): ReadonlyMap<string, bigint> {
    return this.notes.shieldRelayerFees();
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
    return computeBalances(this.notes.ownedTxos(), this.notes.spentNullifiers(), nullifyingKey, options, holds);
  }

  get txoCount(): number {
    return this.notes.ownedTxos().length;
  }

  /** Number of leaves inserted into `tree`. */
  treeLength(tree: number): number {
    return this.tree.length(tree);
  }

  /** Merkle proof for a note at `(tree, position)` — the spend witness's `pathElements`/`leavesIndices`. */
  merkleProof(tree: number, position: number): MerkleProof {
    return this.tree.merkleProof(tree, position);
  }

  /**
   * Unspent owned TXOs (tree-scoped nullifier–filtered), ready to hand to `planTransfer`. Excludes any
   * note whose `(tree, getNullifier(nullifyingKey, position))` appears in the recorded spent set OR in
   * `holds`, the optimistic in-flight spends (issue #55) — so a note with a submitted-but-unconfirmed
   * spend is not reselected before its `Nullified` event is scanned.
   */
  spendableTxos(nullifyingKey: bigint, holds: readonly PendingSpend[] = []): TXO[] {
    const spentSet = new Set(this.notes.spentNullifiers().map((s) => nullifierKey(s.tree, s.nullifier)));
    const pendingSet = new Set(holds.map((p) => nullifierKey(p.tree, p.nullifier)));
    return this.notes.ownedTxos().filter((t) => {
      const key = nullifierKey(t.tree, TransactNote.getNullifier(nullifyingKey, t.position));
      return !spentSet.has(key) && !pendingSet.has(key);
    });
  }

  /**
   * An independent copy of this state. A sync applies its batch to a copy and replaces the live state
   * only once the copy is verified and saved, so readers never see a half-applied batch and a failed
   * sync simply discards its copy. Each tree copies its levels as they are, so this is array copies, not re-hashing.
   */
  clone(): WalletScanState {
    return new WalletScanState(this.tree.clone(), this.notes.clone());
  }

  /** JSON-serializable snapshot of the accumulated tree/TXO/nullifier state. */
  snapshot(): ScanStateSnapshot {
    return {
      trees: this.tree.treeNumbers().map((tree) => ({ tree, leaves: [...this.tree.leaves(tree)] })),
      ...this.notes.snapshot(),
    };
  }

  /** Rebuild a `WalletScanState` from a snapshot — trees are re-derived from their leaves. */
  static restore(snapshot: ScanStateSnapshot): WalletScanState {
    return new WalletScanState(TreeStore.fromLeaves(snapshot.trees), WalletNotes.restore(snapshot));
  }
}
