// ABOUTME: In-memory StorageAdapter (SPEC §4.3) — the reference/test adapter and the ephemeral-wallet
// ABOUTME: backing. Deployment-binding: opening under a changed namespace auto-resets chain-derived state.

import type { StorageAdapter, StorageNamespace } from './index';
import { NAMESPACE_KEY, isPreserved, encodeNamespace, bytesEqual } from './namespace';

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, Uint8Array>();

  async open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    const nsBytes = encodeNamespace(namespace);
    const previous = this.store.get(NAMESPACE_KEY);
    const reset = previous !== undefined && !bytesEqual(previous, nsBytes);
    if (reset) {
      // Deployment changed under a preserved identity → reset chain-derived state (SPEC §4.3).
      await this.resetChainState();
    }
    this.store.set(NAMESPACE_KEY, nsBytes);
    return { reset };
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
