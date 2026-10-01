// ABOUTME: FilesystemArtifactSource (SPEC §4.5, Node-only) — resolves compiled circuit artifacts by shape from a local
// ABOUTME: armada-circuits/build directory, verified against a pinned manifest unless integrity is explicitly skipped.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactResolveOptions, ArtifactSet, ArtifactSource, CircuitShape } from '../prover/index';
import { verifyArtifactIntegrity, type ArtifactManifest } from '../prover/manifest';
import { artifactPaths } from '../prover/artifact-source';
import { AbortedError } from '../errors';

/**
 * Construction options for `FilesystemArtifactSource`. As with `HttpArtifactSource`, a caller must EITHER
 * supply a pinned `manifest` (the SHA-256 integrity check runs on every resolve) OR explicitly opt out with
 * `dangerouslySkipIntegrity: true` — the circuit wasm/zkey receive the full private witness, so skipping
 * the check must be a conscious, greppable decision.
 */
export type FilesystemArtifactSourceOptions =
  | { readonly manifest: ArtifactManifest }
  | { readonly dangerouslySkipIntegrity: true };

/**
 * Resolve artifacts from a local `armada-circuits/build/` directory (Node). A resolve rejects with
 * `AbortedError` when its `signal` aborts, and with `ArtifactIntegrityError` when the files don't match the
 * manifest.
 */
export class FilesystemArtifactSource implements ArtifactSource {
  private readonly manifest: ArtifactManifest | undefined;

  constructor(
    private readonly baseDir: string,
    options: FilesystemArtifactSourceOptions,
  ) {
    this.manifest = 'manifest' in options ? options.manifest : undefined;
  }

  async resolve(shape: CircuitShape, options?: ArtifactResolveOptions): Promise<ArtifactSet> {
    const signal = options?.signal;
    if (signal?.aborted) throw new AbortedError('artifact resolve: aborted before start');
    const p = artifactPaths(shape);
    const read = (file: string): Promise<Buffer> => readFile(join(this.baseDir, file), signal !== undefined ? { signal } : {});
    let wasm: Buffer, zkey: Buffer, vkeyBytes: Buffer;
    try {
      [wasm, zkey, vkeyBytes] = await Promise.all([read(p.wasm), read(p.zkey), read(p.vkey)]);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError('artifact resolve: aborted', { cause: err });
      throw err;
    }
    // Keep the raw vkey bytes (for the manifest integrity check) and parse the object from them.
    const vkeyRaw = new Uint8Array(vkeyBytes);
    const set: ArtifactSet = {
      wasm: new Uint8Array(wasm),
      zkey: new Uint8Array(zkey),
      vkey: JSON.parse(new TextDecoder().decode(vkeyRaw)) as object,
      vkeyRaw,
    };
    if (this.manifest !== undefined) verifyArtifactIntegrity(shape, set, this.manifest);
    return set;
  }
}
