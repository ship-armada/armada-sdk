// ABOUTME: Pure shape-support model over the deployment's registered circuit shapes (`NxM` keys). The
// ABOUTME: shape-aware spend planner uses it to land every proof-group on a shape the pool has a verifier for.

import { shapeKey } from '../prover/index';

/**
 * The Armada circuit set is SPARSE and the valid input-count N depends on the output-count M (unlike
 * Railgun's dense 1..10 × 1..5). We also cannot pad inputs (the circuit Merkle-proves every input, no
 * dummy bypass) — only outputs (zero-value commitments are legal). These helpers encode both facts so
 * the planner never emits a shape the on-chain `VerifierModule` would reject with `Key not set`.
 *
 * Keys are the SDK's unpadded `shapeKey` format (`${nullifiers}x${commitments}`, e.g. `"5x2"`).
 */

export function parseShapeKey(key: string): { n: number; m: number } {
  const [n = '', m = ''] = key.split('x');
  return { n: parseInt(n, 10), m: parseInt(m, 10) };
}

/** Whether the deployment has a registered circuit for shape (n inputs, m outputs). */
export function isSupportedShape(supported: ReadonlySet<string>, n: number, m: number): boolean {
  return supported.has(shapeKey({ nullifiers: n, commitments: m }));
}

/**
 * The largest input count N of any registered shape (0 for an empty set). Bounds how many notes one
 * split group can spend — no group can exceed it whatever its output count.
 */
export function maxSupportedInputCount(supported: ReadonlySet<string>): number {
  let max = 0;
  for (const key of supported) max = Math.max(max, parseShapeKey(key).n);
  return max;
}
