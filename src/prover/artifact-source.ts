// ABOUTME: Concrete ArtifactSource implementations (SPEC §4.5) — resolve compiled circuit artifacts by
// ABOUTME: shape from a local directory (node) or over HTTP (browser), matching armada-circuits/build layout.

import type { ArtifactResolveOptions, ArtifactSet, ArtifactSource, CircuitShape } from './index';
import { verifyArtifactIntegrity, type ArtifactManifest } from './manifest';
import { AbortedError } from '../errors';

/** How long `HttpArtifactSource` waits for one shape's artifacts to download before giving up. */
const DEFAULT_HTTP_TIMEOUT_MS = 120_000;

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

  async resolve(shape: CircuitShape, options?: ArtifactResolveOptions): Promise<ArtifactSet> {
    const signal = options?.signal;
    if (signal?.aborted) throw new AbortedError('artifact resolve: aborted before start');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const p = artifactPaths(shape);
    const read = (file: string): Promise<Buffer> => fs.readFile(path.join(this.baseDir, file), signal !== undefined ? { signal } : {});
    let wasm: Buffer, zkey: Buffer, vkeyBytes: Buffer;
    try {
      [wasm, zkey, vkeyBytes] = await Promise.all([read(p.wasm), read(p.zkey), read(p.vkey)]);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError('artifact resolve: aborted', { cause: err });
      throw err;
    }
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
export type HttpArtifactSourceOptions = (
  | { readonly manifest: ArtifactManifest }
  | { readonly dangerouslySkipIntegrity: true }
) & {
  readonly fetchFn?: typeof fetch;
  /** Give up on a shape's download after this long (default 120 000 ms), so a stalled origin can't hang a proof. */
  readonly timeoutMs?: number;
};

/**
 * Resolve artifacts over HTTP (browser/node) from a base URL serving the same `<N>x<M>/...` layout.
 * Verifies each resolved wasm/zkey against the supplied manifest by default (fail-closed); pass a
 * pinned manifest (a build-time trust anchor), NOT one fetched from the same origin as the artifacts,
 * or the check is self-referential. `fetchFn` defaults to the global `fetch`. A resolve rejects with
 * `AbortedError` when its `signal` aborts, and with an error after `timeoutMs` if the download stalls.
 * Wrap it in an `IndexedDbArtifactCache` (browser) so the zkey is downloaded once, not per proof.
 */
export class HttpArtifactSource implements ArtifactSource {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly manifest: ArtifactManifest | undefined;
  private readonly timeoutMs: number;

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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  async resolve(shape: CircuitShape, options?: ArtifactResolveOptions): Promise<ArtifactSet> {
    const callerSignal = options?.signal;
    if (callerSignal?.aborted) throw new AbortedError('artifact resolve: aborted before start');
    // One signal bounds the whole download (responses AND bodies): the caller's cancel, or the timeout.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal !== undefined ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let set: ArtifactSet;
    try {
      set = await this.download(shape, signal);
    } catch (err) {
      if (callerSignal?.aborted) throw new AbortedError('artifact resolve: aborted', { cause: err });
      if (timeout.aborted) {
        throw new Error(`HttpArtifactSource: download for shape ${shapeDir(shape)} timed out after ${this.timeoutMs} ms`, { cause: err });
      }
      throw err;
    }
    // Fail-closed integrity: unless the caller explicitly opted out at construction, a wasm/zkey whose
    // SHA-256 doesn't match the pinned manifest throws ArtifactIntegrityError before it reaches the prover.
    if (this.manifest !== undefined) verifyArtifactIntegrity(shape, set, this.manifest);
    return set;
  }

  private async download(shape: CircuitShape, signal: AbortSignal): Promise<ArtifactSet> {
    const p = artifactPaths(shape);
    const base = this.baseUrl.replace(/\/$/, '');
    const [wasmRes, zkeyRes, vkeyRes] = await Promise.all([
      this.fetchFn(`${base}/${p.wasm}`, { signal }),
      this.fetchFn(`${base}/${p.zkey}`, { signal }),
      this.fetchFn(`${base}/${p.vkey}`, { signal }),
    ]);
    for (const [name, res] of [['wasm', wasmRes], ['zkey', zkeyRes], ['vkey', vkeyRes]] as const) {
      if (!res.ok) {
        throw new Error(`HttpArtifactSource: ${name} fetch failed (${res.status}) for shape ${shapeDir(shape)}`);
      }
    }
    // Read the vkey as raw bytes (not `.json()`) so its SHA-256 can be verified against the manifest;
    // parse the object from those same bytes.
    const vkeyRaw = new Uint8Array(await vkeyRes.arrayBuffer());
    return {
      wasm: new Uint8Array(await wasmRes.arrayBuffer()),
      zkey: new Uint8Array(await zkeyRes.arrayBuffer()),
      vkey: JSON.parse(new TextDecoder().decode(vkeyRaw)) as object,
      vkeyRaw,
    };
  }
}
