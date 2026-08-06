// ABOUTME: Offline tests for createArmadaSdk (§4.1) — instance lifecycle, wallet identity parity,
// ABOUTME: spend-capability gating, close(), and documented not-implemented factory methods. No network.

import { describe, it, expect, beforeAll } from 'vitest';
import { createArmadaSdk } from './sdk';
import { deriveKeyset, LocalSigner } from './wallet/index';
import { MemoryStorageAdapter } from './storage/index';
import { initPoseidonPromise } from './core/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';
import type { ArmadaSdkConfig } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// A prover/artifacts stub — the lifecycle tests never prove, but close() must reach prover.close().
let proverClosed = false;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => { proverClosed = true; },
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};

const makeConfig = (): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] }, // never dialed in these tests
  storage: new MemoryStorageAdapter(),
  prover: stubProver,
  artifacts: stubArtifacts,
});

describe('createArmadaSdk (§4.1)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('loads a wallet whose 0zk matches deriveKeyset (identity parity)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x11), { creationBlock: 1 });
    expect(wallet.railgunAddress).toBe((await deriveKeyset(seed(0x11))).railgunAddress);
  });

  it('gates spend capability on an attached signer', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const viewOnly = await sdk.wallet.fromRootSecret(seed(0x22), { creationBlock: 1 });
    expect(viewOnly.canSpend).toBe(false);

    const spendable = await sdk.wallet.fromRootSecret(seed(0x22), {
      creationBlock: 1,
      signer: await LocalSigner.fromRootSecret(seed(0x22)),
    });
    expect(spendable.canSpend).toBe(true);
  });

  it('close() releases the prover', async () => {
    proverClosed = false;
    const sdk = await createArmadaSdk(makeConfig());
    await sdk.close();
    expect(proverClosed).toBe(true);
  });

  it('exportDisclosure + non-rootSecret factory methods throw documented not-implemented errors', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x33), { creationBlock: 1 });
    await expect(wallet.exportDisclosure('ref')).rejects.toThrow(/not implemented/);
    await expect(sdk.wallet.ephemeralFromSeed(seed(0x33))).rejects.toThrow(/not implemented/);
    await expect(sdk.wallet.fromMnemonic('m', { creationBlock: 1 })).rejects.toThrow(/not implemented/);
    await expect(sdk.wallet.viewOnlyFromViewingKey('vk', { creationBlock: 1 })).rejects.toThrow(/not implemented/);
  });

  it('supports multiple independent instances (no shared module state)', async () => {
    const a = await createArmadaSdk(makeConfig());
    const b = await createArmadaSdk(makeConfig());
    const wa = await a.wallet.fromRootSecret(seed(0x11), { creationBlock: 1 });
    const wb = await b.wallet.fromRootSecret(seed(0x44), { creationBlock: 1 });
    expect(wa.railgunAddress).not.toBe(wb.railgunAddress);
  });
});
