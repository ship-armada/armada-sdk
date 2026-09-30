// ABOUTME: End-to-end sync integrity tests (#118) — drives real createArmadaSdk syncs against a scripted chain
// ABOUTME: with block hashes, reorgs, a lagging getLogs backend, and pool tree state readable at any block.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ── Scripted chain shared with the mocked ethers provider ─────────────────────────────────────────────
// `logs` is the canonical chain: each entry is one pool event log at a block. Block hashes are derived from
// (number, fork epoch), so a reorg from height h changes the hash of every block >= h — exactly what a real
// chain does, and what the SDK's reorg check keys on. Pool tree state (`treeNumber`, `merkleRoot`,
// `nextLeafIndex`, `rootHistory`) is recomputed from the logs at or below the queried block.
interface ChainLog {
  readonly blockNumber: number;
  readonly topics: string[];
  readonly data: string;
  readonly transactionHash: string;
  readonly leaves: readonly string[]; // leaf hashes (64 hex, no 0x) this log appends to tree 0
}
const chain = {
  head: 0,
  logs: [] as ChainLog[],
  epochs: new Map<number, number>(), // block → fork epoch (bumped by a reorg)
  lagTo: Infinity as number, // getLogs silently returns only logs <= lagTo (a lagging backend)
  callBlockTags: [] as unknown[],
  // Pool tree state at a block — installed in beforeAll (the mock factory can't import SDK modules: they
  // load ethers, which is mid-mock when the factory runs).
  treeAt: undefined as undefined | ((block: number) => { root: string; length: number; roots: Set<bigint> }),
};

function blockHash(n: number): string {
  const epoch = chain.epochs.get(n) ?? 0;
  return `0x${(BigInt(epoch) * 10n ** 12n + BigInt(n)).toString(16).padStart(64, '0')}`;
}

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  const poolIface = new actual.Interface([
    'function rootHistory(uint256, bytes32) view returns (bool)',
    'function nullifiers(uint256, bytes32) view returns (bool)',
    'function treeNumber() view returns (uint256)',
    'function merkleRoot() view returns (bytes32)',
    'function nextLeafIndex() view returns (uint256)',
  ]);
  // Resolve a blockTag (hash, number, or latest) to a canonical block number, as a node would.
  const resolveTag = (tag: unknown): number => {
    if (tag === undefined || tag === 'latest') return chain.head;
    if (typeof tag === 'number') return tag;
    if (typeof tag === 'string' && tag.length === 66) {
      for (let n = 0; n <= chain.head; n += 1) if (blockHash(n) === tag) return n;
      throw new Error(`header not found for ${tag}`);
    }
    return Number(tag);
  };
  class MockProvider {
    async getBlockNumber(): Promise<number> {
      return chain.head;
    }
    async getBlock(n: number): Promise<{ number: number; hash: string; timestamp: number } | null> {
      return n > chain.head ? null : { number: n, hash: blockHash(n), timestamp: n };
    }
    async getLogs(f: { fromBlock: number; toBlock: number }): Promise<unknown[]> {
      return chain.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= Math.min(f.toBlock, chain.lagTo));
    }
    async call(tx: { data: string; blockTag?: unknown }): Promise<string> {
      chain.callBlockTags.push(tx.blockTag);
      const block = resolveTag(tx.blockTag);
      const { root, length, roots } = chain.treeAt!(block);
      const d = poolIface.parseTransaction({ data: tx.data })!;
      switch (d.name) {
        case 'rootHistory':
          return poolIface.encodeFunctionResult('rootHistory', [Number(d.args[0]) === 0 && roots.has(BigInt(d.args[1]))]);
        case 'treeNumber':
          return poolIface.encodeFunctionResult('treeNumber', [0]);
        case 'merkleRoot':
          return poolIface.encodeFunctionResult('merkleRoot', [`0x${root}`]);
        case 'nextLeafIndex':
          return poolIface.encodeFunctionResult('nextLeafIndex', [length]);
        default:
          return poolIface.encodeFunctionResult('nullifiers', [false]);
      }
    }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { Interface } from 'ethers';
