// ABOUTME: Seeded pseudo-random integers for the SDK's randomised tests (mulberry32: 32-bit integer math, so no
// ABOUTME: floating-point precision loss). A fixed seed makes a failing run reproduce exactly.

/**
 * A seeded generator: each call returns an integer in `[0, n)`. mulberry32 keeps every step in 32-bit integer
 * math (`Math.imul`, `| 0`, `>>>`). A classic LCG written as `seed * 1103515245` overflows 2^53, loses its
 * low bits and degenerates (armada-sdk #110), so randomised tests must use this rather than roll their own.
 */
export function seededRandom(seed: number): (n: number) => number {
  let state = seed | 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}
