// ABOUTME: Concrete ArtifactSource implementations (SPEC §4.5) — resolve compiled circuit artifacts by
// ABOUTME: shape from a local directory (node) or over HTTP (browser), matching armada-circuits/build layout.

import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';
import { verifyArtifactIntegrity, type ArtifactManifest } from './manifest';

function shapeDir(shape: CircuitShape): string {
  return `${shape.nullifiers}x${shape.commitments}`;
}

// Relative paths within a shape's build directory (armada-circuits/build/<N>x<M>/).
function artifactPaths(shape: CircuitShape): { wasm: string; zkey: string; vkey: string } {
  const key = shapeDir(shape);
  return { wasm: `${key}/main_${key}_js/main_${key}.wasm`, zkey: `${key}/final.zkey`, vkey: `${key}/vkey.json` };
}

/**
 * Resolve artifacts from a local `armada-circuits/build/` directory (node). `node:fs` is imported
 * lazily so this module stays bundlable for browser entry points that never call it.
 */
export class FilesystemArtifactSource implements ArtifactSource {
  constructor(private readonly baseDir: string) {}

  async resolve(shape: CircuitShape): Promise<ArtifactSet> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const p = artifactPaths(shape);
    const [wasm, zkey, vkeyBytes] = await Promise.all([
      fs.readFile(path.join(this.baseDir, p.wasm)),
      fs.readFile(path.join(this.baseDir, p.zkey)),
      fs.readFile(path.join(this.baseDir, p.vkey)),
    ]);
    // Keep the raw vkey bytes (for the manifest integrity check) and parse the object from them.
    const vkeyRaw = new Uint8Array(vkeyBytes);
    return { wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey), vkey: JSON.parse(new TextDecoder().decode(vkeyRaw)) as object, vkeyRaw };
  }
}

/**
 * Construction options for `HttpArtifactSource`. The union is deliberate: a caller must EITHER supply
 * a `manifest` (the SHA-256 integrity check runs on every resolve) OR explicitly acknowledge the risk
 * with `dangerouslySkipIntegrity: true`. There is no unverified default — an HTTP origin feeds the
 * circuit wasm/zkey that receive the full private witness, so skipping integrity must be a conscious,
 * greppable decision, not the path of least resistance (SPEC §4.5).
 */
export type HttpArtifactSourceOptions =
  | { readonly manifest: ArtifactManifest; readonly fetchFn?: typeof fetch }
  | { readonly dangerouslySkipIntegrity: true; readonly fetchFn?: typeof fetch };

/**
 * Resolve artifacts over HTTP (browser/node) from a base URL serving the same `<N>x<M>/...` layout.
 * Verifies each resolved wasm/zkey against the supplied manifest by default (fail-closed); pass a
 * pinned manifest (a build-time trust anchor), NOT one fetched from the same origin as the artifacts,
 * or the check is self-referential. `fetchFn` defaults to the global `fetch`. Add an IndexedDB cache
 * in the app layer.
 */
export class HttpArtifactSource implements ArtifactSource {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly manifest: ArtifactManifest | undefined;

  constructor(baseUrl: string, options: HttpArtifactSourceOptions) {
    this.baseUrl = baseUrl;
    // Wrap the fetch — default OR injected — so `this.fetchFn(url)` (a method call) never runs the
    // underlying fetch with `this === this instance`. Browser `fetch` brand-checks its receiver and
    // throws `Illegal invocation` for a non-global `this`; wrapping the injected fn too keeps a consumer
    // passing a bare `window.fetch` from reintroducing the bug. The default branch resolves the global
    // at call time, so it survives a later reassignment of the global fetch.
    const injected = options.fetchFn;
    this.fetchFn = injected
      ? (...args: Parameters<typeof fetch>) => injected(...args)
      : (...args: Parameters<typeof fetch>) => fetch(...args);
    this.manifest = 'manifest' in options ? options.manifest : undefined;
  }

  async resolve(shape: CircuitShape): Promise<ArtifactSet> {
    const p = artifactPaths(shape);
    const base = this.baseUrl.replace(/\/$/, '');
    const [wasmRes, zkeyRes, vkeyRes] = await Promise.all([
      this.fetchFn(`${base}/${p.wasm}`),
      this.fetchFn(`${base}/${p.zkey}`),
      this.fetchFn(`${base}/${p.vkey}`),
    ]);
    for (const [name, res] of [['wasm', wasmRes], ['zkey', zkeyRes], ['vkey', vkeyRes]] as const) {
      if (!res.ok) {
        throw new Error(`HttpArtifactSource: ${name} fetch failed (${res.status}) for shape ${shapeDir(shape)}`);
      }
    }
    // Read the vkey as raw bytes (not `.json()`) so its SHA-256 can be verified against the manifest;
    // parse the object from those same bytes.
    const vkeyRaw = new Uint8Array(await vkeyRes.arrayBuffer());
    const set: ArtifactSet = {
      wasm: new Uint8Array(await wasmRes.arrayBuffer()),
      zkey: new Uint8Array(await zkeyRes.arrayBuffer()),
      vkey: JSON.parse(new TextDecoder().decode(vkeyRaw)) as object,
      vkeyRaw,
    };
    // Fail-closed integrity: unless the caller explicitly opted out at construction, a wasm/zkey whose
    // SHA-256 doesn't match the pinned manifest throws ArtifactIntegrityError before it reaches the prover.
    if (this.manifest !== undefined) verifyArtifactIntegrity(shape, set, this.manifest);
    return set;
  }
}
