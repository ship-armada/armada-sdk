// ABOUTME: Same-thread snarkjs Groth16 ProverAdapter (SPEC §4.5) — the fallback backend used by node +
// ABOUTME: tests. Lazy-loads snarkjs; close() terminates its bn128 curve workers (else the process hangs).

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions } from './index';
import { toGroth16Proof, toSnarkjsProof, type SnarkjsProof } from './groth16-format';
import { AbortedError } from '../errors';

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

// The share of a proof's `fraction` given to witness calculation; Groth16 proving covers the rest, so
// progress runs 0→1 once across both phases.
const WITNESS_SHARE = 0.5;

// snarkjs builds ONE bn128 curve (with its worker threads) and caches it on `globalThis.curve_bn128` for
// every prover in the process, so one prover's close() must not terminate it under another's proof.
// Count open provers and in-flight operations module-wide; the curve is terminated once both are zero.
let openProvers = 0;
let activeOperations = 0;

async function terminateCurveIfIdle(): Promise<void> {
  if (openProvers > 0 || activeOperations > 0) return;
  const curve = (globalThis as unknown as { curve_bn128?: { terminate?: () => Promise<void> } | null }).curve_bn128;
  if (curve && typeof curve.terminate === 'function') {
    await curve.terminate();
  }
}

// Run one curve-using operation, counted so a concurrent close() leaves the curve up until it finishes.
async function withCurve<T>(operation: () => Promise<T>): Promise<T> {
  activeOperations += 1;
  try {
    return await operation();
  } finally {
    activeOperations -= 1;
    await terminateCurveIfIdle();
  }
}

function throwIfAborted(signal: AbortSignal | undefined, when: string): void {
  if (signal?.aborted) throw new AbortedError(`prove: aborted ${when}`);
}

/**
 * A same-thread `ProverAdapter` backed by snarkjs. Suitable for node + tests and as the constrained-env
 * fallback; the Web Worker / worker_threads wrapper reuses this proving core off the main thread.
 * `close()` MUST be called — snarkjs leaves bn128 curve worker threads alive that otherwise hang exit.
 * The curve is shared process-wide, so it is terminated only when the LAST open prover closes and no
 * proof or verification is still running.
 *
 * A proof can't be interrupted inside a phase: an aborted `signal` is honoured before proving starts and
 * at each phase boundary (after witness calculation, after proving), throwing `AbortedError`.
 */
export function createSnarkjsProver(): ProverAdapter {
  openProvers += 1;
  let closed = false;
  return {
    async prove(
      formattedInputs: unknown,
      artifacts: ArtifactSet,
      options?: ProveOptions,
    ): Promise<Groth16Proof> {
      const signal = options?.signal;
      throwIfAborted(signal, 'before start');
      return withCurve(async () => {
        const snarkjs = await loadSnarkjs();
        // Two real phases (SPEC §4.5): witness calculation, then Groth16 proving. Splitting `fullProve`
        // into `wtns.calculate` + `groth16.prove` gives a deterministic phase boundary (witness done is a
        // meaningful milestone for a large circuit) instead of the old start/end-only `proving` signal.
        const wtns: { type: 'mem' } = { type: 'mem' };
        options?.onProgress?.({ phase: 'witness', fraction: 0 });
        await snarkjs.wtns.calculate(formattedInputs, artifacts.wasm, wtns);
        options?.onProgress?.({ phase: 'witness', fraction: WITNESS_SHARE });
        throwIfAborted(signal, 'after witness calculation');
        options?.onProgress?.({ phase: 'proving', fraction: WITNESS_SHARE });
        const { proof } = await snarkjs.groth16.prove(artifacts.zkey, wtns);
        throwIfAborted(signal, 'after proving');
        options?.onProgress?.({ phase: 'proving', fraction: 1 });
        // No self-check here: `prove()` (SPEC §4.6) verifies every proof against the public signals of
        // the calldata it builds, for any prover backend.
        return toGroth16Proof(proof);
      });
    },

    async verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean> {
      return withCurve(async () => {
        const snarkjs = await loadSnarkjs();
        return snarkjs.groth16.verify(vkey, publicSignals.map((s) => s.toString()), toSnarkjsProof(proof));
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      openProvers -= 1;
      await terminateCurveIfIdle();
    },
  };
}
