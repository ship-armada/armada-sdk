// ABOUTME: Tests for IndexedDbArtifactCache (§4.5, fake-indexeddb) — first resolve fetches + caches, later
// ABOUTME: resolves hit the cache, a pinned-manifest change or clear() re-fetches, unpinned bytes are never cached.

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbArtifactCache } from './artifact-cache';
import { artifactDigest, shapeKey, type ArtifactManifest } from './manifest';
import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';
import { ArtifactIntegrityError } from '../errors';

const SHAPE: CircuitShape = { nullifiers: 2, commitments: 3 };
const setV1 = (): ArtifactSet => ({ wasm: new Uint8Array([1, 2, 3]), zkey: new Uint8Array([4, 5, 6]), vkey: { a: 1 } });
const setV2 = (): ArtifactSet => ({ wasm: new Uint8Array([7, 8, 9]), zkey: new Uint8Array([10, 11, 12]), vkey: { a: 2 } });
const manifestFor = (set: ArtifactSet): ArtifactManifest => ({ [shapeKey(SHAPE)]: artifactDigest(set) });

// A source that counts how many times it actually resolves (i.e. cache misses).
function countingSource(make: () => ArtifactSet = setV1): ArtifactSource & { calls: number } {
  const s = { calls: 0, resolve: async (): Promise<ArtifactSet> => { s.calls += 1; return make(); } };
  return s;
}

describe('IndexedDbArtifactCache (§4.5)', () => {
  it('fetches once and serves subsequent resolves from IndexedDB', async () => {
    const inner = countingSource();
    const cache = new IndexedDbArtifactCache(inner, { manifest: manifestFor(setV1()), dbName: 'cache-hit' });

    const first = await cache.resolve(SHAPE);
    expect(inner.calls).toBe(1);
    expect(Array.from(first.wasm)).toEqual([1, 2, 3]);

    const second = await cache.resolve(SHAPE);
    expect(inner.calls).toBe(1); // served from cache — inner NOT called again
    expect(Array.from(second.zkey)).toEqual([4, 5, 6]);
    expect(second.vkey).toEqual({ a: 1 });
  });

  it('re-fetches when the pinned manifest changes, never serving the old artifacts', async () => {
    // WHY: entries used to be keyed by a caller-chosen version string. Shipping a circuits upgrade (a new
    // pinned manifest) without bumping it served the OLD cached zkey, which fails the new manifest. Keying
    // by the pinned digest makes a manifest change a cache miss by construction.
    await new IndexedDbArtifactCache(countingSource(setV1), { manifest: manifestFor(setV1()), dbName: 'cache-upgrade' }).resolve(SHAPE);

    const inner = countingSource(setV2);
    const got = await new IndexedDbArtifactCache(inner, { manifest: manifestFor(setV2()), dbName: 'cache-upgrade' }).resolve(SHAPE);
    expect(inner.calls).toBe(1);
    expect(Array.from(got.zkey)).toEqual([10, 11, 12]);
  });

  it('refuses to cache (or return) artifacts that do not match the pinned manifest', async () => {
    const inner = countingSource(setV2); // the origin serves bytes the manifest doesn't pin
    const cache = new IndexedDbArtifactCache(inner, { manifest: manifestFor(setV1()), dbName: 'cache-tampered' });
    await expect(cache.resolve(SHAPE)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(cache.resolve(SHAPE)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(inner.calls).toBe(2); // nothing was stored — each resolve went back to the source
  });

  it('rejects a shape the manifest does not pin without resolving it', async () => {
    const inner = countingSource();
    const cache = new IndexedDbArtifactCache(inner, { manifest: {}, dbName: 'cache-unpinned' });
    await expect(cache.resolve(SHAPE)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(inner.calls).toBe(0);
  });

  it('passes the resolve signal to the wrapped source on a miss', async () => {
    let seen: AbortSignal | undefined;
    const inner: ArtifactSource = { resolve: async (_shape, opts) => { seen = opts?.signal; return setV1(); } };
    const controller = new AbortController();
    await new IndexedDbArtifactCache(inner, { manifest: manifestFor(setV1()), dbName: 'cache-signal' })
      .resolve(SHAPE, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it('clear() drops the cache so the next resolve re-fetches', async () => {
    const inner = countingSource();
    const cache = new IndexedDbArtifactCache(inner, { manifest: manifestFor(setV1()), dbName: 'cache-clear' });
    await cache.resolve(SHAPE);
    await cache.clear();
    await cache.resolve(SHAPE);
    expect(inner.calls).toBe(2);
  });
});
