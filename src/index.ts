// ABOUTME: Root entry for @armada/sdk — the instance API (SPEC §4.1) plus the frozen public contracts
// ABOUTME: (errors + storage/sync/prover/tx/wallet interfaces). Implementations land per SPEC phases.

import type { StorageAdapter } from './storage/index';
import type { ProverAdapter, ArtifactSource } from './prover/index';
import type { WalletFactory } from './wallet/index';

export interface PoolConfig {
  readonly chainId: number;
  readonly poolAddress: `0x${string}`;
  readonly deployBlock: number;
  readonly usdcAddress: `0x${string}`;
  readonly wrappers?: { gaslessShield?: `0x${string}`; yieldAdapter?: `0x${string}` };
  readonly cctp?: { domain: number; messenger: `0x${string}` };
}

export interface RpcConfig {
  readonly urls: readonly string[];
  readonly pollIntervalMs?: number;
}

/** Injected telemetry (SPEC §8). MUST NOT receive key material, seeds, memo plaintext, or 0zk addresses. */
export interface TelemetrySink {
  emit(event: string, data: Readonly<Record<string, unknown>>): void;
}

export interface ArmadaSdkConfig {
  readonly pool: PoolConfig;
  readonly rpc: RpcConfig;
  readonly storage: StorageAdapter;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
  readonly telemetry?: TelemetrySink;
}

/**
 * Per-instance SDK handle — no singletons, no module-level mutable state (kills the
 * `snarkjsInitialized` bug class). `sync`, `tx`, `ops`, and `preflight` are surfaced as their
 * modules land in Phase 2+.
 */
export interface ArmadaSdk {
  readonly wallet: WalletFactory;
  close(): Promise<void>;
}

/**
 * Construct an SDK instance — replaces `startRailgunEngine` + `loadProvider` + NETWORK_CONFIG
 * patching. Multiple instances per process are supported. (Phase 2 implementation.)
 */
export async function createArmadaSdk(config: ArmadaSdkConfig): Promise<ArmadaSdk> {
  void config;
  throw new Error('createArmadaSdk: not implemented yet — Phase 2 (SPEC §4.1)');
}

export const VERSION = '0.0.0';

// ── Frozen public contracts ────────────────────────────────
export * from './errors';
export * from './storage/index';
export * from './sync/index';
export * from './prover/index';
export type * from './tx/index';
export * from './wallet/index';
