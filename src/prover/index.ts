// ABOUTME: Prover + artifact contracts (SPEC §4.5) — worker-first Groth16, injected artifact source.
// ABOUTME: snarkjs + WASM load inside the worker; a same-thread fallback exists for tests. FROZEN.

/** Circuit shape = (input count, output count) → selects the compiled artifact set. */
export interface CircuitShape {
  readonly nullifiers: number;
  readonly commitments: number;
}

export interface ArtifactSet {
  readonly wasm: Uint8Array;
  readonly zkey: Uint8Array;
  readonly vkey: object;
  /**
   * The RAW vkey.json bytes, when the source can provide them. Integrity hashes the raw bytes (the
   * parsed `vkey` object can't be re-serialized canonically), so the manifest can cover the vkey too.
   * Optional for backward compatibility — a source that omits it simply skips the vkey integrity check.
   */
  readonly vkeyRaw?: Uint8Array;
}

/**
 * Resolves `(shape) → {wasm, zkey, vkey}` from `armada-circuits/build/` — filesystem (node) or
 * HTTP `/artifacts/` + IndexedDB cache (browser). SHA-256 manifest checked on load
 * (`ArtifactIntegrityError`). No IPFS, no hash whitelist, no `overrideArtifact`.
 */
export interface ArtifactSource {
  resolve(shape: CircuitShape): Promise<ArtifactSet>;
}

export interface ProofProgress {
  readonly phase: string;
  readonly fraction: number;
}

export interface Groth16Proof {
  readonly a: [string, string];
  readonly b: [[string, string], [string, string]];
  readonly c: [string, string];
}

export interface ProveOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: ProofProgress) => void;
}

/**
 * Worker-based prover. `prove()` runs off the main thread; real progress events replace the
 * `yieldToPaint()` hack. `verify()` is available for tests + preflight self-checks.
 */
export interface ProverAdapter {
  prove(formattedInputs: unknown, artifacts: ArtifactSet, options?: ProveOptions): Promise<Groth16Proof>;
  verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean>;
  close(): Promise<void>;
}

// Artifact integrity.
export { verifyArtifactIntegrity, VerifiedArtifactSource, shapeKey, artifactDigest } from './manifest';
export type { ArtifactDigest, ArtifactManifest } from './manifest';

// snarkjs Groth16 provers — same-thread (node/tests) + worker protocol/adapter (off-main-thread).
export { createSnarkjsProver } from './snarkjs-prover';
export { createWorkerProver, createProverWorkerHandler, webWorkerChannel } from './worker-prover';
export type { WorkerChannel, ProverWorkerRequest, ProverWorkerReply, BrowserWorkerLike } from './worker-prover';

// Concrete artifact sources — resolve compiled circuit artifacts by shape (filesystem / HTTP).
export { FilesystemArtifactSource, HttpArtifactSource } from './artifact-source';
// IndexedDB artifact cache (browser) — wrap a source so the zkey is downloaded once, not per proof.
export { IndexedDbArtifactCache } from './artifact-cache';
