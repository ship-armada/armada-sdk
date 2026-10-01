// ABOUTME: HttpArtifactSource (SPEC §4.5) — resolves compiled circuit artifacts by shape over HTTP, matching the
// ABOUTME: armada-circuits/build layout. The Node filesystem source lives in src/node (the `@armada/sdk/node` entry).

import type { ArtifactResolveOptions, ArtifactSet, ArtifactSource, CircuitShape } from './index';
import { verifyArtifactIntegrity, type ArtifactManifest } from './manifest';
import { AbortedError } from '../errors';

/** How long `HttpArtifactSource` waits for one shape's artifacts to download before giving up. */
const DEFAULT_HTTP_TIMEOUT_MS = 120_000;

export function shapeDir(shape: CircuitShape): string {
  return `${shape.nullifiers}x${shape.commitments}`;
}

/** Relative paths within a shape's build directory (armada-circuits/build/<N>x<M>/). */
export function artifactPaths(shape: CircuitShape): { wasm: string; zkey: string; vkey: string } {
  const key = shapeDir(shape);
  return { wasm: `${key}/main_${key}_js/main_${key}.wasm`, zkey: `${key}/final.zkey`, vkey: `${key}/vkey.json` };
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
