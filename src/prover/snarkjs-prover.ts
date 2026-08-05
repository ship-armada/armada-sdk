// ABOUTME: Same-thread snarkjs Groth16 ProverAdapter (SPEC §4.5) — the fallback backend used by node +
// ABOUTME: tests. Lazy-loads snarkjs; close() terminates its bn128 curve workers (else the process hangs).

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions } from './index';

// snarkjs ships no types — model just the Groth16 surface we use.
interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}
interface Groth16Backend {
  fullProve(
    input: unknown,
    wasm: Uint8Array,
    zkey: Uint8Array,
    logger?: unknown,
  ): Promise<{ proof: SnarkjsProof; publicSignals: string[] }>;
  verify(vkey: object, publicSignals: string[], proof: SnarkjsProof): Promise<boolean>;
}

async function loadGroth16(): Promise<Groth16Backend> {
  const mod = (await import('snarkjs')) as unknown as { groth16: Groth16Backend };
  return mod.groth16;
}

// snarkjs proof → the frozen 2-coordinate Groth16Proof (drops the homogeneous "1"/"[1,0]" coords).
// The on-chain G2 coordinate swap is a calldata-serialization concern, applied in the tx layer.
function toGroth16Proof(p: SnarkjsProof): Groth16Proof {
  return {
    a: [p.pi_a[0]!, p.pi_a[1]!],
    b: [
      [p.pi_b[0]![0]!, p.pi_b[0]![1]!],
      [p.pi_b[1]![0]!, p.pi_b[1]![1]!],
    ],
    c: [p.pi_c[0]!, p.pi_c[1]!],
  };
}

// Reconstruct the snarkjs proof (restoring the homogeneous coordinates) so snarkjs.verify accepts it.
function toSnarkjsProof(p: Groth16Proof): SnarkjsProof {
  return {
    pi_a: [p.a[0], p.a[1], '1'],
    pi_b: [[p.b[0][0], p.b[0][1]], [p.b[1][0], p.b[1][1]], ['1', '0']],
    pi_c: [p.c[0], p.c[1], '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
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
        throw new Error('prove: aborted before start');
      }
      const groth16 = await loadGroth16();
      // snarkjs has no fine-grained progress hook; emit coarse start/end phases (replaces yieldToPaint).
      options?.onProgress?.({ phase: 'proving', fraction: 0 });
      const { proof } = await groth16.fullProve(formattedInputs, artifacts.wasm, artifacts.zkey);
      options?.onProgress?.({ phase: 'proving', fraction: 1 });
      return toGroth16Proof(proof);
    },

    async verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean> {
      const groth16 = await loadGroth16();
      return groth16.verify(vkey, publicSignals.map((s) => s.toString()), toSnarkjsProof(proof));
    },

    async close(): Promise<void> {
      const curve = (globalThis as unknown as { curve_bn128?: { terminate?: () => Promise<void> } }).curve_bn128;
      if (curve && typeof curve.terminate === 'function') {
        await curve.terminate();
      }
    },
  };
}
