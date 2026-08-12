// ABOUTME: Same-thread snarkjs Groth16 ProverAdapter (SPEC §4.5) — the fallback backend used by node +
// ABOUTME: tests. Lazy-loads snarkjs; close() terminates its bn128 curve workers (else the process hangs).

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions } from './index';
import { toGroth16Proof, toSnarkjsProof, type SnarkjsProof } from './groth16-format';
import { ProofVerificationError, AbortedError } from '../errors';

// snarkjs ships no types — model just the surface we use. We drive witness-calculation and proving as
// SEPARATE steps (not `fullProve`) so we can emit a real witness→proving phase boundary for progress.
interface SnarkjsBackend {
  readonly wtns: { calculate(input: unknown, wasm: Uint8Array, wtns: object): Promise<void> };
  readonly groth16: {
    prove(zkey: Uint8Array, wtns: object): Promise<{ proof: SnarkjsProof; publicSignals: string[] }>;
    verify(vkey: object, publicSignals: string[], proof: SnarkjsProof): Promise<boolean>;
  };
}

async function loadSnarkjs(): Promise<SnarkjsBackend> {
  return (await import('snarkjs')) as unknown as SnarkjsBackend;
}

/**
 * A same-thread `ProverAdapter` backed by snarkjs. Suitable for node + tests and as the constrained-env
 * fallback; the Web Worker / worker_threads wrapper reuses this proving core off the main thread.
 * `close()` MUST be called — snarkjs leaves bn128 curve worker threads alive that otherwise hang exit.
 */
export function createSnarkjsProver(): ProverAdapter {
  return {
    async prove(
      formattedInputs: unknown,
      artifacts: ArtifactSet,
      options?: ProveOptions,
    ): Promise<Groth16Proof> {
      if (options?.signal?.aborted) {
        throw new AbortedError('prove: aborted before start');
      }
      const snarkjs = await loadSnarkjs();
      // Two real phases (SPEC §4.5): witness calculation, then Groth16 proving. Splitting `fullProve`
      // into `wtns.calculate` + `groth16.prove` gives a deterministic phase boundary (witness done is a
      // meaningful milestone for a large circuit) instead of the old start/end-only `proving` signal.
      const wtns: { type: 'mem' } = { type: 'mem' };
      options?.onProgress?.({ phase: 'witness', fraction: 0 });
      await snarkjs.wtns.calculate(formattedInputs, artifacts.wasm, wtns);
      options?.onProgress?.({ phase: 'witness', fraction: 1 });
      options?.onProgress?.({ phase: 'proving', fraction: 0 });
      const { proof, publicSignals } = await snarkjs.groth16.prove(artifacts.zkey, wtns);
      options?.onProgress?.({ phase: 'proving', fraction: 1 });
      // Local self-check (SPEC §4.5): verify the fresh proof against its own vkey before returning, so a
      // proof that would revert on-chain (a witness-assembly or corrupted-artifact bug) is a typed error
      // now, not a failed tx after ~30s. Guarded on vkey presence — the worker path forwards only
      // wasm/zkey (it self-checks in-worker where the full artifact set is available).
      const vkey = (artifacts as { vkey?: object }).vkey;
      if (vkey !== undefined) {
        let ok = false;
        try {
          ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
        } catch (err) {
          throw new ProofVerificationError('local proof self-check errored', { cause: err });
        }
        if (!ok) throw new ProofVerificationError('generated proof failed local vkey verification');
      }
      return toGroth16Proof(proof);
    },

    async verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean> {
      const snarkjs = await loadSnarkjs();
      return snarkjs.groth16.verify(vkey, publicSignals.map((s) => s.toString()), toSnarkjsProof(proof));
    },

    async close(): Promise<void> {
      const curve = (globalThis as unknown as { curve_bn128?: { terminate?: () => Promise<void> } }).curve_bn128;
      if (curve && typeof curve.terminate === 'function') {
        await curve.terminate();
      }
    },
  };
}
