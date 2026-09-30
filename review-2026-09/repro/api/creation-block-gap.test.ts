// ABOUTME: Repro — a wallet whose creationBlock is later than the pool's first commitment can never sync:
// ABOUTME: the per-wallet merkletree starts at position 0, so the first scanned leaf (position > 0) is a PositionGapError.
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Pool history: one Transact at block 50 at position 0 (someone else's note), one at block 150 at position 1.
const logsByBlock: { block: number; pos: number }[] = [
  { block: 50, pos: 0 },
  { block: 150, pos: 1 },
];

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  const { POOL_V2_EVENT_ABI } = await import('../../../src/sync/event-decoder');
  const iface = new actual.Interface(POOL_V2_EVENT_ABI as unknown as string[]);
  const b32 = (h: string): string => `0x${h.repeat(32)}`;
  class MockProvider {
    async getBlockNumber(): Promise<number> { return 200; }
    async getLogs(f: { fromBlock: number; toBlock: number }): Promise<unknown[]> {
      return logsByBlock
        .filter((l) => l.block >= f.fromBlock && l.block <= f.toBlock)
        .map((l) => {
          const ct = { ciphertext: [b32('a1'), b32('a2'), b32('a3'), b32('a4')], blindedSenderViewingKey: b32('b1'), blindedReceiverViewingKey: b32('b2'), annotationData: '0x', memo: '0x' };
          const enc = iface.encodeEventLog('Transact', [0, l.pos, [b32('0c')], [ct]]);
          return { topics: enc.topics, data: enc.data, blockNumber: l.block, transactionHash: b32('ee') };
        });
    }
    async call(): Promise<string> { return `0x${'00'.repeat(31)}01`; } // rootHistory → true
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import type { ArmadaSdkConfig } from '../../../src/index';

const cfg = (): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: `0x${'22'.repeat(20)}` },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage: new MemoryStorageAdapter(),
  prover: { prove: async () => { throw new Error('unused'); }, verify: async () => true, close: async () => {} },
  artifacts: { resolve: async () => { throw new Error('unused'); } },
});

describe('creationBlock later than the first pool commitment', () => {
  beforeAll(() => {});
  it('control: creationBlock = deployBlock syncs fine', async () => {
    const sdk = await createArmadaSdk(cfg());
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(7), { creationBlock: 1 });
    await expect(w.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 200 });
    await sdk.close();
  });
  it('BUG: creationBlock = 100 (enrolled after the pool had commitments) wedges every sync with POSITION_GAP', async () => {
    const sdk = await createArmadaSdk(cfg());
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(7), { creationBlock: 100 });
    await expect(w.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    await expect(w.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' }); // not self-healing
    await sdk.close();
  });
});
