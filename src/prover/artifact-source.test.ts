// ABOUTME: Tests for the concrete ArtifactSource impls (§4.5) — filesystem reads the armada-circuits
// ABOUTME: build layout from disk; HTTP fetches the same layout (injected fetch), with 404 handling.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemArtifactSource, HttpArtifactSource } from './artifact-source';
import type { CircuitShape } from './index';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/prover/${name}`, import.meta.url));
const WASM = readFileSync(fixture('mul.wasm'));
const ZKEY = readFileSync(fixture('mul.zkey'));
const VKEY_RAW = readFileSync(fixture('mul.vkey.json'), 'utf8');
const SHAPE: CircuitShape = { nullifiers: 1, commitments: 1 }; // "1x1"

// Lay the mul fixture out as a build/<N>x<M>/ directory the filesystem source expects.
let baseDir: string;
beforeAll(() => {
  baseDir = join(tmpdir(), `armada-artifacts-${WASM.length}`);
  mkdirSync(join(baseDir, '1x1', 'main_1x1_js'), { recursive: true });
  writeFileSync(join(baseDir, '1x1', 'main_1x1_js', 'main_1x1.wasm'), WASM);
  writeFileSync(join(baseDir, '1x1', 'final.zkey'), ZKEY);
  writeFileSync(join(baseDir, '1x1', 'vkey.json'), VKEY_RAW);
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('ArtifactSource impls (§4.5)', () => {
  it('FilesystemArtifactSource resolves the build layout from disk', async () => {
    const source = new FilesystemArtifactSource(baseDir);
    const set = await source.resolve(SHAPE);
    expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    expect(Array.from(set.zkey)).toEqual(Array.from(ZKEY));
    expect(set.vkey).toEqual(JSON.parse(VKEY_RAW));
  });

  it('FilesystemArtifactSource throws for a missing shape', async () => {
    const source = new FilesystemArtifactSource(join(tmpdir(), 'armada-artifacts-does-not-exist'));
    await expect(source.resolve(SHAPE)).rejects.toThrow();
  });

  it('HttpArtifactSource fetches the same layout from a base URL', async () => {
    const bytesResponse = (bytes: Uint8Array): Response =>
      ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer } as unknown as Response);
    const jsonResponse = (obj: unknown): Response =>
      ({ ok: true, status: 200, json: async () => obj } as unknown as Response);

    const fetchFn = (async (url: string): Promise<Response> => {
      if (url.endsWith('main_1x1.wasm')) return bytesResponse(WASM);
      if (url.endsWith('final.zkey')) return bytesResponse(ZKEY);
      if (url.endsWith('vkey.json')) return jsonResponse(JSON.parse(VKEY_RAW));
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const source = new HttpArtifactSource('https://cdn.example/artifacts/', fetchFn);
    const set = await source.resolve(SHAPE);
    expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    expect(Array.from(set.zkey)).toEqual(Array.from(ZKEY));
    expect(set.vkey).toEqual(JSON.parse(VKEY_RAW));
  });

  it('HttpArtifactSource throws on a non-OK response', async () => {
    const fetchFn = (async (): Promise<Response> => ({ ok: false, status: 404 } as unknown as Response)) as unknown as typeof fetch;
    const source = new HttpArtifactSource('https://cdn.example/artifacts', fetchFn);
    await expect(source.resolve(SHAPE)).rejects.toThrow(/fetch failed \(404\)/);
  });
});
