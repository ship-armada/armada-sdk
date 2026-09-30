// ABOUTME: Repro — note:received is swallowed for transfers that arrive while the app is closed — the first sync
// ABOUTME: after a restart baselines instead of emitting, even though hydrate already restored a baseline.
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
import { initPoseidonPromise, getTokenDataERC20 } from '../../../src/core/index';
import { createTransferNote, encryptNoteToReceiver } from '../../../src/sync/index';
import { deriveKeyset } from '../../../src/wallet/index';
import { UTXOMerkletree, POOL_V2_EVENT_ABI } from '../../../src/sync/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from '../../../src/prover/index';

const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const stubProver: ProverAdapter = { prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }), verify: async () => true, close: async () => {} };
const stubArtifacts: ArtifactSource = { resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }) };


const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');
const pre = (h: string): string => (h.startsWith('0x') ? h : '0x' + h);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const tree = new UTXOMerkletree();
function reset(): void { chain.logs = []; chain.knownRoots = new Set([`0:${BigInt('0x' + tree.root())}`]); }

async function pushTransferTo(block: number, receiverSeed: number, value: bigint): Promise<void> {
  const sender = await deriveKeyset(new Uint8Array(32).fill(0x77));
  const receiver = await deriveKeyset(new Uint8Array(32).fill(receiverSeed));
  const note = createTransferNote({
    receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
    senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
    value, tokenData: getTokenDataERC20(USDC), memoText: 'invoice #7',
  });
  const c = await encryptNoteToReceiver(note, { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey }, receiver.viewingPublicKey);
  const leaf = note.hash;
  const ct = [c.ciphertext.map(pre), hex(c.blindedSenderViewingKey), hex(c.blindedReceiverViewingKey), pre(c.annotationData), pre(c.memo)];
  const log = iface.encodeEventLog('Transact', [0, tree.length, [b32(leaf)], [ct]]);
  chain.logs.push({ blockNumber: block, topics: log.topics, data: log.data, transactionHash: b32(BigInt(block)) });
  tree.insert(leaf.toString(16).padStart(64, '0'));
  chain.knownRoots.add(`0:${BigInt('0x' + tree.root())}`);
}

describe('note:received across a restart', () => {
  beforeAll(async () => { await initPoseidonPromise; reset(); });
  it('a transfer that lands while the app is closed never fires note:received', async () => {
    const storage = new MemoryStorageAdapter();
    const mk = () => createArmadaSdk({
      pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
      rpc: { urls: ['http://x'] }, storage, prover: stubProver, artifacts: stubArtifacts,
    });
    // Session 1: one payment received, synced, persisted.
    await pushTransferTo(10, 0x11, 1_000n);
    chain.head = 20;
    const sdk1 = await mk();
    const w1 = await sdk1.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    await w1.sync();
    expect((await w1.balances())[0]?.spendable).toBe(1_000n);
    // (not closing sdk1: MemoryStorageAdapter.close() clears the store; simulate restart with a new instance)

    // While closed: a second payment arrives.
    await pushTransferTo(25, 0x11, 2_000n);
    chain.head = 30;

    // Session 2: restart, subscribe, sync.
    const sdk2 = await mk();
    const w2 = await sdk2.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    const received: unknown[] = [];
    w2.on('note:received', (p) => received.push(p));
    const r = await w2.sync();
    expect(r.fromBlock).toBe(21); // resumed from the persisted checkpoint — the 2_000 note IS new this sync
    expect((await w2.balances())[0]?.spendable).toBe(3_000n);
    expect(received).toHaveLength(0); // ...but no note:received was emitted for it

    // Control: a payment arriving while the app is open IS emitted.
    await pushTransferTo(35, 0x11, 5n);
    chain.head = 40;
    await w2.sync();
    expect(received).toHaveLength(1);
  });
});
