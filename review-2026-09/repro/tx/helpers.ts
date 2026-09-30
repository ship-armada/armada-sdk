// ABOUTME: Repro helpers for tx review — build a spend-capable wallet whose persisted scan state holds
// ABOUTME: notes of chosen tokens/values per tree (mirrors src/sdk.test.ts walletWithNotes).
import { createArmadaSdk } from '../../../src/sdk';
import { deriveKeyset } from '../../../src/wallet/index';
import { saveScanState, WalletScanState } from '../../../src/sync/index';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash } from '../../../src/core/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from '../../../src/prover/index';
import type { ArmadaSdkConfig } from '../../../src/index';

export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
export const SHARES = '0x00000000000000000000000000000000000000aa' as const;
export const ADAPTER = '0x00000000000000000000000000000000000000bb' as const;
export const SHAPES = ['1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
  '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4'];
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};
const leaf = (n: number): string => n.toString(16).padStart(64, '0');

export async function walletWith(
  notes: { tree: number; token: `0x${string}`; value: bigint }[],
  pool: Partial<ArmadaSdkConfig['pool']> = {},
) {
  await initPoseidonPromise;
  const store = new MemoryStorageAdapter();
  await store.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
  const address = (await deriveKeyset(seed(0x55))).shieldedAddress;
  const byTree = new Map<number, number>();
  const txos = notes.map((n) => {
    const position = byTree.get(n.tree) ?? 0;
    byTree.set(n.tree, position + 1);
    return {
      tree: n.tree, position, tokenHash: getTokenDataHash(getTokenDataERC20(n.token)), value: n.value.toString(),
      blockNumber: 1, txid: `0x${'ee'.repeat(32)}`, origin: 'transact' as const, random: '00'.repeat(16), notePublicKey: '0',
    };
  });
  const trees = [...byTree.entries()].map(([tree, count]) => ({
    tree, leaves: Array.from({ length: count }, (_, i) => leaf(tree * 1000 + i + 1)),
  }));
  const state = WalletScanState.restore({ trees, txos, spent: [], unshields: [], sent: [] });
  await saveScanState(store, address, state, 500);
  const sdk = await createArmadaSdk({
    pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC, supportedShapes: SHAPES, ...pool },
    rpc: { urls: ['http://127.0.0.1:1'] },
    storage: store,
    prover: stubProver,
    artifacts: stubArtifacts,
    dangerouslyAllowPlaintextStorage: true,
  });
  const wallet = await sdk.wallet.fromRootSecret(seed(0x55), { creationBlock: 1 });
  await wallet.syncStatus();
  return { sdk, wallet };
}
