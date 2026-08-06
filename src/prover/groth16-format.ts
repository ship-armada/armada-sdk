// ABOUTME: snarkjs ↔ Groth16Proof coordinate mapping, shared by the same-thread and worker provers.
// ABOUTME: Drops/restores the homogeneous coords; the on-chain G2 swap is a calldata-layer concern (tx/).

import type { Groth16Proof } from './index';

export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

/** snarkjs proof → the frozen 2-coordinate Groth16Proof (drops the homogeneous "1"/"[1,0]" coords). */
export function toGroth16Proof(p: SnarkjsProof): Groth16Proof {
  return {
    a: [p.pi_a[0]!, p.pi_a[1]!],
    b: [
      [p.pi_b[0]![0]!, p.pi_b[0]![1]!],
      [p.pi_b[1]![0]!, p.pi_b[1]![1]!],
    ],
    c: [p.pi_c[0]!, p.pi_c[1]!],
  };
}

/** Reconstruct the snarkjs proof (restoring the homogeneous coordinates) so snarkjs.verify accepts it. */
export function toSnarkjsProof(p: Groth16Proof): SnarkjsProof {
  return {
    pi_a: [p.a[0], p.a[1], '1'],
    pi_b: [[p.b[0][0], p.b[0][1]], [p.b[1][0], p.b[1][1]], ['1', '0']],
    pi_c: [p.c[0], p.c[1], '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
