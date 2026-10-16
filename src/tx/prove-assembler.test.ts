// ABOUTME: Tests for proveParamsFor (F1, #143) — a plan's prove() inputs: outputs in fee → recipients → change order, each
// ABOUTME: tagged with its OutputType, the caller's self-metadata on the change note, and the wallet as sender.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash, poseidon, OutputType } from '../core/index';
import { proveParamsFor } from './prove-assembler';
import { SpendPlanner } from './spend-planner';
import { TreeStore } from '../sync/tree-store';
import { decodeSelfMetadata } from '../sync/self-metadata';
import { resolveConfig } from '../config';
import { MemoryStorageAdapter } from '../storage/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import type { TXO } from '../sync/balances';
import type { SpendSigner } from '../wallet/index';
import type { ProverAdapter, ArtifactSource } from '../prover/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const config = resolveConfig({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC, supportedShapes: ['1x3'] },
  rpc: { urls: ['http://127.0.0.1:8545'] },
  storage: new MemoryStorageAdapter(),
  prover: {} as ProverAdapter,
  artifacts: {} as ArtifactSource,
});
const adapters = { artifacts: {} as ArtifactSource, prover: {} as ProverAdapter };
const signer = {} as SpendSigner;

let wallet: Keyset;
let recipient: string;
let broadcaster: string;
let tree: TreeStore;
let note: TXO;

beforeAll(async () => {
  await initPoseidonPromise;
  wallet = await deriveKeyset(new Uint8Array(32).fill(0x11));
  recipient = (await deriveKeyset(new Uint8Array(32).fill(0x22))).shieldedAddress;
  broadcaster = (await deriveKeyset(new Uint8Array(32).fill(0x33))).shieldedAddress;
  tree = new TreeStore();
  tree.insertLeaf(0, 0, poseidon([1n]).toString(16).padStart(64, '0'));
  note = {
    tree: 0, position: 0, tokenHash: getTokenDataHash(getTokenDataERC20(USDC)), value: 10n, blockNumber: 1,
    txid: `0x${'ee'.repeat(32)}`, origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n,
  };
});

describe('proveParamsFor (F1, #143)', () => {
  it('orders the outputs fee → recipient → change, tags each, and carries self-metadata on the change note', () => {
    const [plan] = new SpendPlanner(config, tree).planTransfer(
      { outputs: [{ to0zk: recipient, amount: 5n, memo: 'invoice' }], fee: { broadcasterShieldedAddress: broadcaster, perProof: 1n } },
      [note],
    );
    const params = proveParamsFor(plan!, wallet, signer, config, adapters, { selfMetadata: 'ref-42' });
    const outputs = params.witness.outputs;
    expect(outputs.map((o) => [o.receiverAddress, o.value, o.outputType])).toEqual([
      [broadcaster, 1n, OutputType.BroadcasterFee],
      [recipient, 5n, OutputType.Transfer],
      [wallet.shieldedAddress, 4n, OutputType.Change],
    ]);
    expect(outputs[1]!.memo).toBe('invoice');
    expect(decodeSelfMetadata(outputs[2]!.memo)).toBe('ref-42');
    expect(params.witness.sender.senderAddress).toBe(wallet.shieldedAddress);
    expect(params.witness.signer).toBe(signer);
    expect(params.witness.merkleRoot).toBe(plan!.merkleRoot);
    expect(params.unshieldPreimage).toBeUndefined();
  });
});
