// ABOUTME: Repro tests for the wallet-factory/key-custody review (wallet-storage area). Each test PASSES
// ABOUTME: when the reported issue is present — i.e. it asserts the current behaviour.
import { describe, it, expect, vi } from 'vitest';
import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import { ExternalSigner, deriveKeyset, LocalSigner } from '../../../src/wallet/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from '../../../src/prover/index';
import type { ArmadaSdkConfig } from '../../../src/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};
const makeConfig = (storage = new MemoryStorageAdapter()): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage,
  prover: stubProver,
  artifacts: stubArtifacts,
});

describe('WAL: spend key retained where docs say it is not', () => {
  it('fromRootSecret({viewOnly:true}) still holds the 32-byte spending private key on the wallet', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1, viewOnly: true });
    expect(w.canSpend).toBe(false);
    const sk = (w as unknown as { keyset: { spendingPrivateKey: Uint8Array } }).keyset.spendingPrivateKey;
    expect(sk.length).toBe(32);
    expect(sk.some((b) => b !== 0)).toBe(true);
    await sdk.close();
  });

  it('with an ExternalSigner attached, the wallet still derives + holds the spend key; signer key never checked', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const other = await deriveKeyset(new Uint8Array(32).fill(9)); // a DIFFERENT wallet's key
    const pubSpy = vi.fn(async () => other.spendingPublicKey);
    const signer = new ExternalSigner(async () => [], pubSpy);
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1, signer });
    expect(w.canSpend).toBe(true); // mismatched signer accepted
    expect(pubSpy).not.toHaveBeenCalled(); // getSpendingPublicKey() is never consulted by the SDK
    const sk = (w as unknown as { keyset: { spendingPrivateKey: Uint8Array } }).keyset.spendingPrivateKey;
    expect(sk.some((b) => b !== 0)).toBe(true); // "keep spend keys out of the SDK entirely" (docs/guide/security.md) does not hold
    await sdk.close();
  });

  it('viewOnlyFromViewingKey ignores a signer — no way to build viewing-key + external-signer wallet', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const ks = await deriveKeyset(new Uint8Array(32).fill(3));
    const full = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1, viewOnly: true });
    const signer = new ExternalSigner(async () => [], async () => ks.spendingPublicKey);
    const vo = await sdk.wallet.viewOnlyFromViewingKey(full.shareViewingKey(), { creationBlock: 1, signer } as never);
    expect(vo.canSpend).toBe(false);
    await sdk.close();
  });

  it('LocalSigner.dispose() leaves the wallet keyset copy of the spend key intact; sdk.close() disposes nothing', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1 });
    const internal = w as unknown as { keyset: { spendingPrivateKey: Uint8Array }; signer: LocalSigner & { disposed: boolean } };
    await sdk.close();
    expect(internal.signer.disposed).toBe(false);
    internal.signer.dispose();
    expect(internal.keyset.spendingPrivateKey.some((b) => b !== 0)).toBe(true);
  });
});

describe('SDK close lifecycle', () => {
  it('double close does not throw', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    await sdk.close();
    await expect(sdk.close()).resolves.toBeUndefined();
  });
  it('use-after-close: wallet factory still works and sync fails with an untyped error', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    await sdk.close();
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1 });
    const err = await w.sync().catch((e: unknown) => e);
    // eslint-disable-next-line no-console
    console.log('use-after-close sync error:', (err as Error)?.constructor?.name, (err as { code?: string })?.code, String((err as Error)?.message).slice(0, 120));
    expect(err).toBeInstanceOf(Error);
  });
});
