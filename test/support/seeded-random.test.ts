// ABOUTME: Tests for seededRandom — reproducible for a seed, and actually spread over its range (the regression
// ABOUTME: armada-sdk #110 guards against: a degenerate generator that only ever produced a few values).

import { describe, it, expect } from 'vitest';
import { seededRandom } from './seeded-random';

describe('seededRandom', () => {
  it('reproduces the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 20 }, () => a(1000))).toEqual(Array.from({ length: 20 }, () => b(1000)));
  });

  it('covers its whole range, evenly, including small ranges and every residue', () => {
    for (const n of [2, 3, 4, 20]) {
      const rand = seededRandom(0x9e3779b9);
      const counts = new Array<number>(n).fill(0);
      const draws = 4000;
      for (let i = 0; i < draws; i += 1) counts[rand(n)]! += 1;
      // Every value appears, and none is more than ±25% off an even share.
      for (const c of counts) {
        expect(c).toBeGreaterThan((draws / n) * 0.75);
        expect(c).toBeLessThan((draws / n) * 1.25);
      }
    }
  });

  it('stays in [0, n)', () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = rand(9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(9);
    }
  });
});
