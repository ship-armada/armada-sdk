// ABOUTME: First-class bisecting ranged log fetch (SPEC §4.4) — replaces the eth_getLogs bisecting
// ABOUTME: currently monkey-patched into ethers. Provider-agnostic: adapts to per-provider range limits.

export type GetLogsFn<T> = (fromBlock: number, toBlock: number) => Promise<T[]>;

export interface RangedFetchOptions {
  readonly fromBlock: number;
  readonly toBlock: number;
  /** Initial window size in blocks (per-provider cap, e.g. 5000 on Sepolia, 100000 local). */
  readonly maxRange?: number;
  /** Smallest window before a throw is treated as a real error rather than a range-limit. */
  readonly minRange?: number;
}

const DEFAULT_MAX_RANGE = 5000;
const DEFAULT_MIN_RANGE = 1;

/**
 * Fetch logs across `[fromBlock, toBlock]` in windows of `maxRange`, bisecting any window whose
 * `getLogs` call throws (a provider range-limit) down to `minRange`. A throw at/below `minRange` is
 * re-thrown as a genuine error (not a range-size issue). Results are returned in block order.
 */
export async function fetchLogsRanged<T>(
  getLogs: GetLogsFn<T>,
  options: RangedFetchOptions,
): Promise<T[]> {
  const { fromBlock, toBlock } = options;
  const maxRange = options.maxRange ?? DEFAULT_MAX_RANGE;
  const minRange = options.minRange ?? DEFAULT_MIN_RANGE;
  if (maxRange < 1) throw new Error('fetchLogsRanged: maxRange must be >= 1');
  if (fromBlock > toBlock) return [];

  const results: T[] = [];
  let windowStart = fromBlock;
  while (windowStart <= toBlock) {
    const windowEnd = Math.min(windowStart + maxRange - 1, toBlock);
    results.push(...(await fetchWindow(getLogs, windowStart, windowEnd, minRange)));
    windowStart = windowEnd + 1;
  }
  return results;
}

async function fetchWindow<T>(
  getLogs: GetLogsFn<T>,
  from: number,
  to: number,
  minRange: number,
): Promise<T[]> {
  try {
    return await getLogs(from, to);
  } catch (error) {
    const span = to - from + 1;
    if (span <= minRange) throw error; // can't split further → a real error, surface it
    const mid = from + Math.floor((to - from) / 2);
    const left = await fetchWindow(getLogs, from, mid, minRange);
    const right = await fetchWindow(getLogs, mid + 1, to, minRange);
    return [...left, ...right];
  }
}