import { createArmadaSdk } from './sdk';
import { MemoryStorageAdapter } from './storage/index';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash, ShieldNote, TransactNote } from './core/index';
import { POOL_V2_EVENT_ABI, UTXOMerkletree, WalletScanState, saveScanState, serializeQuickSync, type DecodedShieldCommitment } from './sync/index';
import { deriveKeyset, type Keyset } from './wallet/index';
import type { ArmadaSdkConfig } from './index';
import type { Plan } from './tx/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const ROOT_SECRET = new Uint8Array(32).fill(0x11);
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = { resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }) };
const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const strip0x = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);
let txCounter = 0;

const cfg = (extra: Partial<ArmadaSdkConfig> = {}): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage: new MemoryStorageAdapter(),
  prover: stubProver,
  artifacts: stubArtifacts,
  ...extra,
});

// A Transact log appending `leaves` (someone else's notes — undecryptable ciphertexts) at `block`.
function pushTransact(block: number, leaves: bigint[]): void {
  const start = chain.logs.reduce((n, l) => n + l.leaves.length, 0);
  const ct = [[b32(1n), b32(2n), b32(3n), b32(4n)], b32(5n), b32(6n), '0x', '0x'];
  const log = iface.encodeEventLog('Transact', [0, start, leaves.map(b32), leaves.map(() => ct)]);
  chain.logs.push({
    blockNumber: block,
    topics: log.topics,
    data: log.data,
    transactionHash: b32(BigInt(++txCounter)),
    leaves: leaves.map((l) => l.toString(16).padStart(64, '0')),
  });
}

// A Shield log of one real note to `keyset` worth `value` USDC at `block`. Returns its decoded commitment.
class TestShieldNote extends ShieldNote {}
async function pushShield(block: number, keyset: Keyset, value: bigint): Promise<DecodedShieldCommitment> {
  const tokenData = getTokenDataERC20(USDC);
  const random = (++txCounter).toString(16).padStart(32, '0');
  const note = new TestShieldNote(keyset.masterPublicKey, random, value, tokenData);
  const req = await note.serialize(new Uint8Array(32).fill(9), keyset.viewingPublicKey);
  const npk = strip0x(req.preimage.npk as string).padStart(64, '0');
  const hash = TransactNote.getHash(BigInt(`0x${npk}`), getTokenDataHash(tokenData), value).toString(16).padStart(64, '0');
  const start = chain.logs.reduce((n, l) => n + l.leaves.length, 0);
  const encryptedBundle = req.ciphertext.encryptedBundle as [string, string, string];
  const log = iface.encodeEventLog('Shield', [
    0,
    start,
    [{ npk: `0x${npk}`, token: tokenData, value }],
    [{ encryptedBundle, shieldKey: req.ciphertext.shieldKey }],
    [0],
  ]);
  const txid = b32(BigInt(++txCounter));
  chain.logs.push({ blockNumber: block, topics: log.topics, data: log.data, transactionHash: txid, leaves: [hash] });
  return {
    tree: 0,
    position: start,
    blockNumber: block,
    txid,
    hash,
    npk,
    tokenData: { tokenType: 0, tokenAddress: USDC, tokenSubID: '0' },
    value,
    encryptedBundle: [strip0x(encryptedBundle[0]), strip0x(encryptedBundle[1]), strip0x(encryptedBundle[2])],
    shieldKey: strip0x(req.ciphertext.shieldKey as string),
  };
}

// A reorg from `height`: every block >= height gets a new hash, and the logs at/after it are replaced.
function reorgFrom(height: number, newHead: number, replay: () => void | Promise<void>): Promise<void> | void {
  for (let n = height; n <= Math.max(newHead, chain.head); n += 1) chain.epochs.set(n, (chain.epochs.get(n) ?? 0) + 1);
  chain.logs = chain.logs.filter((l) => l.blockNumber < height);
  chain.head = newHead;
  return replay();
}

