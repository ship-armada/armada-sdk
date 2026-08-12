// ABOUTME: Storage adapter contract (SPEC §4.3) — environment-injected KV (browser IndexedDB / node
// ABOUTME: classic-level). Schema-versioning, deployment-binding, and at-rest AEAD wrap over this. FROZEN.

/**
 * Namespace key. Every store is scoped by this tuple; on open, a mismatch with the configured
 * `PoolConfig` triggers a targeted reset of chain-derived state (merkle, TXOs, scan checkpoints)
 * while preserving wallet-identity records — deletes the "stale DB after redeploy" pitfall.
 */
export interface StorageNamespace {
  readonly schemaVersion: number;
  readonly chainId: number;
  readonly poolAddress: `0x${string}`;
  readonly deployBlock: number;
}

/**
 * Raw environment KV. The SDK provides `IndexedDBStorageAdapter` (browser) and a
 * `classic-level` adapter (node). Higher layers wrap this with encryption + schema versioning;
 * chain-public data may be stored plaintext, decrypted note data is AEAD-encrypted under a
 * rootSecret-derived key. Multi-instance safe: no process-wide lock files.
 */
export interface StorageAdapter {
  /**
   * Bind the store to `namespace`. Returns `{ reset: true }` when a namespace mismatch (a redeploy under
   * a preserved identity) triggered a chain-state reset, so the instance can surface it as telemetry.
   */
  open(namespace: StorageNamespace): Promise<{ reset: boolean }>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  del(key: string): Promise<void>;
  /** Iterate entries whose key starts with `prefix` (ordered). */
  list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }>;
  /** Targeted reset of chain-derived namespaces, preserving identity records. */
  resetChainState(): Promise<void>;
  close(): Promise<void>;
}

// Implementations.
export { MemoryStorageAdapter } from './memory';
export { IndexedDBStorageAdapter } from './indexeddb';
export { EncryptedStore, deriveStorageKey, deriveWalletStorageKey } from './encrypted';
// Node-persistent adapter over an injected abstract-level DB (classic-level in prod). The consumer
// brings the level package — the SDK stays browser-safe and free of native deps.
export { LevelStorageAdapter } from './level';
export type { AbstractLevelLike } from './level';
