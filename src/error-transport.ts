// ABOUTME: Rebuild an SDK error of the right class from its code and message (F4) — how a typed error crosses a boundary
// ABOUTME: that carries only data, like the prover worker's message channel. Internal: not part of the public surface.

import {
  AbortedError,
  ArtifactFetchError,
  ArtifactIntegrityError,
  FeeQuoteExpiredError,
  InstanceClosedError,
  InsufficientBalanceError,
  InternalError,
  InvalidConfigError,
  InvalidKeyMaterialError,
  InvalidRequestError,
  NoSpendCapabilityError,
  NoteAlreadySpentError,
  NothingToConsolidateError,
  PositionGapError,
  ProofExpiredError,
  ProofHandleInvalidatedError,
  ProofVerificationError,
  ProverWorkerError,
  QuickSyncSchemaError,
  RootMismatchError,
  SignerContractViolationError,
  StorageConflictError,
  StorageUnavailableError,
  TooFragmentedError,
  UnsupportedCircuitShapeError,
  type ArmadaError,
} from './errors';

// The classes a code and a message alone can rebuild (the ones whose constructor takes just a message).
const REBUILDABLE: Record<string, new (message: string) => ArmadaError> = {
  ROOT_MISMATCH: RootMismatchError,
  NOTE_ALREADY_SPENT: NoteAlreadySpentError,
  FEE_QUOTE_EXPIRED: FeeQuoteExpiredError,
  ARTIFACT_INTEGRITY: ArtifactIntegrityError,
  ARTIFACT_FETCH: ArtifactFetchError,
  STORAGE_CONFLICT: StorageConflictError,
  STORAGE_UNAVAILABLE: StorageUnavailableError,
  NO_SPEND_CAPABILITY: NoSpendCapabilityError,
  INSUFFICIENT_BALANCE: InsufficientBalanceError,
  QUICK_SYNC_SCHEMA: QuickSyncSchemaError,
  POSITION_GAP: PositionGapError,
  INVALID_KEY_MATERIAL: InvalidKeyMaterialError,
  PROOF_VERIFICATION: ProofVerificationError,
  UNSUPPORTED_CIRCUIT_SHAPE: UnsupportedCircuitShapeError,
  TOO_FRAGMENTED: TooFragmentedError,
  NOTHING_TO_CONSOLIDATE: NothingToConsolidateError,
  ABORTED: AbortedError,
  INSTANCE_CLOSED: InstanceClosedError,
  PROVER_WORKER: ProverWorkerError,
  PROOF_HANDLE_INVALIDATED: ProofHandleInvalidatedError,
  PROOF_EXPIRED: ProofExpiredError,
  INVALID_REQUEST: InvalidRequestError,
  INVALID_CONFIG: InvalidConfigError,
  SIGNER_CONTRACT_VIOLATION: SignerContractViolationError,
  INTERNAL: InternalError,
};

/**
 * Rebuild an SDK error of the right class from its `code` and `message` — how a typed error crosses a boundary that
 * carries only data (the prover worker's message channel). Undefined for an unknown code, or one whose class needs
 * more than a message (`RPC`, `INDEXER_HTTP`).
 */
export function armadaErrorFromCode(code: string, message: string): ArmadaError | undefined {
  const ErrorClass = REBUILDABLE[code];
  return ErrorClass === undefined ? undefined : new ErrorClass(message);
}
