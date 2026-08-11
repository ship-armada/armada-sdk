// ABOUTME: Tests for the wallet scan orchestrator (§4.4) — tree routing/root-verify, position-gap
// ABOUTME: integrity, shield seam, nullifier exclusion, incremental batches, real-crypto TXO detection.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, TransactNote, type TokenData } from '../core/index';
import { deriveKeyset } from '../wallet/derive';
import { UTXOMerkletree } from './merkletree';
import { WalletScanState, ownedNoteFromTransactNote, type WalletDecryptors, type OwnedNote } from './scan-engine';
import type { DecodedPoolEvents, DecodedTransactCommitment, DecodedShieldCommitment } from './event-decoder';
import { createTransferNote, encryptNoteToReceiver, tryDecryptCommitment, type CommitmentCiphertextV2 } from './note-crypto';
import { RootMismatchError } from '../errors';

// Fake owned-note result for the synthetic decryptor tests (random/npk unused by balances/tree logic).
const owned = (tokenHash: string, value: bigint): OwnedNote => ({ tokenHash, value, random: '00'.repeat(16), notePublicKey: 0n });

const TXID = '0x' + 'ab'.repeat(32);
const NK = 987654321098765n; // arbitrary nullifying key for the synthetic tests
const TOKEN = 'ee'.repeat(32);

// Small field-safe leaf hashes (well below the BN254 prime).
const leafHex = (n: number): string => n.toString(16).padStart(64, '0');

const dummyCt = (): CommitmentCiphertextV2 => ({
  ciphertext: [leafHex(0), leafHex(0), leafHex(0), leafHex(0)],
  blindedSenderViewingKey: new Uint8Array(32),
  blindedReceiverViewingKey: new Uint8Array(32),
  memo: '0x',
  annotationData: '0x',
});

const mkTransact = (tree: number, position: number, hash: string): DecodedTransactCommitment => ({
  tree, position, blockNumber: 100, txid: TXID, hash, ciphertext: dummyCt(),
});
const mkShield = (tree: number, position: number, hash: string, value = 0n): DecodedShieldCommitment => ({
  tree, position, blockNumber: 100, txid: TXID, hash,
  npk: leafHex(1),
  tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' } as TokenData,
  value,
  encryptedBundle: [leafHex(0), leafHex(0), leafHex(0)],
  shieldKey: leafHex(0),
});

const noEvents = (): DecodedPoolEvents => ({ shields: [], transacts: [], nullifiers: [], unshields: [] });

