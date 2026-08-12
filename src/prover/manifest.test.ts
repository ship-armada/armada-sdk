// ABOUTME: Unit tests for artifact-integrity verification — matching digests pass, tampered
// ABOUTME: wasm/zkey and missing shapes throw ArtifactIntegrityError; VerifiedArtifactSource wraps a source.

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { verifyArtifactIntegrity, VerifiedArtifactSource, shapeKey, type ArtifactManifest } from './manifest';
import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';
import { ArtifactIntegrityError } from '../errors';

const hex = (b: Uint8Array): string => Array.from(sha256(b), (x) => x.toString(16).padStart(2, '0')).join('');

const SHAPE: CircuitShape = { nullifiers: 1, commitments: 2 };
const WASM = new Uint8Array([1, 2, 3]);
const ZKEY = new Uint8Array([4, 5, 6]);
const ARTIFACTS: ArtifactSet = { wasm: WASM, zkey: ZKEY, vkey: {} };
const MANIFEST: ArtifactManifest = { '1x2': { wasm: hex(WASM), zkey: hex(ZKEY) } };

describe('verifyArtifactIntegrity', () => {
  it('passes for matching digests', () => {
    expect(() => verifyArtifactIntegrity(SHAPE, ARTIFACTS, MANIFEST)).not.toThrow();
  });

  it('throws ArtifactIntegrityError on a wasm digest mismatch', () => {
    const tampered: ArtifactSet = { ...ARTIFACTS, wasm: new Uint8Array([9, 9, 9]) };
    expect(() => verifyArtifactIntegrity(SHAPE, tampered, MANIFEST)).toThrow(ArtifactIntegrityError);
  });

  it('throws on a zkey digest mismatch', () => {
    const tampered: ArtifactSet = { ...ARTIFACTS, zkey: new Uint8Array([9, 9, 9]) };
    expect(() => verifyArtifactIntegrity(SHAPE, tampered, MANIFEST)).toThrow(/zkey digest mismatch/);
  });

  it('throws when the shape is missing from the manifest', () => {
    expect(() => verifyArtifactIntegrity({ nullifiers: 3, commitments: 3 }, ARTIFACTS, MANIFEST)).toThrow(
      /no manifest entry/,
    );
  });

  it('verifies the vkey digest when the manifest pins it and the source provides raw bytes', () => {
    const VKEY_RAW = new Uint8Array([7, 8, 9]);
    const manifest: ArtifactManifest = { '1x2': { wasm: hex(WASM), zkey: hex(ZKEY), vkey: hex(VKEY_RAW) } };
    // Matching raw vkey → passes.
    expect(() => verifyArtifactIntegrity(SHAPE, { ...ARTIFACTS, vkeyRaw: VKEY_RAW }, manifest)).not.toThrow();
    // Tampered raw vkey → rejected.
    expect(() => verifyArtifactIntegrity(SHAPE, { ...ARTIFACTS, vkeyRaw: new Uint8Array([9, 9, 9]) }, manifest)).toThrow(/vkey digest mismatch/);
    // Manifest pins a vkey but the source can't supply raw bytes → misconfiguration, rejected.
    expect(() => verifyArtifactIntegrity(SHAPE, ARTIFACTS, manifest)).toThrow(/no raw vkey bytes/);
  });

  it('skips the vkey check when the manifest omits a vkey digest (backward compatible)', () => {
    // MANIFEST has no vkey digest → a set with or without vkeyRaw both pass on wasm/zkey alone.
    expect(() => verifyArtifactIntegrity(SHAPE, { ...ARTIFACTS, vkeyRaw: new Uint8Array([1]) }, MANIFEST)).not.toThrow();
  });

  it('the error carries a stable code', () => {
    try {
      verifyArtifactIntegrity(SHAPE, { ...ARTIFACTS, wasm: new Uint8Array([0]) }, MANIFEST);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactIntegrityError);
      expect((e as ArtifactIntegrityError).code).toBe('ARTIFACT_INTEGRITY');
    }
  });

  it('shapeKey formats as NxM', () => {
    expect(shapeKey(SHAPE)).toBe('1x2');
  });
});

describe('VerifiedArtifactSource', () => {
  const sourceReturning = (a: ArtifactSet): ArtifactSource => ({ resolve: async () => a });

  it('resolves and returns artifacts that pass integrity', async () => {
    const vs = new VerifiedArtifactSource(sourceReturning(ARTIFACTS), MANIFEST);
    expect(await vs.resolve(SHAPE)).toBe(ARTIFACTS);
  });

  it('throws when the resolved artifacts are tampered', async () => {
    const vs = new VerifiedArtifactSource(sourceReturning({ ...ARTIFACTS, zkey: new Uint8Array([9]) }), MANIFEST);
    await expect(vs.resolve(SHAPE)).rejects.toThrow(ArtifactIntegrityError);
  });
});
