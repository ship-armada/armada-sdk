// ABOUTME: Resumable event-scan orchestrator (SPEC §4.4) — resumes from the persisted checkpoint,
// ABOUTME: ranged-fetches to head, hands decoded events to a caller callback, then advances the checkpoint.

import { fetchLogsRanged, type GetLogsFn } from './ranged-fetch';
import type { CheckpointStore } from './checkpoints';

export interface ScanOptions<T> {
  readonly walletId: string;
  readonly chainId: number;
  /** Block the pool was deployed at — the scan floor when there is no checkpoint yet. */
  readonly deployBlock: number;
  /** Current chain head to scan up to. */
  readonly headBlock: number;
  readonly getLogs: GetLogsFn<T>;
  /** Caller processes fetched events (build merkletree / TXOs). Runs BEFORE the checkpoint advances. */
  readonly onEvents: (events: T[]) => Promise<void>;
  readonly maxRange?: number;
}

export interface ScanResult {
  readonly fromBlock: number;
  readonly syncedThrough: number;
  readonly scanned: boolean;
}

/**
 * Run one incremental scan. Starts at `checkpoint.syncedThrough + 1` (or `deployBlock` on first run),
 * fetches through `headBlock` via the bisecting ranged fetch, invokes `onEvents`, and only then
 * advances the checkpoint — so a crash mid-scan re-fetches the window rather than skipping it.
 */
export async function runScan<T>(
  checkpoints: CheckpointStore,
  options: ScanOptions<T>,
): Promise<ScanResult> {
  const { walletId, chainId, deployBlock, headBlock, getLogs, onEvents, maxRange } = options;

  const existing = await checkpoints.get(walletId, chainId);
  const fromBlock = existing ? existing.syncedThrough + 1 : deployBlock;

  if (fromBlock > headBlock) {
    return { fromBlock, syncedThrough: existing?.syncedThrough ?? deployBlock - 1, scanned: false };
  }

  const rangeOpts = maxRange === undefined
    ? { fromBlock, toBlock: headBlock }
    : { fromBlock, toBlock: headBlock, maxRange };
  const events = await fetchLogsRanged(getLogs, rangeOpts);
  await onEvents(events);
  await checkpoints.set(walletId, chainId, { syncedThrough: headBlock });

  return { fromBlock, syncedThrough: headBlock, scanned: true };
}
