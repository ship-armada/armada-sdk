// ABOUTME: `@armada/sdk/internal` — the SDK's building blocks (scan engine, storage keys, planning/proving pipeline)
// ABOUTME: for tests, tooling and the SDK's own consumers. UNSTABLE: no compatibility promise; may change in any release.

// ── Sync engine ──
export { SyncEmitter } from '../sync/emitter';
export { fetchLogsRanged } from '../sync/ranged-fetch';
export type { GetLogsFn, RangedFetchOptions } from '../sync/ranged-fetch';
export { RpcEventSource, IndexerEventSource } from '../sync/event-source';
export type { EventBatch, EventSource, IndexerEventSourceOptions } from '../sync/event-source';
export { WalletScanState, ownedNoteFromTransactNote } from '../sync/scan-engine';
export type { WalletDecryptors, Decryptor, OwnedNote, ApplyResult, ScanStateSnapshot } from '../sync/scan-engine';
export { saveScanState, loadScanState, scanStateKey } from '../sync/scan-persistence';
export { UTXOMerkletree } from '../sync/merkletree';
export type { MerkleProof } from '../sync/merkletree';
export { startAutoSync } from '../sync/auto-sync';
export type { AutoSyncOptions } from '../sync/auto-sync';
export {
  POOL_V2_EVENT_ABI,
  formatShieldEvent,
  formatTransactEvent,
  formatNullifiedEvent,
  formatCommitmentCiphertext,
  decodePoolEvents,
} from '../sync/event-decoder';
export type { LogMeta, ParsedPoolLog, RawShieldArgs, RawTransactArgs, RawNullifiedArgs } from '../sync/event-decoder';

// ── Notes, balances, history helpers ──
export { decryptedCommitmentMatches } from '../sync/note-crypto';
export { tryDecryptShield, shieldCommitmentMatches } from '../sync/shield-crypto';
export { computeBalances, txoFromNote, tokenHashKey, withTokenAddresses } from '../sync/balances';
export type { PendingSpend, BalanceOptions } from '../sync/balances';
export { newReceivedNotes, ownSpendTxids } from '../sync/history';

// ── Pending-spend holds ──
export { PendingSpends, savePendingSpends, loadPendingSpends, pendingSpendsKey } from '../sync/pending-spends';

// ── Storage encryption & keys ──
export { EncryptedStore, deriveStorageKey, deriveWalletStorageKey, walletRecordId } from '../storage/encrypted';

// ── Planning & proving pipeline (the wallet methods are the public API) ──
export { planTransfer, planSpend, planWitnessInputs } from '../tx/plan';
export type { PlanTransferParams, TransferOutputRequest, FeeRequest } from '../tx/plan';
export { planConsolidate, txosAfterConsolidation } from '../tx/consolidate';
export type { PlanConsolidateParams } from '../tx/consolidate';
export { maxTransferAmount, maxUnshieldAmount } from '../tx/max-transfer';
export type { MaxTransferParams, MaxUnshieldParams } from '../tx/max-transfer';
export { prove, proveAll } from '../tx/prove';
export type { ProveParams } from '../tx/prove';
export { runPreflight, readShieldsPaused } from '../tx/preflight';
export type { PreflightQueries, PreflightParams } from '../tx/preflight';
export { buildWitness, hashSpendBoundParams } from '../tx/witness';
export type {
  BuildWitnessParams,
  BuiltWitness,
  WitnessInput,
  WitnessOutputRequest,
  WitnessSenderContext,
  FormattedCircuitInputs,
} from '../tx/witness';