let keyset: Keyset;
beforeAll(async () => {
  await initPoseidonPromise;
  keyset = await deriveKeyset(ROOT_SECRET);
  // Pool tree 0 as of `block`: its root, leaf count, and every root it has ever had (rootHistory).
  chain.treeAt = (block) => {
    const tree = new UTXOMerkletree();
    const roots = new Set<bigint>([BigInt(`0x${tree.root()}`)]);
    for (const l of chain.logs.filter((x) => x.blockNumber <= block)) {
      for (const leaf of l.leaves) tree.insert(leaf);
      roots.add(BigInt(`0x${tree.root()}`));
    }
    return { root: tree.root(), length: tree.length, roots };
  };
});
beforeEach(() => {
  chain.head = 0;
  chain.logs = [];
  chain.epochs = new Map();
  chain.lagTo = Infinity;
  chain.callBlockTags = [];
});

describe('SYNC-2: a sync is accepted only if it reproduces the pool tree exactly at the scanned block', () => {
  it('a lagging getLogs backend fails the sync without advancing the checkpoint, then catches up cleanly', async () => {
    // WHY: rootHistory membership accepts any historical root, so a truncated log set used to pass and the
    // checkpoint jumped past the missing events — later wedging on POSITION_GAP.
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    pushTransact(30, [103n]);
    chain.head = 30;
    chain.lagTo = 20;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });

    await expect(wallet.sync()).rejects.toMatchObject({ code: 'ROOT_MISMATCH' });
    expect((await wallet.syncStatus()).syncedThrough).toBe(0); // deployBlock - 1: nothing was accepted

    chain.lagTo = Infinity;
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 30 });
    pushTransact(40, [104n]);
    chain.head = 40;
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 40 });
    await sdk.close();
  });

  it('reads the pool tree state pinned to the scanned block by hash', async () => {
    pushTransact(10, [101n]);
    chain.head = 10;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();
    expect(chain.callBlockTags).toContain(blockHash(10));
    await sdk.close();
  });
});

describe('SYNC-1: a reorg under the checkpoint is detected by block hash and recovered by a rescan', () => {
  it('the same tx re-included one block later (the commonest reorg) recovers instead of wedging', async () => {
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    chain.head = 20;
    const events: { event: string; data: unknown }[] = [];
    const sdk = await createArmadaSdk(cfg({ telemetry: { emit: (event, data) => events.push({ event, data }) } }));
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();

    reorgFrom(20, 21, () => pushTransact(21, [102n]));
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 21 });
    expect(events).toContainEqual({ event: 'sync.reorg-recovery', data: { fromBlock: 1, reason: 'checkpoint-reorged' } });

    pushTransact(30, [103n]);
    chain.head = 30;
    await expect(wallet.sync()).resolves.toMatchObject({ syncedThrough: 30 });
    await sdk.close();
  });

  it('a replaced leaf followed by a new commitment recovers', async () => {
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    chain.head = 20;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();

    reorgFrom(20, 22, () => {
      pushTransact(21, [999n]);
      pushTransact(22, [103n]);
    });
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 22 });
    await sdk.close();
  });

  it('a same-height reorg of the checkpoint block is caught even though the head did not advance', async () => {
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    chain.head = 20;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();

    reorgFrom(20, 20, () => pushTransact(20, [555n]));
    // Without the hash check this returns `scanned: false` and keeps the orphaned leaf forever.
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 20 });
    await sdk.close();
  });

  it('detects a reorg that happened while the app was closed (the checkpoint hash is persisted)', async () => {
    pushTransact(10, [101n]);
    pushTransact(20, [102n]);
    chain.head = 20;
    const storage = new MemoryStorageAdapter();
    const first = await createArmadaSdk(cfg({ storage }));
    await (await first.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 })).sync();

    reorgFrom(20, 21, () => pushTransact(21, [102n]));
    const events: string[] = [];
    const second = await createArmadaSdk(cfg({ storage, telemetry: { emit: (event) => events.push(event) } }));
    const wallet = await second.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await expect(wallet.sync()).resolves.toMatchObject({ syncedThrough: 21 });
    expect(events).toContain('sync.reorg-recovery');
    await second.close();
  });

  it('keeps optimistic in-flight spend holds across the reorg rescan', async () => {
    const owned = await pushShield(10, keyset, 1_000_000n);
    pushTransact(20, [102n]);
    chain.head = 20;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();
    expect(wallet.spendableNullifiers()).toHaveLength(1);

    // Only `selectedInputs` (tree, position) feed the hold's nullifier.
    const plan = { selectedInputs: [{ tree: owned.tree, position: owned.position }] } as unknown as Plan;
    wallet.markSpendPending(plan, '0xsubmitted');
    expect(wallet.spendableNullifiers()).toHaveLength(0);

    reorgFrom(20, 21, () => pushTransact(21, [102n]));
    await wallet.sync();
    expect(wallet.spendableNullifiers()).toHaveLength(0); // still held: the reset must not drop it
    await sdk.close();
  });
});

