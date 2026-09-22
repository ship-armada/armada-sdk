// ABOUTME: Pure shape-support model over the deployment's registered circuit shapes (`NxM` keys). The
// ABOUTME: shape-aware spend planner uses it to land every proof-group on a shape the pool has a verifier for.

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
  return supported.has(`${n}x${m}`);
}

/** The input counts N for which `NxM` is supported, ascending. Empty when no shape has M outputs. */
export function supportedInputCounts(supported: ReadonlySet<string>, m: number): number[] {
  const ns: number[] = [];
  for (const key of supported) {
    const parsed = parseShapeKey(key);
    if (parsed.m === m) ns.push(parsed.n);
  }
  return ns.sort((a, b) => a - b);
}

/**
 * The smallest supported input count N ≥ `minN` for output-count `m`, or undefined when none exists
 * (e.g. `m=3` tops out at N=4, so a 5-input group can't be a 3-output shape). Drives multi-group
 * selection: grow a group's inputs to the next reachable valid N, else split.
 */
export function nextSupportedInputCount(
  supported: ReadonlySet<string>,
  minN: number,
  m: number,
): number | undefined {
  for (const n of supportedInputCounts(supported, m)) {
    if (n >= minN) return n;
  }
  return undefined;
}

/**
 * For a FIXED input count `n`, the smallest supported output-count M′ ≥ `minM`, or undefined. Drives
 * zero-value output padding (L2): e.g. an 8-input group with 2–3 real outputs pads up to `8x4` (the
 * only M>1 shape at N=8). Returns `minM` unchanged when the exact shape already exists.
 */
export function padOutputTarget(
  supported: ReadonlySet<string>,
  n: number,
  minM: number,
): number | undefined {
  let best: number | undefined;
  for (const key of supported) {
    const parsed = parseShapeKey(key);
    if (parsed.n === n && parsed.m >= minM && (best === undefined || parsed.m < best)) {
      best = parsed.m;
    }
  }
  return best;
}
