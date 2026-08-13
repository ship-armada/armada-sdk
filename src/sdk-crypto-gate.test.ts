// ABOUTME: Verifies createArmadaSdk's crypto-ready gate — it must not resolve until BOTH engine WASM
// ABOUTME: inits (Poseidon + curve25519) have settled, so the first scan never trial-decrypts un-ready WASM.

import { describe, it, expect, vi } from 'vitest';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';
import type { ArmadaSdkConfig } from './index';

// A deferred we control, hoisted so the mock factory can reference it before imports run. Replaces
// curve25519's init while leaving Poseidon (and every other core export) real + already-resolved — so
// the ONLY thing that can hold createArmadaSdk here is the curve gate specifically.
const { curveDeferred, resolveCurve } = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { curveDeferred: promise, resolveCurve: resolve };
});
vi.mock('./core/index', async (importActual) => {
  const actual = await importActual<typeof import('./core/index')>();
  return { ...actual, initCurve25519Promise: curveDeferred };
});

import { createArmadaSdk } from './sdk';
import { MemoryStorageAdapter } from './storage/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};
const makeConfig = (): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] }, // never dialed
  storage: new MemoryStorageAdapter(),
  prover: stubProver,
  artifacts: stubArtifacts,
});

describe('createArmadaSdk — crypto-ready gate', () => {
  it('does not resolve until curve25519 WASM init settles (not just Poseidon)', async () => {
    let settled = false;
    const sdkPromise = createArmadaSdk(makeConfig()).then((sdk) => {
      settled = true;
      return sdk;
    });

    // Poseidon is resolved and the storage/provider setup is synchronous, so the only thing holding the
    // factory is the still-pending curve25519 gate. A build that awaited ONLY Poseidon would resolve here.
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);

    resolveCurve();
    const sdk = await sdkPromise;
    expect(settled).toBe(true);
    await sdk.close();
  });
});
