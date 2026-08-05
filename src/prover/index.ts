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
export { verifyArtifactIntegrity, VerifiedArtifactSource, shapeKey } from './manifest';
export type { ArtifactDigest, ArtifactManifest } from './manifest';

// Same-thread snarkjs Groth16 prover (node/tests + the worker's proving core).
export { createSnarkjsProver } from './snarkjs-prover';
