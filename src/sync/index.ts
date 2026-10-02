// ABOUTME: Public sync surface (SPEC §4.4) — typed sync events, note encryption/decryption, history reconstruction,
// ABOUTME: and the quick-sync wire format. The scan engine itself is internal (`@armada/sdk/internal`).

/** Typed subscription events — replace the single global `setOnBalanceUpdateCallback` multiplexer. */
export interface SyncEventMap {
  'scan:started': { fromBlock: number; toBlock: number };
  'scan:progress': { syncedThrough: number; fraction: number };
  'scan:complete': { syncedThrough: number };
  'scan:error': { error: Error };
  'balance:updated': { tokenHash: string; tokenAddress: `0x${string}`; spendable: bigint; pending: bigint };
  /** A new TXO registered for a loaded wallet — SPEC §5.2 (amount, token, memo, sender if disclosed). */
  'note:received': {
    tokenHash: string;
    tokenAddress: `0x${string}`;
    value: bigint;
    memo?: string;
    senderShieldedAddress?: string;
  };
}

// The unsubscribe function `wallet.on(...)` returns.
export type { Unsubscribe } from './emitter';

// Native tx-history reconstruction from scan state (SPEC §5).
export { reconstructReceiveHistory, reconstructHistory } from './history';
export type { HistoryEntry, HistoryCategory, TokenAddressResolver, ReconstructHistoryInput, SentRecipient } from './history';
// The scan-state shapes `ReconstructHistoryInput` carries.
export type { SentOutput } from './scan-engine';

// Note ECIES V2 codec — trial-decrypt commitments + encrypt to a receiver (send).
export {
  encryptNoteToReceiver,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  createTransferNote,
  DEFAULT_EVM_CHAIN,
} from './note-crypto';
export type {
  CommitmentCiphertextV2,
  SenderNoteKeys,
  ReceiverNoteKeys,
} from './note-crypto';

// Self-metadata codec — tag/recover a caller blob stored in a self-owned change-note memo (issue #88).
export { encodeSelfMetadata, decodeSelfMetadata } from './self-metadata';

// Balances — the TXO and per-token balance shapes the wallet API returns, and a token hash's ERC-20 address.
export { erc20AddressFromHash } from './balances';
export type { TXO, NoteOrigin, SpentNullifier, TokenBalance } from './balances';

// Decoded pool events — the shape `serializeQuickSync` takes (an indexer serves it on the quick-sync wire).
export type {
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedNullifier,
  DecodedUnshield,
  DecodedPoolEvents,
} from './event-decoder';

// Native quick-sync wire contract — the canonical schema an indexer serves + the SDK consumes.
export { QUICK_SYNC_SCHEMA_VERSION, serializeQuickSync, parseQuickSync } from './quick-sync-wire';
export type {
  QuickSyncResponse,
  WireShieldCommitment,
  WireTransactCommitment,
  WireNullifier,
  WireUnshield,
  WireCommitmentCiphertext,
  WireTokenData,
} from './quick-sync-wire';
