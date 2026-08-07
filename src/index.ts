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
  /**
   * Optional native quick-sync indexer (e.g. the relayer-v2 watcher) serving the `/v2/quick-sync`
   * wire contract. When set it is the primary event source, with RPC getLogs covering the tail and
   * verifying results against the on-chain root. Omit to sync purely from RPC.
   */
  readonly indexer?: { readonly url: string };
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
 * patching. Multiple instances per process are supported; state is instance-scoped.
 */
export { createArmadaSdk } from './sdk';

export const VERSION = '0.0.0';

// ── Frozen public contracts ────────────────────────────────
export * from './errors';
export * from './storage/index';
export * from './sync/index';
export * from './prover/index';
export * from './tx/index';
export * from './wallet/index';

// ── Explicit root re-exports for node10 (classic moduleResolution) consumers ──
// A bare `export *` from a multi-entry tsup build silently drops symbols that the dts bundler assigns
// to another entry's shared chunk (the note-crypto / keyset helpers land in the `wallet`/`core` chunks
// and vanish from the root `.d.ts` even though they're present at runtime). The `./core` token layer
// isn't starred here at all — it's only reachable via the `/core` exports-map subpath, which classic
// `moduleResolution: Node` consumers (the POC relayer + interface app) can't resolve. Naming these
// explicitly pins them into the root `.d.ts`, so those consumers can import everything from the
// package root instead of hand-typed facades. Values first, then the token/keyset types they need.
export {
  createTransferNote,
  encryptNoteToReceiver,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  reconstructReceiveHistory,
  reconstructHistory,
} from './sync/index';
export type { HistoryEntry, HistoryCategory, TokenAddressResolver, ReconstructHistoryInput, SentRecipient } from './sync/index';
export { deriveKeyset, deriveKeysetFromMnemonic } from './wallet/index';
export type { Keyset } from './wallet/index';
export {
  getTokenDataERC20,
  getTokenDataHash,
  initPoseidonPromise,
  ChainType,
} from './core/index';
export type {
  TokenData,
  TokenDataGetter,
  Chain,
  AddressData,
  Ciphertext,
} from './core/index';
