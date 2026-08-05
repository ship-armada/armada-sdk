// ABOUTME: Sync contracts (SPEC §4.4) — event scan from RPC building the UTXO merkletree, with a
// ABOUTME: pluggable indexer-backed EventSource (deferred impl) and typed progress/balance events. FROZEN.

/** Raw pool events accumulated over a block range; shapes come from `core`. */
export interface AccumulatedEvents {
  readonly commitmentEvents: readonly unknown[];
  readonly unshieldEvents: readonly unknown[];
  readonly nullifierEvents: readonly unknown[];
}

/**
 * Optional indexer-backed snapshot source (SPEC §4.4, decision #3 — interface now, impl later).
 * RPC scan is always the verification fallback: quick-sync results are verified against on-chain
 * roots before acceptance.
 */
export interface EventSource {
  getEvents(fromBlock: number, toBlock: number): Promise<AccumulatedEvents>;
}

export interface SyncStatus {
  readonly phase: 'idle' | 'scanning' | 'complete' | 'error';
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly syncedThrough: number;
}

/** Typed subscription events — replace the single global `setOnBalanceUpdateCallback` multiplexer. */
export interface SyncEventMap {
  'scan:started': { fromBlock: number; toBlock: number };
  'scan:progress': { syncedThrough: number; fraction: number };
  'scan:complete': { syncedThrough: number };
  'scan:error': { error: Error };
  'balance:updated': { tokenAddress: `0x${string}`; spendable: bigint; pending: bigint };
  /** A new TXO registered for a loaded wallet — SPEC §5.2 (amount, token, memo, sender if disclosed). */
  'note:received': {
    tokenAddress: `0x${string}`;
    value: bigint;
    memo?: string;
    senderRailgunAddress?: string;
  };
}

// Ranged log fetch.
export { fetchLogsRanged } from './ranged-fetch';
export type { GetLogsFn, RangedFetchOptions } from './ranged-fetch';

// Scan checkpoints + resumable scan.
export { CheckpointStore } from './checkpoints';
export type { ScanCheckpoint } from './checkpoints';
export { runScan } from './scan';
export type { ScanOptions, ScanResult } from './scan';

// UTXO merkletree.
export { UTXOMerkletree } from './merkletree';
export type { MerkleProof } from './merkletree';
