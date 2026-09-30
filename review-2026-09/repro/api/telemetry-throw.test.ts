// ABOUTME: Repro — a throwing TelemetrySink fails wallet.sync() (and rolls back the scan), because
// ABOUTME: sdk.ts calls telemetry.emit() synchronously inside runSync's try block with no isolation.
import { describe, it, expect, vi } from 'vitest';

vi.mock('ethers', async (importActual) => {
  const actual = await importActual<typeof import('ethers')>();
  class MockProvider {
    async getBlockNumber(): Promise<number> { return 100; }
    async getLogs(): Promise<unknown[]> { return []; }
    destroy(): void {}
  }
  return { ...actual, JsonRpcProvider: MockProvider, FallbackProvider: MockProvider };
});

import { createArmadaSdk } from '../../../src/sdk';
import { MemoryStorageAdapter } from '../../../src/storage/index';
import type { ArmadaSdkConfig } from '../../../src/index';

const base = (telemetry: ArmadaSdkConfig['telemetry']): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: `0x${'22'.repeat(20)}` },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage: new MemoryStorageAdapter(),
  prover: { prove: async () => { throw new Error('unused'); }, verify: async () => true, close: async () => {} },
  artifacts: { resolve: async () => { throw new Error('unused'); } },
  // A healthy indexer returning an empty served batch → the sync emits sync.quicksync.
  indexer: {
    url: 'https://idx.example',
    fetchFn: (async () => new Response(JSON.stringify({ version: 1, syncedThroughBlock: 100, shields: [], transacts: [], nullifiers: [], unshields: [] }), { status: 200 })) as typeof fetch,
  },
  ...(telemetry ? { telemetry } : {}),
});

describe('throwing telemetry sink', () => {
  it('control: no sink → sync succeeds', async () => {
    const sdk = await createArmadaSdk(base(undefined));
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1 });
    await expect(w.sync()).resolves.toMatchObject({ scanned: true });
    await sdk.close();
  });
  it('BUG: a sink that throws (e.g. Sentry not initialised) fails the sync', async () => {
    const sdk = await createArmadaSdk(base({ emit: () => { throw new Error('sentry not initialised'); } }));
    const w = await sdk.wallet.fromRootSecret(new Uint8Array(32).fill(3), { creationBlock: 1 });
    const errors: unknown[] = [];
    w.on('scan:error', (e) => errors.push(e.error));
    await expect(w.sync()).rejects.toThrow('sentry not initialised');
    expect(errors).toHaveLength(1);
    expect((await w.syncStatus()).syncedThrough).toBe(0); // checkpoint not advanced
    await sdk.close();
  });
});
