// ABOUTME: Repro (review): IndexedDbArtifactCache keys by a caller-chosen version string, not the manifest
// ABOUTME: digest, so after a pinned-manifest update without a version bump it serves unverified stale bytes.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbArtifactCache } from '../../../src/prover/artifact-cache';
import { VerifiedArtifactSource, artifactDigest, shapeKey } from '../../../src/prover/manifest';
import type { ArtifactSet, ArtifactSource, CircuitShape } from '../../../src/prover/index';

const SHAPE: CircuitShape = { nullifiers: 1, commitments: 2 };
const setV1: ArtifactSet = { wasm: new Uint8Array([1]), zkey: new Uint8Array([1, 1]), vkey: { v: 1 } };
const setV2: ArtifactSet = { wasm: new Uint8Array([2]), zkey: new Uint8Array([2, 2]), vkey: { v: 2 } };
const fixed = (s: ArtifactSet): ArtifactSource => ({ resolve: async () => s });

describe('artifact cache vs manifest update', () => {
  it('BUG: cache serves v1 artifacts that fail the NEW pinned manifest', async () => {
    const manifestV1 = { [shapeKey(SHAPE)]: artifactDigest(setV1) };
    const manifestV2 = { [shapeKey(SHAPE)]: artifactDigest(setV2) };
    const opts = { version: 'prod', dbName: 'repro-cache' };
    await new IndexedDbArtifactCache(new VerifiedArtifactSource(fixed(setV1), manifestV1), opts).resolve(SHAPE);
    // App ships a circuits upgrade: new pinned manifest + origin now serves v2, version string unchanged.
    const got = await new IndexedDbArtifactCache(new VerifiedArtifactSource(fixed(setV2), manifestV2), opts).resolve(SHAPE);
    expect(Array.from(got.zkey)).toEqual([1, 1]); // stale v1 zkey returned
    expect(artifactDigest(got).zkey).not.toBe(manifestV2[shapeKey(SHAPE)]!.zkey); // and it violates the pinned manifest
  });
});
