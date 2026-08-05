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

// Wallet scan orchestrator — folds decoded events into trees/TXOs/balances with root verification.
export { WalletScanState, ownedNoteFromTransactNote } from './scan-engine';
export type { WalletDecryptors, Decryptor, OwnedNote, ApplyResult } from './scan-engine';

// UTXO merkletree.
export { UTXOMerkletree } from './merkletree';
export type { MerkleProof } from './merkletree';

// Note ECIES V2 codec — trial-decrypt commitments (scan) + encrypt to a receiver (send).
export {
  encryptNoteToReceiver,
  tryDecryptCommitment,
  createTransferNote,
  DEFAULT_EVM_CHAIN,
} from './note-crypto';

// Shield-note ownership decryption — the scan-side counterpart for shield commitments.
export { tryDecryptShield } from './shield-crypto';
export type {
  CommitmentCiphertextV2,
  SenderNoteKeys,
  ReceiverNoteKeys,
} from './note-crypto';

// Balance aggregation — per-token spendable/pending from the TXO set + spent nullifiers.
export { computeBalances, txoFromNote } from './balances';
export type { TXO, SpentNullifier, TokenBalance, BalanceOptions } from './balances';

// Pool event decoder — Shield/Transact/Nullified args → typed commitments/ciphertexts/nullifiers.
export {
  POOL_V2_EVENT_ABI,
  formatShieldEvent,
  formatTransactEvent,
  formatNullifiedEvent,
  formatCommitmentCiphertext,
  decodePoolEvents,
} from './event-decoder';
export type {
  LogMeta,
  ParsedPoolLog,
  RawShieldArgs,
  RawTransactArgs,
  RawNullifiedArgs,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedNullifier,
  DecodedPoolEvents,
} from './event-decoder';
