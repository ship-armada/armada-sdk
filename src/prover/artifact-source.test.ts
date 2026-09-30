// ABOUTME: Tests for the concrete ArtifactSource impls (§4.5) — filesystem reads the armada-circuits
// ABOUTME: build layout from disk; HTTP fetches the same layout (injected fetch), with 404/abort/timeout handling.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemArtifactSource, HttpArtifactSource } from './artifact-source';
import { artifactDigest, shapeKey } from './manifest';
import type { ArtifactManifest } from './manifest';
import type { CircuitShape } from './index';
import { AbortedError } from '../errors';

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

  const bytesResponse = (bytes: Uint8Array): Response =>
    ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer } as unknown as Response);
  const VKEY_BYTES = new TextEncoder().encode(VKEY_RAW);
  // A fetch serving the mul fixture, optionally with a tampered zkey to exercise the integrity gate.
  // vkey is served as raw bytes now (the source reads it via arrayBuffer to hash it, not .json()).
  const fixtureFetch = (opts?: { tamperZkey?: boolean }): typeof fetch =>
    (async (url: string): Promise<Response> => {
      if (url.endsWith('main_1x1.wasm')) return bytesResponse(WASM);
      if (url.endsWith('final.zkey')) return bytesResponse(opts?.tamperZkey ? new Uint8Array([0, 1, 2, 3]) : ZKEY);
      if (url.endsWith('vkey.json')) return bytesResponse(VKEY_BYTES);
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
  const manifest: ArtifactManifest = { [shapeKey(SHAPE)]: artifactDigest({ wasm: WASM, zkey: ZKEY, vkey: {} }) };

  it('HttpArtifactSource verifies against a manifest by default and returns the layout', async () => {
    const source = new HttpArtifactSource('https://cdn.example/artifacts/', { manifest, fetchFn: fixtureFetch() });
    const set = await source.resolve(SHAPE);
    expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    expect(Array.from(set.zkey)).toEqual(Array.from(ZKEY));
    expect(set.vkey).toEqual(JSON.parse(VKEY_RAW));
  });

  it('HttpArtifactSource rejects a tampered zkey (fail-closed integrity, SPEC §4.5)', async () => {
    // WHY: a compromised origin serving a tampered zkey (which receives the full private witness) must
    // not reach the prover. Previously the HTTP source verified nothing unless the app opted in.
    const source = new HttpArtifactSource('https://cdn.example/artifacts/', {
      manifest,
      fetchFn: fixtureFetch({ tamperZkey: true }),
    });
    await expect(source.resolve(SHAPE)).rejects.toThrow(/zkey digest mismatch/);
  });

  it('HttpArtifactSource skips integrity ONLY with the explicit danger flag', async () => {
    const source = new HttpArtifactSource('https://cdn.example/artifacts/', {
      dangerouslySkipIntegrity: true,
      fetchFn: fixtureFetch({ tamperZkey: true }),
    });
    const set = await source.resolve(SHAPE); // tampered bytes pass through — the opt-out was deliberate
    expect(Array.from(set.zkey)).toEqual([0, 1, 2, 3]);
  });

  it('HttpArtifactSource throws on a non-OK response', async () => {
    const source = new HttpArtifactSource('https://cdn.example/artifacts', {
      dangerouslySkipIntegrity: true,
      fetchFn: (async (): Promise<Response> => ({ ok: false, status: 404 } as unknown as Response)) as unknown as typeof fetch,
    });
    await expect(source.resolve(SHAPE)).rejects.toThrow(/fetch failed \(404\)/);
  });

  // A fetch that never answers: it settles only by rejecting when its request signal aborts.
  const hangingFetch = (): typeof fetch =>
    (async (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      })) as unknown as typeof fetch;

  it('HttpArtifactSource cancels its fetches when the resolve signal aborts', async () => {
    // WHY: cancelling a proof must also stop a multi-MB artifact download that is still in flight.
    const source = new HttpArtifactSource('https://cdn.example/artifacts', { manifest, fetchFn: hangingFetch() });
    const controller = new AbortController();
    const resolving = source.resolve(SHAPE, { signal: controller.signal });
    controller.abort();
    await expect(resolving).rejects.toBeInstanceOf(AbortedError);
  });

  it('HttpArtifactSource rejects an already-aborted resolve without fetching', async () => {
    let fetched = 0;
    const counting = (async (): Promise<Response> => { fetched += 1; return bytesResponse(WASM); }) as unknown as typeof fetch;
    const source = new HttpArtifactSource('https://cdn.example/artifacts', { manifest, fetchFn: counting });
    await expect(source.resolve(SHAPE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortedError);
    expect(fetched).toBe(0);
  });

  it('HttpArtifactSource times out a stalled download instead of hanging the proof forever', async () => {
    const source = new HttpArtifactSource('https://cdn.example/artifacts', { manifest, fetchFn: hangingFetch(), timeoutMs: 20 });
    await expect(source.resolve(SHAPE)).rejects.toThrow(/timed out after 20 ms/);
  });

  it('FilesystemArtifactSource rejects an aborted resolve with AbortedError', async () => {
    const source = new FilesystemArtifactSource(baseDir);
    await expect(source.resolve(SHAPE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortedError);
  });

  describe('default fetch `this` binding', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('does not throw Illegal invocation when the global fetch is receiver-checked (browser)', async () => {
      // WHY: same Web IDL receiver-check as IndexerEventSource — native browser `fetch` throws
      // `Illegal invocation` when called as a method (`this.fetchFn(url)`). This exercises the DEFAULT
      // branch (`options.fetchFn ?? fetch`) with a browser-faithful guarded fetch. The injected-fetch
      // tests above miss it because Node/undici does not brand-check the receiver.
      const guarded = function (this: unknown, url: string): Promise<Response> {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        }
        if (url.endsWith('main_1x1.wasm')) return Promise.resolve(bytesResponse(WASM));
        if (url.endsWith('final.zkey')) return Promise.resolve(bytesResponse(ZKEY));
        return Promise.resolve(bytesResponse(VKEY_BYTES));
      };
      vi.stubGlobal('fetch', guarded);

      // No injected fetchFn → the source falls back to the global fetch it must call receiver-safely.
      const source = new HttpArtifactSource('https://cdn.example/artifacts', { dangerouslySkipIntegrity: true });
      const set = await source.resolve(SHAPE);
      expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    });

    it('does not throw Illegal invocation when a bare receiver-checked fetch is INJECTED (e.g. window.fetch)', async () => {
      // WHY: wrapping only the default branch would let a browser consumer reintroduce the bug with the
      // most natural call — `fetchFn: window.fetch`. The source must wrap the injected fetch too.
      const guarded = function (this: unknown, url: string): Promise<Response> {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        }
        if (url.endsWith('main_1x1.wasm')) return Promise.resolve(bytesResponse(WASM));
        if (url.endsWith('final.zkey')) return Promise.resolve(bytesResponse(ZKEY));
        return Promise.resolve(bytesResponse(VKEY_BYTES));
      };

      const source = new HttpArtifactSource('https://cdn.example/artifacts', {
        dangerouslySkipIntegrity: true,
        fetchFn: guarded as typeof fetch,
      });
      const set = await source.resolve(SHAPE);
      expect(Array.from(set.wasm)).toEqual(Array.from(WASM));
    });
  });
});
