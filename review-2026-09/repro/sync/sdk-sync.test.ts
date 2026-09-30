// ABOUTME: Repro — drives real createArmadaSdk syncs against a scripted mock chain (ethers Provider stubbed)
// ABOUTME: to show rootHistory-membership accepting truncated logs, and untrusted-indexer blind spots.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Scripted chain shared with the mocked provider.
const chain = {
  head: 0,
  logs: [] as { blockNumber: number; topics: string[]; data: string; transactionHash: string }[],
  knownRoots: new Set<string>(), // `${tree}:${rootBigInt}`
  lagTo: Infinity as number, // getLogs silently returns only logs <= lagTo (a lagging LB backend)
  getLogsCalls: 0,
};

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  const rootIface = new actual.Interface([
    'function rootHistory(uint256, bytes32) view returns (bool)',
    'function nullifiers(uint256, bytes32) view returns (bool)',
  ]);
  class MockProvider {
    async getBlockNumber(): Promise<number> { return chain.head; }
    async getLogs(f: { fromBlock: number; toBlock: number }): Promise<unknown[]> {
      chain.getLogsCalls++;
      return chain.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= Math.min(f.toBlock, chain.lagTo));
    }
    async call(tx: { data: string }): Promise<string> {
      const desc = rootIface.parseTransaction({ data: tx.data })!;
      if (desc.name === 'rootHistory') {
        const ok = chain.knownRoots.has(`${Number(desc.args[0])}:${BigInt(desc.args[1])}`);
        return rootIface.encodeFunctionResult('rootHistory', [ok]);
      }
      return rootIface.encodeFunctionResult('nullifiers', [false]);
    }
    async getBlock(): Promise<null> { return null; }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { Interface } from 'ethers';
import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash, ShieldNote, TransactNote } from '../../../src/core/index';
import { UTXOMerkletree, POOL_V2_EVENT_ABI, serializeQuickSync, type DecodedShieldCommitment } from '../../../src/sync/index';
import { deriveKeyset } from '../../../src/wallet/index';
import type { ArmadaSdkConfig } from '../../../src/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from '../../../src/prover/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = { resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }) };
const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const cfg = (extra: Partial<ArmadaSdkConfig> = {}): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage: new MemoryStorageAdapter(),
  prover: stubProver,
  artifacts: stubArtifacts,
  ...extra,
});

// The "true" on-chain tree, mirrored so rootHistory can answer membership (Railgun: every post-insert root).
let truth: UTXOMerkletree;
let txCounter = 0;
function pushTransact(block: number, leafHashes: bigint[]): void {
  const start = truth.length;
  const ct = [[b32(1n), b32(2n), b32(3n), b32(4n)], b32(5n), b32(6n), '0x', '0x'];
  const log = iface.encodeEventLog('Transact', [0, start, leafHashes.map(b32), leafHashes.map(() => ct)]);
  chain.logs.push({ blockNumber: block, topics: log.topics, data: log.data, transactionHash: b32(BigInt(++txCounter)) });
  for (const h of leafHashes) truth.insert(h.toString(16).padStart(64, '0'));
  chain.knownRoots.add(`0:${BigInt('0x' + truth.root())}`);
}

beforeAll(async () => { await initPoseidonPromise; });
beforeEach(() => {
  chain.head = 0; chain.logs = []; chain.knownRoots = new Set(); chain.lagTo = Infinity; chain.getLogsCalls = 0;
  truth = new UTXOMerkletree();
  chain.knownRoots.add(`0:${BigInt('0x' + truth.root())}`);
});

describe('RPC path: rootHistory membership accepts a truncated log set', () => {
  it('a lagging getLogs backend advances the checkpoint past missing events, then wedges sync forever', async () => {
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    pushTransact(30, [103n]);
    chain.head = 30;
    chain.lagTo = 20; // getLogs backend is 10 blocks behind the getBlockNumber backend — returns no error, just fewer logs

    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    const r1 = await wallet.sync();
    // Accepted: 2-leaf root is a historical root, so verifyRoots passes, and the checkpoint jumps to 30.
    expect(r1).toMatchObject({ scanned: true, syncedThrough: 30 });

    // The backend catches up; a new commitment lands at block 40.
    chain.lagTo = Infinity;
    pushTransact(40, [104n]);
    chain.head = 40;
    // Block 30's leaf is never re-fetched: [31,40] starts at position 3 while the local tree has 2 leaves.
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    // No self-heal: persisted roots are "valid" (historical), so reorg recovery never triggers.
    chain.head = 41;
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'POSITION_GAP' });
    await sdk.close();
  });
});

class TestShieldNote extends ShieldNote {}

describe('Indexer path: fields not covered by the leaf hash are trusted blindly', () => {
  it('a malicious indexer inflates a shield value (hash unchanged) and omits the Nullified event; roots still verify', async () => {
    const keyset = await deriveKeyset(new Uint8Array(32).fill(0x11));
    const tokenData = getTokenDataERC20(USDC);
    const realValue = 1_000_000n;
    const note = new TestShieldNote(keyset.masterPublicKey, 'ab'.repeat(16), realValue, tokenData);
    const req = await note.serialize(new Uint8Array(32).fill(9), keyset.viewingPublicKey);
    const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);
    const npk = strip(req.preimage.npk as string).padStart(64, '0');
    const hash = TransactNote.getHash(BigInt('0x' + npk), getTokenDataHash(tokenData), realValue).toString(16).padStart(64, '0');
    truth.insert(hash);
    chain.knownRoots.add(`0:${BigInt('0x' + truth.root())}`);

    const lied: DecodedShieldCommitment = {
      tree: 0, position: 0, blockNumber: 10, txid: b32(77n), hash, npk, tokenData,
      value: 1_000_000_000_000n, // <-- inflated; not bound by `hash` on the quick-sync path
      encryptedBundle: [strip(req.ciphertext.encryptedBundle[0] as string), strip(req.ciphertext.encryptedBundle[1] as string), strip(req.ciphertext.encryptedBundle[2] as string)],
      shieldKey: strip(req.ciphertext.shieldKey as string),
    };
    // (On-chain there is ALSO a Nullified event spending this note at block 20 — the indexer omits it.)
    const body = serializeQuickSync({ shields: [lied], transacts: [], nullifiers: [], unshields: [] }, 30);
    chain.head = 30;
    const events: { event: string; data: unknown }[] = [];
    const sdk = await createArmadaSdk(cfg({
      indexer: { url: 'https://idx.example', fetchFn: (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as typeof fetch },
      telemetry: { emit: (event, data) => events.push({ event, data }) },
    }));
    const wallet = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    await wallet.sync();
    expect(events.find((e) => e.event === 'sync.quicksync')?.data).toMatchObject({ outcome: 'served' });
    const bal = await wallet.balances();
    expect(bal[0]?.spendable).toBe(1_000_000_000_000n); // 1e6x the real deposit, and it is actually spent on-chain
    expect(chain.getLogsCalls).toBe(0); // RPC never consulted
    await sdk.close();
  });
});
