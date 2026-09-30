// ABOUTME: Repro — a failed scan-state save leaves syncedThrough advanced over a rolled-back tree;
// ABOUTME: a throwing telemetry sink fails every indexer-backed sync.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const chain = {
  head: 0,
  logs: [] as { blockNumber: number; topics: string[]; data: string; transactionHash: string }[],
  knownRoots: new Set<string>(),
};

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  const rootIface = new actual.Interface(['function rootHistory(uint256, bytes32) view returns (bool)']);
  class MockProvider {
    async getBlockNumber(): Promise<number> { return chain.head; }
    async getLogs(f: { fromBlock: number; toBlock: number }): Promise<unknown[]> {
      return chain.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    }
    async call(tx: { data: string }): Promise<string> {
      const d = rootIface.parseTransaction({ data: tx.data })!;
      return rootIface.encodeFunctionResult('rootHistory', [chain.knownRoots.has(`${Number(d.args[0])}:${BigInt(d.args[1])}`)]);
    }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { Interface } from 'ethers';
import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import { initPoseidonPromise } from '../../../src/core/index';
import { UTXOMerkletree, POOL_V2_EVENT_ABI } from '../../../src/sync/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from '../../../src/prover/index';

const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const stubProver: ProverAdapter = { prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }), verify: async () => true, close: async () => {} };
const stubArtifacts: ArtifactSource = { resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }) };

// Canonical chain = ordered list of (block, leaf) single-leaf Transact txs; rebuild logs + rootHistory from it.
function setChain(txs: { block: number; leaf: bigint }[], head: number): void {
  const t = new UTXOMerkletree();
  chain.logs = []; chain.knownRoots = new Set([`0:${BigInt('0x' + t.root())}`]); chain.head = head;
  const ct = [[b32(1n), b32(2n), b32(3n), b32(4n)], b32(5n), b32(6n), '0x', '0x'];
  for (const { block, leaf } of txs) {
    const log = iface.encodeEventLog('Transact', [0, t.length, [b32(leaf)], [ct]]);
    chain.logs.push({ blockNumber: block, topics: log.topics, data: log.data, transactionHash: b32(leaf) });
    t.insert(leaf.toString(16).padStart(64, '0'));
    chain.knownRoots.add(`0:${BigInt('0x' + t.root())}`);
  }
}


class FlakyStore extends MemoryStorageAdapter {
  failNextScanPut = false;
  override async put(key: string, value: Uint8Array): Promise<void> {
    if (this.failNextScanPut && key.startsWith('chain/scan-state/')) { this.failNextScanPut = false; throw new Error('QuotaExceededError'); }
    return super.put(key, value);
  }
}

describe('save failure leaves syncedThrough advanced over a rolled-back tree', () => {
  beforeAll(async () => { await initPoseidonPromise; });
  it('one failed put → in-process checkpoint skips the range; next commitment wedges sync', async () => {
    const store = new FlakyStore();
    const sdk = await createArmadaSdk({
      pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      rpc: { urls: ['http://x'] }, storage: store, prover: stubProver, artifacts: stubArtifacts, dangerouslyAllowPlaintextStorage: true,
    });
    const wallet = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    setChain([{ block: 10, leaf: 101n }], 10);
    await wallet.sync();
    setChain([{ block: 10, leaf: 101n }, { block: 20, leaf: 102n }], 20);
    store.failNextScanPut = true;
    await expect(wallet.sync()).rejects.toThrow('QuotaExceededError');
    // Tree was rolled back to [101] but the checkpoint stayed at 20:
    expect((await wallet.syncStatus()).syncedThrough).toBe(20);
    // Head advances with no new commitment: sync "succeeds" (1-leaf root is historical) — leaf 102 silently skipped.
    chain.head = 25;
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 25 });
    // A new commitment arrives → permanent POSITION_GAP (until process restart re-hydrates the old record).
    setChain([{ block: 10, leaf: 101n }, { block: 20, leaf: 102n }, { block: 30, leaf: 103n }], 30);
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    await sdk.close();
  });
});

describe('a throwing telemetry sink fails every indexer-backed sync', () => {
  beforeAll(async () => { await initPoseidonPromise; });
  it('sink.emit throws → sync rejects with the sink error, checkpoint never advances', async () => {
    setChain([], 10);
    const body = { schemaVersion: 1, syncedThroughBlock: 10, shields: [], transacts: [], nullifiers: [], unshields: [] };
    const sdk = await createArmadaSdk({
      pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      rpc: { urls: ['http://x'] }, storage: new MemoryStorageAdapter(), prover: stubProver, artifacts: stubArtifacts,
      indexer: { url: 'https://i', fetchFn: (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as typeof fetch },
      telemetry: { emit: () => { throw new Error('sentry transport down'); } },
    });
    const wallet = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    await expect(wallet.sync()).rejects.toThrow('sentry transport down');
    expect((await wallet.syncStatus()).syncedThrough).toBe(0);
    await sdk.close();
  });
});
