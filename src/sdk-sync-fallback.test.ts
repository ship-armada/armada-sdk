// ABOUTME: End-to-end fallback observability test (#83) — drives a real createArmadaSdk sync against a
// ABOUTME: 404-ing indexer and asserts the sync.quicksync telemetry carries the true classified cause.

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Stub ONLY the ethers Provider transport (per-file scope, so the rest of the suite is untouched): a
// head to scan to and an empty getLogs, so the RPC fallback applies an empty batch and root-verify is
// vacuous. Everything else — the wallet, IndexerEventSource, RpcEventSource, scan engine — is real.
vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  class MockProvider {
    async getBlockNumber(): Promise<number> {
      return 100;
    }
    async getLogs(): Promise<unknown[]> {
      return [];
    }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { createArmadaSdk } from './sdk';
import { MemoryStorageAdapter } from './storage/index';
import { initPoseidonPromise } from './core/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';
import type { ArmadaSdkConfig } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};

describe('quick-sync fallback observability, end to end (#83)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('threads a 404 indexer cause into the emitted sync.quicksync as reason=indexer-http-error + status', async () => {
    // WHY: the pure pieces (classifyQuickSyncReason, quickSyncTelemetry, the typed throw) are unit-tested
    // in isolation, but nothing exercises the actual `catch (err)` → `cause: fallbackCause` → sink.emit
    // wiring in runSync. This is the exact path that used to mislabel a 404 as `root-mismatch-fallback`.
    const events: { event: string; data: Readonly<Record<string, unknown>> }[] = [];
    const cfg: ArmadaSdkConfig = {
      pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
      rpc: { urls: ['http://127.0.0.1:1'] }, // dialed through the mocked provider, never a real socket
      storage: new MemoryStorageAdapter(),
      prover: stubProver,
      artifacts: stubArtifacts,
      // A legacy/wrong endpoint: the indexer 404s, so the untrusted-indexer fallback fires.
      indexer: { url: 'https://watcher.example', fetchFn: (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch },
      telemetry: { emit: (event, data) => events.push({ event, data }) },
    };

    const sdk = await createArmadaSdk(cfg);
    const wallet = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(0x11), { creationBlock: 1 });
    const result = await wallet.sync();
    await sdk.close();

    // The sync still succeeds via the RPC fallback (empty pool → nothing to apply, root-verify vacuous).
    expect(result.scanned).toBe(true);

    const quicksync = events.filter((e) => e.event === 'sync.quicksync');
    expect(quicksync).toHaveLength(1);
    // The historical outcome is retained (back-compat), but the truth now rides alongside in `reason`.
    expect(quicksync[0]?.data).toMatchObject({
      outcome: 'root-mismatch-fallback',
      reason: 'indexer-http-error',
      status: 404,
    });
  });
});
