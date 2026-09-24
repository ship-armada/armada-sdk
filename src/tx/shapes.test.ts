// ABOUTME: Tests for the shape-support model — the primitive the shape-aware spend planner uses to land
// ABOUTME: every proof-group on a registered circuit shape (sparse table; input-count depends on output-count).

import { describe, it, expect } from 'vitest';
import { parseShapeKey, isSupportedShape, maxSupportedInputCount } from './shapes';
import { shapeKey } from '../prover/index';

// The armada-circuits v0.1.0-dev registered set (19 shapes). Deliberately SPARSE: valid input-count N
// depends on output-count M — e.g. no 5x3, no 7x2, and M=4 exists only at N=8.
const SUPPORTED = new Set([
  '1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
  '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4',
]);

describe('parseShapeKey', () => {
  it('parses unpadded NxM keys', () => {
    expect(parseShapeKey('5x2')).toEqual({ n: 5, m: 2 });
    expect(parseShapeKey('8x4')).toEqual({ n: 8, m: 4 });
  });
});

describe('isSupportedShape', () => {
  it('matches the registered set, rejects the gaps', () => {
    expect(isSupportedShape(SUPPORTED, 5, 2)).toBe(true);
    expect(isSupportedShape(SUPPORTED, 8, 4)).toBe(true);
    expect(isSupportedShape(SUPPORTED, 5, 3)).toBe(false); // the prod-404 gap
    expect(isSupportedShape(SUPPORTED, 7, 2)).toBe(false);
    expect(isSupportedShape(SUPPORTED, 8, 2)).toBe(false);
  });
});

describe('isSupportedShape key format', () => {
  it('uses the prover manifest key format (shapeKey), so the two cannot diverge', () => {
    const only = new Set([shapeKey({ nullifiers: 3, commitments: 2 })]);
    expect(isSupportedShape(only, 3, 2)).toBe(true);
    expect(isSupportedShape(only, 2, 3)).toBe(false);
  });
});

describe('maxSupportedInputCount', () => {
  it('returns the largest registered input count (bounds a split group\'s size)', () => {
    expect(maxSupportedInputCount(SUPPORTED)).toBe(8);
    expect(maxSupportedInputCount(new Set(['1x1', '4x2']))).toBe(4);
  });

  it('returns 0 for an empty set', () => {
    expect(maxSupportedInputCount(new Set())).toBe(0);
  });
});
