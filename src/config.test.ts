// ABOUTME: Tests for resolveConfig (F1, #143) — one place validates an ArmadaSdkConfig and applies every default,
// ABOUTME: so the rest of the SDK reads settled values instead of repeating `?? default` at each use.

import { describe, it, expect } from 'vitest';
import { resolveConfig } from './config';
import { InvalidConfigError } from './errors';
import { MemoryStorageAdapter } from './storage/index';
import type { ArmadaSdkConfig } from './index';
import type { ProverAdapter, ArtifactSource } from './prover/index';

const POOL = `0x${'11'.repeat(20)}` as const;
const USDC = `0x${'22'.repeat(20)}` as const;
const base = (pool: Partial<ArmadaSdkConfig['pool']> = {}, extra: Partial<ArmadaSdkConfig> = {}): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: POOL, deployBlock: 7, usdcAddress: USDC, ...pool },
  rpc: { urls: ['http://127.0.0.1:8545'] },
  storage: new MemoryStorageAdapter(),
  prover: {} as ProverAdapter,
  artifacts: {} as ArtifactSource,
  ...extra,
});

describe('resolveConfig (F1, #143)', () => {
  it('applies every default when the optional settings are omitted', () => {
    expect(resolveConfig(base())).toEqual({
      chainId: 31337,
      poolAddress: POOL,
      usdcAddress: USDC,
      deployBlock: 7,
      rpcUrls: ['http://127.0.0.1:8545'],
      finalityThreshold: 0,
      confirmationDepth: 0,
      pendingSpendTtlMs: 300_000,
      autoSyncIntervalMs: 10_000,
      sweepNoteThreshold: 5,
      supportedShapes: undefined,
      allowPlaintextStorage: false,
    });
  });

  it('keeps the settings it is given, lowercasing the yield adapter and turning shapes into a set', () => {
    const fetchFn = (async () => new Response()) as typeof fetch;
    const resolved = resolveConfig(
      base(
        {
          finalityThreshold: 3,
          confirmationDepth: 2,
          pendingSpendTtlMs: 60_000,
          autoSyncIntervalMs: 5_000,
          sweepNoteThreshold: 0,
          supportedShapes: ['1x2', '2x3'],
          wrappers: { yieldAdapter: `0x${'Ab'.repeat(20)}` },
          cctp: { domain: 6, messenger: `0x${'33'.repeat(20)}` },
        },
        { indexer: { url: 'https://indexer.example', fetchFn }, dangerouslyAllowPlaintextStorage: true },
      ),
    );
    expect(resolved).toMatchObject({
      finalityThreshold: 3,
      confirmationDepth: 2,
      pendingSpendTtlMs: 60_000,
      autoSyncIntervalMs: 5_000,
      sweepNoteThreshold: 0,
      yieldAdapterAddress: `0x${'ab'.repeat(20)}`,
      cctpMessenger: `0x${'33'.repeat(20)}`,
      indexer: { url: 'https://indexer.example', fetchFn },
      allowPlaintextStorage: true,
    });
    expect(resolved.supportedShapes).toEqual(new Set(['1x2', '2x3']));
  });

  it('validates first: a malformed config throws InvalidConfigError', () => {
    expect(() => resolveConfig(base({ poolAddress: '0x1234' as `0x${string}` }))).toThrow(InvalidConfigError);
  });
});
