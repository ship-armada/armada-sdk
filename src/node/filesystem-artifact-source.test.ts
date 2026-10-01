// ABOUTME: Tests for FilesystemArtifactSource (§4.5, Node-only) — reads the armada-circuits build layout from disk,
// ABOUTME: verifies it against a pinned manifest unless integrity is explicitly skipped, and honours an abort signal.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemArtifactSource } from './filesystem-artifact-source';
import { artifactDigest, shapeKey, type ArtifactManifest } from '../prover/manifest';
import type { CircuitShape } from '../prover/index';
import { AbortedError, ArtifactIntegrityError } from '../errors';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/prover/${name}`, import.meta.url));
const WASM = readFileSync(fixture('mul.wasm'));
const ZKEY = readFileSync(fixture('mul.zkey'));
const VKEY_RAW = readFileSync(fixture('mul.vkey.json'), 'utf8');
const SHAPE: CircuitShape = { nullifiers: 1, commitments: 1 }; // "1x1"
const manifest: ArtifactManifest = { [shapeKey(SHAPE)]: artifactDigest({ wasm: WASM, zkey: ZKEY, vkey: {} }) };

// Lay the mul fixture out as a build/<N>x<M>/ directory the filesystem source expects.
let baseDir: string;
beforeAll(() => {
  baseDir = join(tmpdir(), `armada-fs-artifacts-${WASM.length}`);
  mkdirSync(join(baseDir, '1x1', 'main_1x1_js'), { recursive: true });
  writeFileSync(join(baseDir, '1x1', 'main_1x1_js', 'main_1x1.wasm'), WASM);
  writeFileSync(join(baseDir, '1x1', 'final.zkey'), ZKEY);
  writeFileSync(join(baseDir, '1x1', 'vkey.json'), VKEY_RAW);
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('FilesystemArtifactSource (§4.5)', () => {
  it('resolves the build layout from disk and verifies it against the manifest', async () => {
    const set = await new FilesystemArtifactSource(baseDir, { manifest }).resolve(SHAPE);
    expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    expect(Array.from(set.zkey)).toEqual(Array.from(ZKEY));
    expect(set.vkey).toEqual(JSON.parse(VKEY_RAW));
  });

  it('rejects artifacts that do not match the pinned manifest (fail-closed, like HttpArtifactSource)', async () => {
    // WHY: the circuit wasm/zkey receive the full private witness. An unverified default meant a swapped
    // file on disk reached the prover; now skipping the check must be an explicit, greppable choice.
    const wrong: ArtifactManifest = { [shapeKey(SHAPE)]: { wasm: '00'.repeat(32), zkey: '00'.repeat(32) } };
    await expect(new FilesystemArtifactSource(baseDir, { manifest: wrong }).resolve(SHAPE)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('skips integrity ONLY with the explicit danger flag', async () => {
    const set = await new FilesystemArtifactSource(baseDir, { dangerouslySkipIntegrity: true }).resolve(SHAPE);
    expect(Array.from(set.zkey)).toEqual(Array.from(ZKEY));
  });

  it('throws for a missing shape', async () => {
    const source = new FilesystemArtifactSource(join(tmpdir(), 'armada-artifacts-does-not-exist'), { manifest });
    await expect(source.resolve(SHAPE)).rejects.toThrow();
  });

  it('rejects an aborted resolve with AbortedError', async () => {
    const source = new FilesystemArtifactSource(baseDir, { manifest });
    await expect(source.resolve(SHAPE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortedError);
  });
});
