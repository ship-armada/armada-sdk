// ABOUTME: Tests for SpendPlanner (F1, #143) — plans over spendable notes and the verified trees: each plan's merkle
// ABOUTME: proofs come from the trees its root does, and the pool's cross-chain and USDC-fee rules reject before planning.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash, poseidon, verifyMerkleProof } from '../core/index';
import { SpendPlanner } from './spend-planner';
import { TreeStore } from '../sync/tree-store';
import { resolveConfig, type ResolvedConfig } from '../config';
import { MemoryStorageAdapter } from '../storage/index';
import { InvalidRequestError } from '../errors';
import { deriveKeyset } from '../wallet/derive';
import type { TXO } from '../sync/balances';
import type { ArmadaSdkConfig } from '../index';
import type { ProverAdapter, ArtifactSource } from '../prover/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const POOL = `0x${'11'.repeat(20)}` as const;

const leaf = (n: number): string => poseidon([BigInt(n)]).toString(16).padStart(64, '0');

function config(pool: Partial<ArmadaSdkConfig['pool']> = {}): ResolvedConfig {
  return resolveConfig({
    pool: { chainId: 31337, poolAddress: POOL, deployBlock: 1, usdcAddress: USDC, supportedShapes: ['1x2', '2x2', '2x3'], ...pool },
    rpc: { urls: ['http://127.0.0.1:8545'] },
    storage: new MemoryStorageAdapter(),
    prover: {} as ProverAdapter,
    artifacts: {} as ArtifactSource,
  });
}

let usdcHash: string;
let RECIPIENT: string;
const note = (position: number, value: bigint): TXO => ({
  tree: 0,
  position,
  tokenHash: usdcHash,
  value,
  blockNumber: 10,
  txid: `0x${'ee'.repeat(32)}`,
  origin: 'transact',
  random: '00'.repeat(16),
  notePublicKey: 0n,
});

beforeAll(async () => {
  await initPoseidonPromise;
  usdcHash = getTokenDataHash(getTokenDataERC20(USDC));
  RECIPIENT = (await deriveKeyset(new Uint8Array(32).fill(0x66))).shieldedAddress;
});

describe('SpendPlanner (F1, #143)', () => {
  function planner(pool: Partial<ArmadaSdkConfig['pool']> = {}): { planner: SpendPlanner; tree: TreeStore } {
    const tree = new TreeStore();
    for (let i = 0; i < 4; i += 1) tree.insertLeaf(0, i, leaf(i + 1));
    return { planner: new SpendPlanner(config(pool), tree), tree };
  }

  it('binds the current root and captures each input\'s merkle proof from the same trees', () => {
    const { planner: p, tree } = planner();
    const [plan] = p.planTransfer({ outputs: [{ to0zk: RECIPIENT, amount: 5n }] }, [note(2, 10n)]);
    expect(plan!.merkleRoot).toBe(BigInt(`0x${tree.root(0)}`));
    const proof = tree.merkleProof(0, 2);
    expect(plan!.merkleProofs[0]).toEqual(proof.elements.map((e) => BigInt(`0x${e}`)));
    expect(verifyMerkleProof(proof)).toBe(true);
  });

  it('rejects a cross-chain unshield the pool would revert, and an in-proof fee on a non-USDC spend, before planning', () => {
    const { planner: p } = planner();
    const crossChain = { recipient: POOL, amount: 5n, adaptParams: `0x${'ab'.repeat(32)}` as `0x${string}` }; // no binding
    expect(() => p.planTransfer({ outputs: [], unshield: crossChain }, [note(2, 10n)])).toThrow(InvalidRequestError);
    const fee = { broadcasterShieldedAddress: RECIPIENT, perProof: 1n };
    expect(() =>
      p.planTransfer({ outputs: [{ to0zk: RECIPIENT, amount: 5n }], fee, tokenAddress: `0x${'22'.repeat(20)}` }, [note(2, 10n)]),
    ).toThrow(InvalidRequestError);
  });

  it('needs pool.supportedShapes to consolidate', () => {
    const { planner: p } = planner({ supportedShapes: undefined });
    expect(() => p.consolidate({}, [note(0, 1n), note(1, 1n)])).toThrow(/supportedShapes is required/);
  });
});
