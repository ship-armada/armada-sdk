// ABOUTME: Real Groth16 prove+verify roundtrip for the snarkjs ProverAdapter (§4.5), using a tiny
// ABOUTME: multiplier circuit fixture (c = a*b). Validates proof format, verify, progress, abort, curve sharing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSnarkjsProver } from './snarkjs-prover';
import { AbortedError } from '../errors';
import type { ArtifactSet, ProofProgress } from './index';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/prover/${name}`, import.meta.url));

const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};

describe('snarkjs ProverAdapter (§4.5)', () => {
  it('proves and verifies a real Groth16 proof (c = a*b)', async () => {
    const prover = createSnarkjsProver();
    try {
      const progress: ProofProgress[] = [];
      const proof = await prover.prove({ a: '3', b: '11' }, artifacts, { onProgress: (p) => progress.push(p) });

      // Groth16Proof shape: G1 a (2), G2 b (2x2), G1 c (2).
      expect(proof.a).toHaveLength(2);
      expect(proof.b).toHaveLength(2);
      expect(proof.b[0]).toHaveLength(2);
      expect(proof.c).toHaveLength(2);
      // Real two-phase progress (P4.5), with `fraction` spanning the WHOLE proof: witness 0→0.5, then
      // proving 0.5→1, so a consumer's progress bar never jumps back when the phase changes.
      expect(progress).toEqual([
        { phase: 'witness', fraction: 0 },
        { phase: 'witness', fraction: 0.5 },
        { phase: 'proving', fraction: 0.5 },
        { phase: 'proving', fraction: 1 },
      ]);

      // Public signal is the output c = 3 * 11 = 33.
      expect(await prover.verify(proof, [33n], artifacts.vkey)).toBe(true);
      // A tampered public signal must not verify.
      expect(await prover.verify(proof, [34n], artifacts.vkey)).toBe(false);
    } finally {
      await prover.close();
    }
  });

  it('rejects proving when the abort signal is already set', async () => {
    const prover = createSnarkjsProver();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    } finally {
      await prover.close();
    }
  });

  it('stops at the next phase boundary when the signal aborts during witness calculation', async () => {
    // WHY: snarkjs can't be interrupted mid-phase, but a cancelled proof must not run the (much longer)
    // proving phase nor resolve — the caller asked for AbortedError.
    const prover = createSnarkjsProver();
    try {
      const controller = new AbortController();
      const phases: string[] = [];
      const proving = prover.prove({ a: '3', b: '11' }, artifacts, {
        signal: controller.signal,
        onProgress: (p) => { phases.push(p.phase); if (p.phase === 'witness' && p.fraction === 0) controller.abort(); },
      });
      await expect(proving).rejects.toBeInstanceOf(AbortedError);
      expect(phases).not.toContain('proving');
    } finally {
      await prover.close();
    }
  });

  it('rejects instead of returning a proof when the signal aborts during proving', async () => {
    const prover = createSnarkjsProver();
    try {
      const controller = new AbortController();
      const proving = prover.prove({ a: '3', b: '11' }, artifacts, {
        signal: controller.signal,
        onProgress: (p) => { if (p.phase === 'proving' && p.fraction < 1) controller.abort(); },
      });
      await expect(proving).rejects.toBeInstanceOf(AbortedError);
    } finally {
      await prover.close();
    }
  });

  describe('the process-global bn128 curve shared by same-thread provers', () => {
    const curve = (): unknown => (globalThis as unknown as { curve_bn128?: unknown }).curve_bn128;

    it("closing one prover doesn't terminate the curve under another prover's in-flight proof", async () => {
      // WHY: snarkjs caches ONE curve (with its worker threads) on globalThis for every prover in the
      // process. Terminating it from one SDK instance's close() hung or broke another instance's proof.
      const a = createSnarkjsProver();
      const b = createSnarkjsProver();
      let closingB: Promise<void> | undefined;
      const proof = await a.prove({ a: '3', b: '11' }, artifacts, {
        onProgress: (p) => { if (p.phase === 'proving' && p.fraction < 1) closingB = b.close(); },
      });
      await closingB;
      expect(proof.a).toHaveLength(2);
      expect(curve()).toBeTruthy(); // a is still open — the shared curve stays up
      await a.close();
      expect(curve()).toBeFalsy(); // the last open prover closed — the curve is terminated
    });

    it('closing the last prover mid-proof lets that proof finish, then terminates the curve', async () => {
      const a = createSnarkjsProver();
      let closing: Promise<void> | undefined;
      const proof = await a.prove({ a: '3', b: '11' }, artifacts, {
        onProgress: (p) => { if (p.phase === 'proving' && p.fraction < 1) closing = a.close(); },
      });
      await closing;
      expect(proof.a).toHaveLength(2);
      expect(curve()).toBeFalsy(); // no curve threads left behind to hang process exit
    });
  });
});
