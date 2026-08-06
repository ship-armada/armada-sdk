// ABOUTME: Concrete ArtifactSource implementations (SPEC §4.5) — resolve compiled circuit artifacts by
// ABOUTME: shape from a local directory (node) or over HTTP (browser), matching armada-circuits/build layout.

import type { ArtifactSet, ArtifactSource, CircuitShape } from './index';

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
    const [wasm, zkey, vkeyRaw] = await Promise.all([
      fs.readFile(path.join(this.baseDir, p.wasm)),
      fs.readFile(path.join(this.baseDir, p.zkey)),
      fs.readFile(path.join(this.baseDir, p.vkey), 'utf8'),
    ]);
    return { wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey), vkey: JSON.parse(vkeyRaw) as object };
  }
}

/**
 * Resolve artifacts over HTTP (browser/node) from a base URL serving the same `<N>x<M>/...` layout.
 * `fetchFn` defaults to the global `fetch`; inject one for tests or a custom transport. Pair with
 * `VerifiedArtifactSource` to check the SHA-256 manifest, and add an IndexedDB cache in the app layer.
 */
export class HttpArtifactSource implements ArtifactSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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
    return {
      wasm: new Uint8Array(await wasmRes.arrayBuffer()),
      zkey: new Uint8Array(await zkeyRes.arrayBuffer()),
      vkey: (await vkeyRes.json()) as object,
    };
  }
}
