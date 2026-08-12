// ABOUTME: In-memory StorageAdapter (SPEC §4.3) — the reference/test adapter and the ephemeral-wallet
// ABOUTME: backing. Deployment-binding: opening under a changed namespace auto-resets chain-derived state.

import type { StorageAdapter, StorageNamespace } from './index';

// Chain-derived state (merkle, TXOs, scan checkpoints) lives outside these prefixes and is wiped by
// resetChainState. `identity/` holds wallet-identity records; `durable/` holds other rootSecret-scoped
// records that MUST survive a redeploy — notably the §6.2 claim-seed counter, whose reset would cause
// catastrophic seed reuse. Both are preserved across redeploys.
const IDENTITY_PREFIX = 'identity/';
const DURABLE_PREFIX = 'durable/';
const NAMESPACE_KEY = 'identity/__namespace__';

/** Keys that survive resetChainState (deployment change) — identity + durable rootSecret-scoped records. */
function isPreserved(key: string): boolean {
  return key.startsWith(IDENTITY_PREFIX) || key.startsWith(DURABLE_PREFIX);
}

const textEncoder = new TextEncoder();

function encodeNamespace(ns: StorageNamespace): Uint8Array {
  return textEncoder.encode(
    `${ns.schemaVersion}|${ns.chainId}|${ns.poolAddress.toLowerCase()}|${ns.deployBlock}`,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, Uint8Array>();

  async open(namespace: StorageNamespace): Promise<void> {
    const nsBytes = encodeNamespace(namespace);
    const previous = this.store.get(NAMESPACE_KEY);
    if (previous !== undefined && !bytesEqual(previous, nsBytes)) {
      // Deployment changed under a preserved identity → reset chain-derived state (SPEC §4.3).
      await this.resetChainState();
    }
    this.store.set(NAMESPACE_KEY, nsBytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.store.get(key);
    return value === undefined ? undefined : value.slice();
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value.slice());
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    for (const [key, value] of this.store) {
      if (key.startsWith(prefix)) yield { key, value: value.slice() };
    }
  }

  async resetChainState(): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (!isPreserved(key)) this.store.delete(key);
    }
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
