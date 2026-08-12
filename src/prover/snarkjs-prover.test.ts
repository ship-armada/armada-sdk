// ABOUTME: Real Groth16 prove+verify roundtrip for the snarkjs ProverAdapter (§4.5), using a tiny
// ABOUTME: multiplier circuit fixture (c = a*b). Validates proof format, verify, progress, and abort.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSnarkjsProver } from './snarkjs-prover';
import { ProofVerificationError } from '../errors';
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
      expect(progress.length).toBeGreaterThan(0);

      // Public signal is the output c = 3 * 11 = 33.
      expect(await prover.verify(proof, [33n], artifacts.vkey)).toBe(true);
      // A tampered public signal must not verify.
      expect(await prover.verify(proof, [34n], artifacts.vkey)).toBe(false);
    } finally {
      await prover.close();
    }
  });

  it('rejects a proof that fails its local vkey self-check (SPEC §4.5, P1.4)', async () => {
    // WHY: a witness-assembly or corrupted-artifact bug yields a proof that reverts on-chain after ~30s.
    // The local self-check turns that into an immediate typed error. Simulate it with a mismatched vkey.
    const wrongVkey = JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as { IC: string[][] };
    wrongVkey.IC[0]![0] = (BigInt(wrongVkey.IC[0]![0]!) + 1n).toString(); // corrupt one IC coordinate
    const prover = createSnarkjsProver();
    try {
      await expect(
        prover.prove({ a: '3', b: '11' }, { ...artifacts, vkey: wrongVkey }),
      ).rejects.toBeInstanceOf(ProofVerificationError);
    } finally {
      await prover.close();
    }
  });

  it('rejects proving when the abort signal is already set', async () => {
    const prover = createSnarkjsProver();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal })).rejects.toThrow(/aborted/);
    } finally {
      await prover.close();
    }
  });
});
