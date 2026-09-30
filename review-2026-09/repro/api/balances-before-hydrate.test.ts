// ABOUTME: Repro — after a restart, balances()/history()/planTransfer() read the empty in-memory scan state
// ABOUTME: because only sync()/syncStatus() hydrate from storage; a "cached balance" read before the first sync shows 0.
import { describe, it, expect, vi } from 'vitest';

const logs: unknown[] = [];
vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  class MockProvider {
    async getBlockNumber(): Promise<number> { return 100; }
    async getLogs(f: { fromBlock: number; toBlock: number }): Promise<unknown[]> {
      return (logs as { blockNumber: number }[]).filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    }
    async call(): Promise<string> { return `0x${'00'.repeat(31)}01`; }
    async getBlock(): Promise<{ timestamp: number }> { return { timestamp: 1 }; }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { Interface } from 'ethers';
import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import { buildShieldRequest, generateShieldPrivateKey } from '../../../src/tx/index';
import { POOL_V2_EVENT_ABI } from '../../../src/sync/index';
import type { ArmadaSdkConfig } from '../../../src/index';

// A storage adapter that survives close() — models a persistent Level/IndexedDB store across restarts.
class PersistentMemory extends MemoryStorageAdapter { override async close(): Promise<void> {} }

const USDC = `0x${'22'.repeat(20)}` as const;
const cfg = (storage: MemoryStorageAdapter): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage,
  prover: { prove: async () => { throw new Error('unused'); }, verify: async () => true, close: async () => {} },
  artifacts: { resolve: async () => { throw new Error('unused'); } },
});

describe('reads before first sync after restart', () => {
  it('BUG: balances() is empty after restart until sync() runs, although the checkpoint is hydrated', async () => {
    const storage = new PersistentMemory();
    const secret = new Uint8Array(32).fill(4);
    const sdk1 = await createArmadaSdk(cfg(storage));
    const w1 = await sdk1.wallet.fromRootSecret(secret, { creationBlock: 1 });

    const { shieldRequest } = await buildShieldRequest({ shieldedAddress: w1.shieldedAddress, amount: 1_000_000n, tokenAddress: USDC }, generateShieldPrivateKey());
    const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
    const p = shieldRequest.preimage;
    const enc = iface.encodeEventLog('Shield', [0, 0,
      [{ npk: p.npk.startsWith('0x') ? p.npk : `0x${p.npk}`, token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0 }, value: p.value }],
      [{ encryptedBundle: shieldRequest.ciphertext.encryptedBundle.map((x) => (x.startsWith('0x') ? x : `0x${x}`)), shieldKey: shieldRequest.ciphertext.shieldKey.startsWith('0x') ? shieldRequest.ciphertext.shieldKey : `0x${shieldRequest.ciphertext.shieldKey}` }],
      [0]]);
    logs.push({ topics: enc.topics, data: enc.data, blockNumber: 10, transactionHash: `0x${'ab'.repeat(32)}` });

    await w1.sync();
    expect((await w1.balances())[0]?.spendable).toBe(1_000_000n);
    await sdk1.close();

    // Restart: same storage, same wallet.
    const sdk2 = await createArmadaSdk(cfg(storage));
    const w2 = await sdk2.wallet.fromRootSecret(secret, { creationBlock: 1 });
    expect(await w2.balances()).toEqual([]);             // BUG: persisted 1 USDC not visible
    expect(await w2.history()).toEqual([]);              // BUG: history empty too
    expect((await w2.syncStatus()).syncedThrough).toBe(100); // yet the checkpoint says we're synced
    expect((await w2.balances())[0]?.spendable).toBe(1_000_000n); // syncStatus() happened to hydrate
    await sdk2.close();
  });
});
