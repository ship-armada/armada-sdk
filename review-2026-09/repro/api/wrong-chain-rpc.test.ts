// ABOUTME: Repro — createArmadaSdk never checks the RPC's chainId against pool.chainId. An RPC URL for the
// ABOUTME: wrong chain "syncs" an empty pool, reports zero balances, and persists a checkpoint that later skips real history.
import { describe, it, expect, vi } from 'vitest';

const state = { head: 5_000_000, chainId: 1n }; // misconfigured: mainnet RPC for a Sepolia pool

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  class MockProvider {
    async getBlockNumber(): Promise<number> { return state.head; }
    async getNetwork(): Promise<{ chainId: bigint }> { return { chainId: state.chainId }; }
    async getLogs(): Promise<unknown[]> { return []; } // no pool contract on this chain → no logs
    async call(): Promise<string> { return '0x'; }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';

describe('RPC on the wrong chain', () => {
  it('BUG: sync succeeds against a chain that is not pool.chainId, zero balances, checkpoint advanced to the foreign head', async () => {
    const sdk = await createArmadaSdk({
      pool: { chainId: 11155111, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: `0x${'22'.repeat(20)}` },
      rpc: { urls: ['https://mainnet.example'] },
      storage: new MemoryStorageAdapter(),
      prover: { prove: async () => { throw new Error('unused'); }, verify: async () => true, close: async () => {} },
      artifacts: { resolve: async () => { throw new Error('unused'); } },
    });
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(9), { creationBlock: 1 });
    await expect(w.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 5_000_000 });
    expect(await w.balances()).toEqual([]);
    // Operator fixes the URL (same instance/storage here; a restart with the same store behaves the same because the
    // checkpoint is persisted): the real chain's head is lower than the poisoned checkpoint → nothing is ever scanned.
    state.head = 4_000_000; state.chainId = 11155111n;
    await expect(w.sync()).resolves.toMatchObject({ scanned: false, syncedThrough: 5_000_000 });
    await sdk.close();
  });
});
