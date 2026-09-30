// ABOUTME: Repro — reorg shapes that surface as PositionGapError (not RootMismatchError) and so never
// ABOUTME: trigger the reorg self-heal in runSync, wedging every later sync.
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

async function freshWallet() {
  const sdk = await createArmadaSdk({
    pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    rpc: { urls: ['http://x'] }, storage: new MemoryStorageAdapter(), prover: stubProver, artifacts: stubArtifacts,
  });
  return { sdk, wallet: await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 }) };
}

describe('reorg recovery only fires on RootMismatchError', () => {
  beforeAll(async () => { await initPoseidonPromise; });

  it('1-block reorg that re-includes the same tx one block later wedges sync (tree still valid)', async () => {
    setChain([{ block: 10, leaf: 101n }, { block: 20, leaf: 102n }], 20);
    const { sdk, wallet } = await freshWallet();
    await wallet.sync(); // through 20, tree [101, 102]
    // Block 20 reorged out; the same tx lands in block 21 (commonest reorg shape).
    setChain([{ block: 10, leaf: 101n }, { block: 21, leaf: 102n }], 21);
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    chain.head = 30;
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' }); // permanent
    await sdk.close();
  });

  it('reorg replacing a persisted leaf with a different one, followed by a new commitment, wedges sync', async () => {
    setChain([{ block: 10, leaf: 101n }, { block: 20, leaf: 102n }], 20);
    const { sdk, wallet } = await freshWallet();
    await wallet.sync();
    setChain([{ block: 10, leaf: 101n }, { block: 21, leaf: 999n }], 21); // 102 dropped, 999 at position 1
    // Persisted tree [101,102] is NOT a known root now — but the error is POSITION_GAP, so no self-heal.
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    chain.head = 30;
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    await sdk.close();
  });

  it('control: reorg that drops a leaf with NO following commitment does self-heal (RootMismatch path)', async () => {
    setChain([{ block: 10, leaf: 101n }, { block: 20, leaf: 102n }], 20);
    const { sdk, wallet } = await freshWallet();
    await wallet.sync();
    setChain([{ block: 10, leaf: 101n }], 21);
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 21 });
    await sdk.close();
  });
});
