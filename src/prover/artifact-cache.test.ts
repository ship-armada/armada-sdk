// ABOUTME: Tests for IndexedDbArtifactCache (§4.5, fake-indexeddb) — first resolve fetches + caches,
// ABOUTME: later resolves hit the cache, version bump / clear() re-fetch.

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbArtifactCache } from './artifact-cache';
import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';

const SHAPE: CircuitShape = { nullifiers: 2, commitments: 3 };
const set = (): ArtifactSet => ({ wasm: new Uint8Array([1, 2, 3]), zkey: new Uint8Array([4, 5, 6]), vkey: { a: 1 } });

// A source that counts how many times it actually resolves (i.e. cache misses).
function countingSource(): ArtifactSource & { calls: number } {
  const s = { calls: 0, resolve: async (): Promise<ArtifactSet> => { s.calls += 1; return set(); } };
  return s;
}

describe('IndexedDbArtifactCache (§4.5)', () => {
  it('fetches once and serves subsequent resolves from IndexedDB', async () => {
    const inner = countingSource();
    const cache = new IndexedDbArtifactCache(inner, { version: 'v1', dbName: `cache-${Math.floor(1)}-a` });

    const first = await cache.resolve(SHAPE);
    expect(inner.calls).toBe(1);
    expect(Array.from(first.wasm)).toEqual([1, 2, 3]);

    const second = await cache.resolve(SHAPE);
    expect(inner.calls).toBe(1); // served from cache — inner NOT called again
    expect(Array.from(second.zkey)).toEqual([4, 5, 6]);
    expect(second.vkey).toEqual({ a: 1 });
  });

  it('re-fetches when the version changes (cache invalidation)', async () => {
    const inner = countingSource();
    await new IndexedDbArtifactCache(inner, { version: 'v1', dbName: 'cache-ver' }).resolve(SHAPE);
    expect(inner.calls).toBe(1);
    // A different version is a different key → miss → inner resolves again.
    await new IndexedDbArtifactCache(inner, { version: 'v2', dbName: 'cache-ver' }).resolve(SHAPE);
    expect(inner.calls).toBe(2);
  });

  it('clear() drops the cache so the next resolve re-fetches', async () => {
    const inner = countingSource();
    const cache = new IndexedDbArtifactCache(inner, { version: 'v1', dbName: 'cache-clear' });
    await cache.resolve(SHAPE);
    await cache.clear();
    await cache.resolve(SHAPE);
    expect(inner.calls).toBe(2);
  });
});