describe('wallet scan orchestrator (§4.4)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('inserts leaves, detects owned transact TXOs, and projects balances', async () => {
    const state = new WalletScanState();
    const t = [mkTransact(0, 0, leafHex(11)), mkTransact(0, 1, leafHex(12)), mkTransact(0, 2, leafHex(13))];
    // Own only the middle commitment.
    const decryptors: WalletDecryptors = {
      transact: async (c) => (c.hash === leafHex(12) ? owned(TOKEN, 100n) : undefined),
    };
    const res = await state.apply({ ...noEvents(), transacts: t }, decryptors);

    expect(res.ownedTxos).toHaveLength(1);
    expect(state.txoCount).toBe(1);
    expect(state.treeLength(0)).toBe(3);

    // Tree routing/order cross-check: same leaves inserted into a standalone tree yield the same root.
    const ref = new UTXOMerkletree();
    ref.insertMany([leafHex(11), leafHex(12), leafHex(13)]);
    expect(state.treeRoot(0)).toBe(ref.root());

    expect(state.balances(NK, { currentBlock: 1000, finalityThreshold: 10 })).toEqual([
      { tokenHash: TOKEN, spendable: 100n, pending: 0n },
    ]);
  });

  it('verifies roots and throws RootMismatchError (code ROOT_MISMATCH) on mismatch', async () => {
    const state = new WalletScanState();
    const decryptors: WalletDecryptors = { transact: async () => undefined };
    await state.apply({ ...noEvents(), transacts: [mkTransact(0, 0, leafHex(7))] }, decryptors);

    // Matching root passes — with and without 0x prefix normalization.
    expect(() => state.verifyRoots(new Map([[0, state.treeRoot(0)]]))).not.toThrow();
    expect(() => state.verifyRoots(new Map([[0, `0x${state.treeRoot(0)}`]]))).not.toThrow();

    let caught: unknown;
    try {
      state.verifyRoots(new Map([[0, `0x${'01'.repeat(32)}`]]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RootMismatchError);
    expect((caught as RootMismatchError).code).toBe('ROOT_MISMATCH');
  });

  it('routes leaves into per-treeNumber merkletrees independently', async () => {
    const state = new WalletScanState();
    const decryptors: WalletDecryptors = { transact: async () => undefined };
    await state.apply(
      { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(21)), mkTransact(0, 1, leafHex(22)), mkTransact(1, 0, leafHex(23))] },
      decryptors,
    );
    expect(state.treeLength(0)).toBe(2);
    expect(state.treeLength(1)).toBe(1);
    expect(state.treeRoot(0)).not.toBe(state.treeRoot(1));
  });

  it('throws on a merkle position gap (leaf position must equal current tree length)', async () => {
    const state = new WalletScanState();
    const decryptors: WalletDecryptors = { transact: async () => undefined };
    await expect(
      state.apply({ ...noEvents(), transacts: [mkTransact(0, 1, leafHex(31))] }, decryptors),
    ).rejects.toThrow(/position gap/);
  });

  it('builds tree from shield leaves even without a shield decryptor; owns them when provided', async () => {
    const withoutShield = new WalletScanState();
    await withoutShield.apply(
      { ...noEvents(), shields: [mkShield(0, 0, leafHex(41)), mkShield(0, 1, leafHex(42))] },
      { transact: async () => undefined },
    );
    expect(withoutShield.treeLength(0)).toBe(2); // leaves inserted for root correctness
    expect(withoutShield.txoCount).toBe(0); // but no ownership without a shield decryptor

    const withShield = new WalletScanState();
    await withShield.apply(
      { ...noEvents(), shields: [mkShield(0, 0, leafHex(41), 500n)] },
      { transact: async () => undefined, shield: async (c) => owned(TOKEN, c.value) },
    );
    expect(withShield.txoCount).toBe(1);
    expect(withShield.balances(NK, { currentBlock: 1000, finalityThreshold: 10 })).toEqual([
      { tokenHash: TOKEN, spendable: 500n, pending: 0n },
    ]);
  });

  it('excludes a spent owned TXO once its tree-scoped nullifier arrives', async () => {
    const state = new WalletScanState();
    // Own the commitment at tree 0, position 0.
    await state.apply(
      { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(51))] },
      { transact: async () => owned(TOKEN, 250n) },
    );
    expect(state.balances(NK, { currentBlock: 1000, finalityThreshold: 10 })).toEqual([
      { tokenHash: TOKEN, spendable: 250n, pending: 0n },
    ]);

    // Its nullifier arrives in a later batch → spent → drops out of the balance.
    await state.apply(
      { ...noEvents(), nullifiers: [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 0), blockNumber: 101, txid: TXID }] },
      { transact: async () => undefined },
    );
    expect(state.balances(NK, { currentBlock: 1000, finalityThreshold: 10 })).toEqual([]);
  });

  it('accumulates leaves across incremental batches (append-only continuation)', async () => {
    const state = new WalletScanState();
    const decryptors: WalletDecryptors = { transact: async () => undefined };
    await state.apply({ ...noEvents(), transacts: [mkTransact(0, 0, leafHex(61)), mkTransact(0, 1, leafHex(62))] }, decryptors);
    await state.apply({ ...noEvents(), transacts: [mkTransact(0, 2, leafHex(63)), mkTransact(0, 3, leafHex(64))] }, decryptors);
    expect(state.treeLength(0)).toBe(4);

    const ref = new UTXOMerkletree();
    ref.insertMany([leafHex(61), leafHex(62), leafHex(63), leafHex(64)]);
    expect(state.treeRoot(0)).toBe(ref.root());
  });

  it('detects a real owned TXO via tryDecryptCommitment (end-to-end)', async () => {
    const sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    const receiver = await deriveKeyset(new Uint8Array(32).fill(0x22));
    const tokenData = getTokenDataERC20('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const value = 750000n;

    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value,
      tokenData,
    });
    const commitment = await encryptNoteToReceiver(
      note,
      { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey },
      receiver.viewingPublicKey,
    );
    const transact: DecodedTransactCommitment = {
      tree: 0, position: 0, blockNumber: 100, txid: TXID,
      hash: note.hash.toString(16).padStart(64, '0'),
      ciphertext: commitment,
    };
    const tokenDataGetter = { getTokenDataFromHash: async () => tokenData };
    const decryptors: WalletDecryptors = {
      transact: async (c) => {
        const decrypted = await tryDecryptCommitment(
          c.ciphertext,
          { addressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey }, viewingPrivateKey: receiver.viewingPrivateKey },
          tokenDataGetter,
        );
        return decrypted ? ownedNoteFromTransactNote(decrypted) : undefined;
      },
    };

    const state = new WalletScanState();
    const res = await state.apply({ ...noEvents(), transacts: [transact] }, decryptors);
    expect(res.ownedTxos).toHaveLength(1);
    // The owned TXO must carry the full spend witness — random + npk from the decrypted note.
    expect(res.ownedTxos[0]!.random).toBe(note.random);
    expect(res.ownedTxos[0]!.notePublicKey).toBe(note.notePublicKey);
    expect(state.balances(receiver.nullifyingKey, { currentBlock: 200, finalityThreshold: 10 })).toEqual([
      { tokenHash: note.tokenHash, spendable: value, pending: 0n },
    ]);
  });

  it('exposes merkle proofs matching a standalone tree', async () => {
    const state = new WalletScanState();
    await state.apply(
      { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(70)), mkTransact(0, 1, leafHex(71))] },
      { transact: async () => owned(TOKEN, 100n) },
    );
    const ref = new UTXOMerkletree();
    ref.insertMany([leafHex(70), leafHex(71)]);
    expect(state.merkleProof(0, 1).elements).toEqual(ref.merkleProof(1).elements);
    expect(state.merkleProof(0, 1).root).toBe(ref.root());
    expect(() => state.merkleProof(9, 0)).toThrow(/unknown tree/);
  });

  it('spendableTxos returns unspent notes and drops spent ones', async () => {
    const state = new WalletScanState();
    await state.apply(
      { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(80)), mkTransact(0, 1, leafHex(81))] },
      { transact: async () => owned(TOKEN, 100n) },
    );
    expect(state.spendableTxos(NK)).toHaveLength(2);

    // Spend the note at position 0 → it drops out of the spendable set.
    await state.apply(
      { ...noEvents(), nullifiers: [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 0), blockNumber: 1, txid: TXID }] },
      { transact: async () => undefined },
    );
    const spendable = state.spendableTxos(NK);
    expect(spendable).toHaveLength(1);
    expect(spendable[0]!.position).toBe(1);

    // The wallet's `spendableNullifiers()` accessor (WI-5 cross-check) maps each spendable note to
    // `(tree, getNullifier(nk, position))` — so a spent note never appears in the cross-check set.
    expect(spendable.map((t) => ({ tree: t.tree, nullifier: TransactNote.getNullifier(NK, t.position) }))).toEqual([
      { tree: 0, nullifier: TransactNote.getNullifier(NK, 1) },
    ]);
  });
});
