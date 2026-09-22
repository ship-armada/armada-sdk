// ABOUTME: Tests for the shape-support model — the primitive the shape-aware spend planner uses to land
// ABOUTME: every proof-group on a registered circuit shape (sparse table; input-count depends on output-count).

import { describe, it, expect } from 'vitest';
import {
  parseShapeKey,
  isSupportedShape,
  supportedInputCounts,
  nextSupportedInputCount,
  padOutputTarget,
} from './shapes';

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

describe('supportedInputCounts', () => {
  it('returns the ascending input counts valid for an output count', () => {
    expect(supportedInputCounts(SUPPORTED, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(supportedInputCounts(SUPPORTED, 2)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(supportedInputCounts(SUPPORTED, 3)).toEqual([1, 2, 3, 4]);
    expect(supportedInputCounts(SUPPORTED, 4)).toEqual([8]);
    expect(supportedInputCounts(SUPPORTED, 5)).toEqual([]);
  });
});

describe('nextSupportedInputCount', () => {
  it('finds the smallest supported N >= minN for an output count', () => {
    expect(nextSupportedInputCount(SUPPORTED, 3, 3)).toBe(3);
    expect(nextSupportedInputCount(SUPPORTED, 5, 2)).toBe(5);
    // M=3 tops out at N=4, so a 5-input group can't be a 3-output shape → caller must split or pad.
    expect(nextSupportedInputCount(SUPPORTED, 5, 3)).toBeUndefined();
    // M=2 tops out at N=6.
    expect(nextSupportedInputCount(SUPPORTED, 7, 2)).toBeUndefined();
    expect(nextSupportedInputCount(SUPPORTED, 7, 1)).toBe(7);
  });
});

describe('padOutputTarget', () => {
  it('finds the smallest supported output count M\' >= minM for a fixed input count (L2 padding)', () => {
    // 8 inputs with 2-3 real outputs pads up to 8x4 (the only M>1 shape at N=8).
    expect(padOutputTarget(SUPPORTED, 8, 2)).toBe(4);
    expect(padOutputTarget(SUPPORTED, 8, 3)).toBe(4);
    // No padding needed when the exact shape exists.
    expect(padOutputTarget(SUPPORTED, 3, 3)).toBe(3);
    expect(padOutputTarget(SUPPORTED, 1, 3)).toBe(3);
    // 5 inputs has no 3+-output shape (only 5x1, 5x2) → can't pad up to reach 3 outputs.
    expect(padOutputTarget(SUPPORTED, 5, 3)).toBeUndefined();
  });
});
