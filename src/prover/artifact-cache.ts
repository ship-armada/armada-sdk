// ABOUTME: IndexedDB artifact cache (SPEC §4.5) — wraps an ArtifactSource so a shape's wasm/zkey/vkey
// ABOUTME: are downloaded once and reused across proofs, instead of re-fetching the multi-MB zkey each time.

/// <reference lib="dom" />
// ^ IndexedDB types — this module is browser-only (Node resolves artifacts from the filesystem, which
//   the OS caches). The tsconfig `lib` is ES2022 (no DOM) since the SDK also targets Node.

import { shapeKey } from './manifest';
import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';

const STORE = 'artifacts';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function isArtifactSet(v: unknown): v is ArtifactSet {
  return (
    typeof v === 'object' && v !== null &&
    (v as ArtifactSet).wasm instanceof Uint8Array &&
    (v as ArtifactSet).zkey instanceof Uint8Array &&
    typeof (v as ArtifactSet).vkey === 'object'
  );
}

/**
 * Caches an inner `ArtifactSource`'s resolved sets in IndexedDB (browser). The first resolve for a shape
 * fetches + stores; later resolves read from IndexedDB, so the multi-MB zkey isn't re-downloaded per proof.
 *
 * Wrap the source you want cached — including a `VerifiedArtifactSource`, so only integrity-checked bytes
 * are ever stored. Cache entries are keyed by `(version, shape)`: bump `version` (e.g. the armada-circuits
 * build id) whenever the artifacts change to invalidate stale entries, or call `clear()`.
 */
export class IndexedDbArtifactCache implements ArtifactSource {
  private db: IDBDatabase | undefined;

  constructor(
    private readonly inner: ArtifactSource,
    private readonly opts: { readonly version: string; readonly dbName?: string },
  ) {}

  async resolve(shape: CircuitShape): Promise<ArtifactSet> {
    const key = `${this.opts.version}/${shapeKey(shape)}`;
    const cached = await this.read(key);
    if (cached !== undefined) return cached;
    const set = await this.inner.resolve(shape);
    await this.write(key, set);
    return set;
  }

  /** Drop every cached artifact (e.g. on a circuits rebuild without a version bump). */
  async clear(): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
    });
  }

  private async database(): Promise<IDBDatabase> {
    if (this.db !== undefined) return this.db;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.opts.dbName ?? 'armada-artifact-cache', 1);
      request.onupgradeneeded = (): void => { request.result.createObjectStore(STORE); };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error);
    });
    return this.db;
  }

  private async read(key: string): Promise<ArtifactSet | undefined> {
    const db = await this.database();
    const value = await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
    return isArtifactSet(value) ? value : undefined;
  }

  private async write(key: string, set: ArtifactSet): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(set, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
    });
  }
}
