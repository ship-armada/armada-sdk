// ABOUTME: Wallet scan orchestrator (SPEC §4.4) — folds decoded pool events into per-tree merkletrees,
// ABOUTME: detects owned TXOs via injected decryptors, records nullifiers, verifies roots, projects balances.

import { TransactNote, encodeAddress } from '../core/index';
import { UTXOMerkletree, type MerkleProof } from './merkletree';
import {
  computeBalances,
  type TXO,
  type SpentNullifier,
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
}

// Compare two commitment roots regardless of 0x-prefix / leading-zero padding.
function sameRoot(a: string, b: string): boolean {
  const norm = (h: string): bigint => BigInt(h.startsWith('0x') ? h : `0x${h}`);
  return norm(a) === norm(b);
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

    const ownedTxos: TXO[] = [];
    for (const leaf of leaves) {
      const { tree, position, hash, blockNumber, txid } = leaf.c;
      this.insertLeaf(tree, position, hash);

      const owned =
        leaf.kind === 'transact'
          ? await decryptors.transact(leaf.c)
          : await decryptors.shield?.(leaf.c);
      if (owned !== undefined) {
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
      throw new PositionGapError(`scan: merkle position gap in tree ${tree}: expected ${expected}, got ${position}`);
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

  /** Per-token spendable/pending over all accumulated TXOs + spent nullifiers. */
  balances(nullifyingKey: bigint, options: BalanceOptions): TokenBalance[] {
    return computeBalances(this.txos, this.spent, nullifyingKey, options);
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
   * note whose `(tree, getNullifier(nullifyingKey, position))` appears in the recorded spent set.
   */
  spendableTxos(nullifyingKey: bigint): TXO[] {
    const spentSet = new Set(this.spent.map((s) => `${s.tree}:${s.nullifier.toString()}`));
    return this.txos.filter(
      (t) => !spentSet.has(`${t.tree}:${TransactNote.getNullifier(nullifyingKey, t.position).toString()}`),
    );
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
    return state;
  }
}
