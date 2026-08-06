// ABOUTME: Tests for scan-state persistence (§4.3/§4.4) — snapshot/restore round-trip and
// ABOUTME: StorageAdapter save/load, preserving balances, roots, spendable TXOs, and spent nullifiers.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import { MemoryStorageAdapter } from '../storage/index';
import { WalletScanState } from './scan-engine';
import type { DecodedPoolEvents, DecodedTransactCommitment } from './event-decoder';
import type { CommitmentCiphertextV2 } from './note-crypto';
import { saveScanState, loadScanState } from './scan-persistence';

const NK = 987654321098765n;
const TOKEN = 'ee'.repeat(32);
const TXID = '0x' + 'ab'.repeat(32);
const BAL = { currentBlock: 1000, finalityThreshold: 10 };
const leafHex = (n: number): string => n.toString(16).padStart(64, '0');
const owned = (value: bigint) => ({ tokenHash: TOKEN, value, random: '00'.repeat(16), notePublicKey: 0n });

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
const noEvents = (): DecodedPoolEvents => ({ shields: [], transacts: [], nullifiers: [] });

async function buildState(): Promise<WalletScanState> {
  const state = new WalletScanState();
  await state.apply(
    { ...noEvents(), transacts: [mkTransact(0, 0, leafHex(11)), mkTransact(0, 1, leafHex(12))] },
    { transact: async (c) => (c.hash === leafHex(12) ? owned(50n) : owned(100n)) },
  );
  return state;
}

describe('scan-state persistence (§4.3/§4.4)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('snapshot → restore preserves balances, root, and spendable TXOs', async () => {
    const state = await buildState();
    const restored = WalletScanState.restore(state.snapshot());

    expect(restored.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
    expect(restored.treeRoot(0)).toBe(state.treeRoot(0));
    expect(restored.treeLength(0)).toBe(2);
    expect(restored.spendableTxos(NK).map((t) => t.position)).toEqual(state.spendableTxos(NK).map((t) => t.position));
  });

  it('preserves spent nullifiers across a snapshot', async () => {
    const state = await buildState();
    await state.apply(
      { ...noEvents(), nullifiers: [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 0), blockNumber: 101, txid: TXID }] },
      { transact: async () => undefined },
    );
    const restored = WalletScanState.restore(state.snapshot());
    // Position-0 note is spent → excluded from both the balance and the spendable set.
    expect(restored.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
    expect(restored.spendableTxos(NK)).toHaveLength(1);
  });

  it('saves and loads scan state through a StorageAdapter', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const state = await buildState();

    await saveScanState(storage, '0zk_alice', state, 500);
    const loaded = await loadScanState(storage, '0zk_alice');

    expect(loaded).toBeDefined();
    expect(loaded!.syncedThrough).toBe(500);
    expect(loaded!.state.treeRoot(0)).toBe(state.treeRoot(0));
    expect(loaded!.state.balances(NK, BAL)).toEqual(state.balances(NK, BAL));
  });

  it('returns undefined for a wallet with no persisted state', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    expect(await loadScanState(storage, 'nobody')).toBeUndefined();
  });
});
