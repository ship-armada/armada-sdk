// ABOUTME: Browser IndexedDB StorageAdapter (SPEC §4.3) — persists the SDK's scan state across reloads.
// ABOUTME: Same namespace/identity semantics as MemoryStorageAdapter; chain-derived state resets on redeploy.

/// <reference lib="dom" />
// ^ IndexedDB (IDBDatabase/IDBRequest/…) types — this module is browser-only; the tsconfig `lib` is
//   ES2022 (no DOM) since the SDK also targets Node. Node consumers never instantiate this class.

import type { StorageAdapter, StorageNamespace, StorageOp, StorageWriteOptions } from './index';
import { NAMESPACE_KEY, isPreserved, encodeNamespace, bytesEqual, assertSameBinding, assertNotClosed } from './namespace';
import { InternalError, StorageConflictError, StorageUnavailableError } from '../errors';

const STORE = 'kv';

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new InternalError('IndexedDBStorageAdapter: stored value is not binary (a record this SDK did not write)');
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

/** Construction options for `IndexedDBStorageAdapter`. */
export interface IndexedDBStorageAdapterOptions {
  /**
   * Run without the exclusive Web Lock. ONLY for environments that have no Web Locks API (test harnesses such as
   * jsdom or Node + fake-indexeddb), where nothing else can open the database anyway. Without it, such an
   * environment fails closed rather than risk two instances corrupting each other's scan state.
   */
  readonly dangerouslySkipLock?: boolean;
}

/**
 * IndexedDB-backed KV. Values are stored as `Uint8Array` (structured-clone native). `dbName` scopes the
 * database — pass a per-app name. `open()` takes an origin-scoped EXCLUSIVE Web Lock on `dbName` (held
 * until `close()`): IndexedDB itself allows many connections to one DB, but the SDK's scan-state
 * read-modify-write is not safe across instances, so a second live instance on the same DB fails loud
 * with `StorageConflictError` instead of silently corrupting shared scan state. Where the browser has no
 * Web Locks API (an insecure context, or a very old browser) `open()` fails closed with
 * `StorageUnavailableError`, unless the adapter was built with `dangerouslySkipLock`.
 */
export class IndexedDBStorageAdapter implements StorageAdapter {
  private db: IDBDatabase | undefined;
  private lockRelease: (() => void) | undefined;
  // The namespace this adapter is open under, until close().
  private bound: Uint8Array | undefined;
  // Set by close(), cleared by open(): a closed adapter rejects every other call, rather than quietly reopening the
  // database without the lock.
  private closed = false;

  constructor(
    private readonly dbName: string,
    private readonly options: IndexedDBStorageAdapterOptions = {},
  ) {}

  /**
   * Acquire an origin-scoped exclusive lock on `dbName` (Web Locks API), held for this adapter's
   * lifetime. Turns concurrent same-DB instances (silent scan-state corruption) into a loud
   * `StorageConflictError` — the browser analog of `LevelStorageAdapter`'s single-process file lock.
   * Without the Web Locks API it fails closed, unless `dangerouslySkipLock` was set.
   */
  private async acquireLock(): Promise<void> {
    if (this.lockRelease !== undefined) return; // already held — open() is idempotent
    if (this.options.dangerouslySkipLock === true) return;
    const locks: LockManager | undefined =
      typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
    if (locks === undefined) {
      throw new StorageUnavailableError(
        `IndexedDBStorageAdapter: this environment has no Web Locks API (navigator.locks), so "${this.dbName}" can't be ` +
          `locked against a second instance; refusing to open unlocked (set dangerouslySkipLock only for test harnesses)`,
      );
    }
    const name = `armada-sdk-storage:${this.dbName}`;
    await new Promise<void>((acquired, failed) => {
      locks
        .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (lock === null) {
            // Another live instance in this origin holds the DB — fail fast, don't queue.
            failed(
              new StorageConflictError(
                `IndexedDBStorageAdapter: database "${this.dbName}" is already open by another live SDK ` +
                  `instance in this origin; close it before creating another (concurrent instances corrupt scan state)`,
              ),
            );
            return undefined;
          }
          acquired();
          // Hold the lock until close() resolves this promise.
          return new Promise<void>((release) => {
            this.lockRelease = release;
          });
        })
        .catch((err: unknown) => failed(err instanceof Error ? err : new Error(String(err))));
    });
  }

  private async database(): Promise<IDBDatabase> {
    assertNotClosed('IndexedDBStorageAdapter', this.closed);
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

  async open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    const nsBytes = encodeNamespace(namespace);
    if (assertSameBinding('IndexedDBStorageAdapter', this.bound, nsBytes)) return { reset: false };
    this.closed = false;
    await this.acquireLock();
    await this.database();
    const previous = await this.get(NAMESPACE_KEY);
    const reset = previous !== undefined && !bytesEqual(previous, nsBytes);
    if (reset) {
      // Deployment changed under a preserved identity → reset chain-derived state (SPEC §4.3).
      await this.resetChainState();
    }
    await this.put(NAMESPACE_KEY, nsBytes);
    this.bound = nsBytes;
    return { reset };
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

  // One readwrite transaction: IndexedDB serializes overlapping readwrite transactions on a store, so no other
  // write lands between the read and the write. The read's success handler computes and writes directly — awaiting
  // anything in between would let the transaction commit early.
  async update(
    key: string,
    fn: (current: Uint8Array | undefined) => Uint8Array | undefined,
    options?: StorageWriteOptions,
  ): Promise<Uint8Array | undefined> {
    const db = await this.database();
    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: options?.durable === true ? 'strict' : 'default' });
      const store = tx.objectStore(STORE);
      let next: Uint8Array | undefined;
      let failure: unknown;
      const request = store.get(key);
      request.onsuccess = (): void => {
        try {
          next = fn(request.result === undefined ? undefined : toUint8Array(request.result));
        } catch (err) {
          failure = err;
          tx.abort();
          return;
        }
        if (next === undefined) store.delete(key);
        else store.put(next.slice(), key);
      };
      tx.oncomplete = (): void => resolve(next);
      tx.onerror = (): void => reject(failure ?? tx.error);
      tx.onabort = (): void => reject(failure ?? tx.error);
    });
  }

  async batch(ops: readonly StorageOp[], options?: StorageWriteOptions): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite', { durability: options?.durable === true ? 'strict' : 'default' });
    const store = tx.objectStore(STORE);
    for (const op of ops) {
      if (op.type === 'put') store.put(op.value.slice(), op.key);
      else store.delete(op.key);
    }
    await txDone(tx);
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
      if (!isPreserved(String(key))) store.delete(key);
    }
    await txDone(store.transaction);
  }

  async close(): Promise<void> {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
    // Release the exclusive lock so a fresh instance for this DB can open (unlock → lock → unlock).
    this.lockRelease?.();
    this.lockRelease = undefined;
    this.bound = undefined;
    this.closed = true;
  }
}
