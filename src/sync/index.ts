// ABOUTME: Sync contracts (SPEC §4.4) — event scan building the UTXO merkletree, behind a pluggable
// ABOUTME: EventSource (RPC getLogs default, native indexer quick-sync optional) + typed sync events.

import type { DecodedPoolEvents } from './event-decoder';

/** A batch of decoded pool events plus the highest block it fully covers. */
export interface EventBatch {
  readonly events: DecodedPoolEvents;
  /**
   * Highest block the batch fully covers. May be < the requested `toBlock` when an indexer lags the
   * chain head — the SDK then RPC-covers the `(syncedThroughBlock, toBlock]` tail itself.
   */
  readonly syncedThroughBlock: number;
}

/**
 * Pluggable event source (SPEC §4.4, decision #3). The default RPC source (getLogs → decode) is the
 * source of truth; an optional indexer source (native `/v2/quick-sync`) is a fast path whose batches
 * are verified against on-chain roots before acceptance, falling back to RPC on any mismatch.
 */
export interface EventSource {
  getEvents(fromBlock: number, toBlock: number): Promise<EventBatch>;
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

// Typed scan/balance event bus — a wallet owns one and emits on sync().
export { SyncEmitter } from './emitter';
export type { Unsubscribe } from './emitter';

// Ranged log fetch.
export { fetchLogsRanged } from './ranged-fetch';
export type { GetLogsFn, RangedFetchOptions } from './ranged-fetch';

// EventSource implementations — RPC getLogs (default) + native-indexer quick-sync.
export { RpcEventSource, IndexerEventSource } from './event-source';
export type { IndexerEventSourceOptions } from './event-source';

// Native tx-history reconstruction from scan state (SPEC §5).
export { reconstructReceiveHistory, reconstructHistory } from './history';
export type { HistoryEntry, HistoryCategory, TokenAddressResolver, ReconstructHistoryInput, SentRecipient } from './history';

// Scan checkpoints + resumable scan.
export { CheckpointStore } from './checkpoints';
export type { ScanCheckpoint } from './checkpoints';
export { runScan } from './scan';
export type { ScanOptions, ScanResult } from './scan';

// Wallet scan orchestrator — folds decoded events into trees/TXOs/balances with root verification.
export { WalletScanState, ownedNoteFromTransactNote } from './scan-engine';
export type { WalletDecryptors, Decryptor, OwnedNote, SentOutput, ApplyResult, ScanStateSnapshot } from './scan-engine';

// Scan-state persistence — resume sync from the last synced block instead of rescanning from genesis.
export { saveScanState, loadScanState, scanStateKey } from './scan-persistence';

// UTXO merkletree.
export { UTXOMerkletree } from './merkletree';
export type { MerkleProof } from './merkletree';

// Note ECIES V2 codec — trial-decrypt commitments (scan) + encrypt to a receiver (send).
export {
  encryptNoteToReceiver,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
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

// Native quick-sync wire contract — the canonical schema an indexer serves + the SDK consumes.
export { QUICK_SYNC_SCHEMA_VERSION, serializeQuickSync, parseQuickSync } from './quick-sync-wire';
export type {
  QuickSyncResponse,
  WireShieldCommitment,
  WireTransactCommitment,
  WireNullifier,
  WireCommitmentCiphertext,
  WireTokenData,
} from './quick-sync-wire';
