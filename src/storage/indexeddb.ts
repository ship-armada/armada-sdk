// ABOUTME: Browser IndexedDB StorageAdapter (SPEC §4.3) — persists the SDK's scan state across reloads.
// ABOUTME: Same namespace/identity semantics as MemoryStorageAdapter; chain-derived state resets on redeploy.

/// <reference lib="dom" />
// ^ IndexedDB (IDBDatabase/IDBRequest/…) types — this module is browser-only; the tsconfig `lib` is
//   ES2022 (no DOM) since the SDK also targets Node. Node consumers never instantiate this class.

import type { StorageAdapter, StorageNamespace } from './index';

// Chain-derived state (merkle, TXOs, scan checkpoints) lives outside this prefix and is wiped by
// resetChainState; wallet-identity records live under it and are preserved across redeploys.
const IDENTITY_PREFIX = 'identity/';
const NAMESPACE_KEY = 'identity/__namespace__';
const STORE = 'kv';

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

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('IndexedDBStorageAdapter: stored value is not binary');
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
    tx.onabort = (): void => reject(tx.error);
  });
}

/**
 * IndexedDB-backed KV. Multi-instance safe (no lock files). Values are stored as `Uint8Array`
 * (structured-clone native). `dbName` scopes the database — pass a per-app name.
 */
export class IndexedDBStorageAdapter implements StorageAdapter {
  private db: IDBDatabase | undefined;

  constructor(private readonly dbName: string) {}

  private async database(): Promise<IDBDatabase> {
    if (this.db !== undefined) return this.db;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (): void => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.database();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async open(namespace: StorageNamespace): Promise<void> {
    await this.database();
    const nsBytes = encodeNamespace(namespace);
    const previous = await this.get(NAMESPACE_KEY);
    if (previous !== undefined && !bytesEqual(previous, nsBytes)) {
      // Deployment changed under a preserved identity → reset chain-derived state (SPEC §4.3).
      await this.resetChainState();
    }
    await this.put(NAMESPACE_KEY, nsBytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = await promisify((await this.store('readonly')).get(key));
    return value === undefined ? undefined : toUint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const store = await this.store('readwrite');
    store.put(value.slice(), key);
    await txDone(store.transaction);
  }

  async del(key: string): Promise<void> {
    const store = await this.store('readwrite');
    store.delete(key);
    await txDone(store.transaction);
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    // `getAllKeys`/`getAll` over one bound range return corresponding, key-ordered arrays.
    const range =
      prefix.length > 0 ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
    const store = await this.store('readonly');
    const keys = (await promisify(store.getAllKeys(range))) as IDBValidKey[];
    const values = await promisify(store.getAll(range));
    for (let i = 0; i < keys.length; i += 1) {
      yield { key: String(keys[i]), value: toUint8Array(values[i]) };
    }
  }

  async resetChainState(): Promise<void> {
    const store = await this.store('readwrite');
    const keys = (await promisify(store.getAllKeys())) as IDBValidKey[];
    for (const key of keys) {
      if (!String(key).startsWith(IDENTITY_PREFIX)) store.delete(key);
    }
    await txDone(store.transaction);
  }

  async close(): Promise<void> {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }
}