describe('API-1: creationBlock only limits note discovery; the tree is always built from deployBlock', () => {
  it('a wallet created after the pool already had commitments syncs, and finds its later notes', async () => {
    pushTransact(50, [101n]); // someone else's note before the wallet existed
    await pushShield(150, keyset, 2_000_000n);
    chain.head = 200;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 100 });

    expect((await wallet.syncStatus()).syncedThrough).toBe(0); // deployBlock - 1, not creationBlock - 1
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 200 });
    const [usdc] = await wallet.balances();
    expect(usdc?.spendable).toBe(2_000_000n);
    await sdk.close();
  });

  it('does not record notes committed before creationBlock', async () => {
    await pushShield(60, keyset, 1_000_000n);
    await pushShield(150, keyset, 2_000_000n);
    chain.head = 200;
    const sdk = await createArmadaSdk(cfg());
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 100 });
    await wallet.sync();
    const [usdc] = await wallet.balances();
    expect(usdc?.spendable).toBe(2_000_000n);
    await sdk.close();
  });

  it('heals a persisted scan state that is missing leaves (the pre-fix wedge) with one rescan', async () => {
    // WHY: before this fix a wallet created after the pool's first commitment persisted a tree that
    // started past position 0; every later sync threw POSITION_GAP. Such records must recover, not wedge.
    pushTransact(50, [101n]);
    pushTransact(150, [102n]);
    chain.head = 200;
    const storage = new MemoryStorageAdapter();
    await saveScanState(storage, keyset.shieldedAddress, new WalletScanState(), 120); // empty tree @120
    const events: { event: string; data: unknown }[] = [];
    const sdk = await createArmadaSdk(
      cfg({ storage, dangerouslyAllowPlaintextStorage: true, telemetry: { emit: (event, data) => events.push({ event, data }) } }),
    );
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 100 });
    expect((await wallet.syncStatus()).syncedThrough).toBe(120);
    await expect(wallet.sync()).resolves.toMatchObject({ scanned: true, syncedThrough: 200 });
    expect(events).toContainEqual({ event: 'sync.reorg-recovery', data: { fromBlock: 1, reason: 'missing-leaves' } });
    await sdk.close();
  });
});

describe('SYNC-3: an indexer cannot misstate the value or token of a shield the wallet owns', () => {
  it('an inflated shield value is rejected and the range is rescanned from RPC', async () => {
    const real = await pushShield(10, keyset, 1_000_000n);
    chain.head = 30;
    const lied: DecodedShieldCommitment = { ...real, value: 1_000_000_000_000n }; // hash unchanged
    const body = serializeQuickSync({ shields: [lied], transacts: [], nullifiers: [], unshields: [] }, 30);
    const events: { event: string; data: Readonly<Record<string, unknown>> }[] = [];
    const sdk = await createArmadaSdk(
      cfg({
        indexer: { url: 'https://idx.example', fetchFn: (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as typeof fetch },
        telemetry: { emit: (event, data) => events.push({ event, data }) },
      }),
    );
    const wallet = await sdk.wallet.fromRootSecret(ROOT_SECRET, { creationBlock: 1 });
    await wallet.sync();

    expect(events.find((e) => e.event === 'sync.quicksync')?.data).toMatchObject({
      outcome: 'root-mismatch-fallback',
      reason: 'schema-mismatch',
    });
    const [usdc] = await wallet.balances();
    expect(usdc?.spendable).toBe(1_000_000n);
    await sdk.close();
  });
});
