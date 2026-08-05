// ABOUTME: Unit tests for the bisecting ranged log fetcher — windowing, adaptive bisection on
// ABOUTME: range-limit throws, real-error passthrough, order preservation, and edge ranges.

import { describe, it, expect, vi } from 'vitest';
import { fetchLogsRanged } from './ranged-fetch';

// A fake getLogs returning one "log" per block (the block number), optionally throwing when a
// window exceeds `limit` blocks (simulating a provider range cap).
function fakeGetLogs(limit = Infinity) {
  return vi.fn(async (from: number, to: number): Promise<number[]> => {
    if (to - from + 1 > limit) throw new Error(`query returned more than ${limit} results`);
    const out: number[] = [];
    for (let b = from; b <= to; b += 1) out.push(b);
    return out;
  });
}

describe('fetchLogsRanged', () => {
  it('collects every block across the range, in order', async () => {
    const logs = await fetchLogsRanged(fakeGetLogs(), { fromBlock: 100, toBlock: 250, maxRange: 50 });
    expect(logs).toEqual(Array.from({ length: 151 }, (_, i) => 100 + i));
  });

  it('bisects windows that exceed the provider range limit and still collects all logs', async () => {
    const getLogs = fakeGetLogs(10); // provider rejects any window > 10 blocks
    const logs = await fetchLogsRanged(getLogs, { fromBlock: 0, toBlock: 99, maxRange: 100 });
    expect(logs).toEqual(Array.from({ length: 100 }, (_, i) => i));
    // proves it adapted below the limit
    expect(getLogs.mock.calls.some(([f, t]) => t - f + 1 <= 10)).toBe(true);
  });

  it('re-throws a genuine error that persists at the minimum range', async () => {
    const getLogs = vi.fn(async (from: number, to: number): Promise<number[]> => {
      if (from <= 42 && 42 <= to) throw new Error('boom at block 42');
      const out: number[] = [];
      for (let b = from; b <= to; b += 1) out.push(b);
      return out;
    });
    await expect(
      fetchLogsRanged(getLogs, { fromBlock: 0, toBlock: 99, maxRange: 100 }),
    ).rejects.toThrow('boom at block 42');
  });

  it('returns [] for an empty range (from > to)', async () => {
    const getLogs = fakeGetLogs();
    expect(await fetchLogsRanged(getLogs, { fromBlock: 10, toBlock: 5 })).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('handles a single-block range', async () => {
    expect(await fetchLogsRanged(fakeGetLogs(), { fromBlock: 7, toBlock: 7 })).toEqual([7]);
  });
});
