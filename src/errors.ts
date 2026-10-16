// ABOUTME: Typed error taxonomy (SPEC §8). Every SDK error carries a stable `code` string; consuming
// ABOUTME: code and tests match on `code`, never on message text. FROZEN surface for Phase 2+.

export abstract class ArmadaError extends Error {
  abstract readonly code: string;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RootMismatchError extends ArmadaError {
  readonly code = 'ROOT_MISMATCH';
}
export class NoteAlreadySpentError extends ArmadaError {
  readonly code = 'NOTE_ALREADY_SPENT';
}
export class FeeQuoteExpiredError extends ArmadaError {
  readonly code = 'FEE_QUOTE_EXPIRED';
}
export class ArtifactIntegrityError extends ArmadaError {
  readonly code = 'ARTIFACT_INTEGRITY';
}
export class StorageConflictError extends ArmadaError {
  readonly code = 'STORAGE_CONFLICT';
}

/**
 * The storage can't be used safely in this environment: the browser has no Web Locks API (an insecure context, or a
 * very old browser), so the IndexedDB adapter can't lock its database against a second instance and refuses to open
 * (SPEC §4.3). Not a conflict — no other instance holds the database; this one can never lock it.
 */
export class StorageUnavailableError extends ArmadaError {
  readonly code = 'STORAGE_UNAVAILABLE';
}
/** Thrown by any spend-path call on a view-only wallet (no `SpendSigner` attached) — SPEC §4.2.2. */
export class NoSpendCapabilityError extends ArmadaError {
  readonly code = 'NO_SPEND_CAPABILITY';
}
/** Thrown when no single tree's spendable notes can cover a planned spend (amount + fee). */
export class InsufficientBalanceError extends ArmadaError {
  readonly code = 'INSUFFICIENT_BALANCE';
}

// ethers' codes for a failure to reach the node at all: connection, timeout, HTTP-level error.
const TRANSPORT_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR']);

/**
 * An RPC call failed (SPEC §8). `method` is the call; `cause` is the provider's own error. `transport` is true when
 * the node wasn't reached (connection, timeout, HTTP error) — worth retrying later or on another node — and false
 * when the node answered with an error (a range limit, a revert, a bad request).
 */
export class RpcError extends ArmadaError {
  readonly code = 'RPC';
  readonly method: string;
  readonly transport: boolean;
  constructor(method: string, cause: unknown) {
    super(`rpc: ${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.method = method;
    const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    this.transport = typeof causeCode === 'string' && TRANSPORT_CODES.has(causeCode);
  }
}

/** A quick-sync response failed schema validation (unknown version, missing/mistyped fields). */
export class QuickSyncSchemaError extends ArmadaError {
  readonly code = 'QUICK_SYNC_SCHEMA';
}

/**
 * A quick-sync request to the indexer returned a non-OK HTTP status (e.g. a 404 from a legacy/wrong
 * endpoint). Typed distinctly from the schema/root errors so the untrusted-indexer fallback can report
 * the true cause (`indexer-http-error`, carrying `status`) instead of a misleading `root-mismatch`.
 */
export class IndexerHttpError extends ArmadaError {
  readonly code = 'INDEXER_HTTP';
  readonly status: number;
  constructor(message: string, options: { status: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.status = options.status;
  }
}

/**
 * An append-only merkletree received a leaf whose position isn't the tree's next slot (SPEC §4.3) — a
 * gap that would corrupt every later proof. Typed so the quick-sync fallback classifier reports it as
 * `position-gap` by `code`, not by matching message text.
 *
 * `expected`/`received` (when set) tell the two failure shapes apart: `received > expected` means the
 * local tree is MISSING leaves (it skipped part of the chain — rescan it); `received < expected` means a
 * leaf arrived that the tree already holds (a re-sent or re-included commitment).
 */
export class PositionGapError extends ArmadaError {
  readonly code = 'POSITION_GAP';
  readonly expected?: number;
  readonly received?: number;
  constructor(message: string, options?: { expected?: number; received?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.expected !== undefined) this.expected = options.expected;
    if (options?.received !== undefined) this.received = options.received;
  }
}

/**
 * A proving-artifact download (wasm/zkey/vkey) failed: a non-OK HTTP response (`status`), a network error, or a
 * timeout (SPEC §4.5). A retry may succeed; `ArtifactIntegrityError` is the different case of bytes that arrived but
 * don't match the manifest.
 */
export class ArtifactFetchError extends ArmadaError {
  readonly code = 'ARTIFACT_FETCH';
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.status !== undefined) this.status = options.status;
  }
}

/**
 * Imported or derived key material failed validation (SPEC §4.2): malformed hex, wrong length, a
 * zero scalar, or a Baby Jubjub point that is off-curve / outside the prime-order subgroup / the
 * identity. Rejected, never silently clamped — a clamped key yields a wrong wallet that scans nothing.
 */
export class InvalidKeyMaterialError extends ArmadaError {
  readonly code = 'INVALID_KEY_MATERIAL';
}

/**
 * A freshly generated proof failed local verification against its own verifying key (SPEC §4.5). It
 * would revert on-chain, so proving surfaces this immediately rather than after a submitted transaction
 * — a witness-assembly or corrupted-artifact bug, caught before the tx is broadcast.
 */
export class ProofVerificationError extends ArmadaError {
  readonly code = 'PROOF_VERIFICATION';
}

/**
 * A plan selected a circuit shape (`<nullifiers>x<commitments>`) the deployment has no artifact for
 * (SPEC §4.6). Surfaced at plan time — before the signing ceremony and proving — so a fragmented wallet
 * fails fast with a clear signal rather than an opaque artifact-resolve error 30s in. Typically means
 * the spend needs more input notes than any supported shape allows (multi-transaction batching, which
 * this pipeline does not yet do).
 */
export class UnsupportedCircuitShapeError extends ArmadaError {
  readonly code = 'UNSUPPORTED_CIRCUIT_SHAPE';
}

/**
 * A spend is so fragmented it needs more input notes than one atomic batch of supported-shape proofs can
 * hold (`planSpend`'s per-batch group cap). Splitting further would require multiple SEQUENTIAL
 * transactions (consolidate-then-spend), which this pipeline does not do — the caller should consolidate
 * the wallet's small notes first. Distinct from `InsufficientBalanceError` (enough value, too many notes).
 */
export class TooFragmentedError extends ArmadaError {
  readonly code = 'TOO_FRAGMENTED';
}

/**
 * A consolidation found nothing worth merging for the token: too few notes (a lone current-tree note
 * merges nothing), or only dust worth no more than the fee it would cost. Not a failure of the wallet —
 * the caller should report that there's nothing to do.
 */
export class NothingToConsolidateError extends ArmadaError {
  readonly code = 'NOTHING_TO_CONSOLIDATE';
}

/** A long operation (prove) was cancelled via its `AbortSignal`. Consumers match `code`, not message. */
export class AbortedError extends ArmadaError {
  readonly code = 'ABORTED';
}

/**
 * The SDK instance was closed, the wallet was disposed, or the storage adapter was closed (SPEC §4.1). Every call
 * after `sdk.close()` or `wallet.dispose()` throws it, and so does a sync cancelled by one; a closed adapter throws
 * it until it's opened again.
 */
export class InstanceClosedError extends ArmadaError {
  readonly code = 'INSTANCE_CLOSED';
}

/**
 * The prover worker stopped before replying (SPEC §4.5): it crashed or failed to load, it was terminated
 * to cancel another in-flight request, or the prover was closed. Unless the prover was closed, the next
 * request starts a fresh worker, so the operation can be retried. Also the class for a worker reply that
 * carried no SDK code (a typed error keeps its own class across the worker boundary).
 */
export class ProverWorkerError extends ArmadaError {
  readonly code = 'PROVER_WORKER';
}

/** A `ProofHandle` was used after `invalidate()` — re-plan and re-prove. */
export class ProofHandleInvalidatedError extends ArmadaError {
  readonly code = 'PROOF_HANDLE_INVALIDATED';
}

/** A `ProofHandle` was used past its `expiresAt` policy TTL (SPEC §4.6) — re-plan and re-prove. */
export class ProofExpiredError extends ArmadaError {
  readonly code = 'PROOF_EXPIRED';
}

/** Caller-supplied plan/request input is invalid (non-positive output, inconsistent adapt binding, …). */
export class InvalidRequestError extends ArmadaError {
  readonly code = 'INVALID_REQUEST';
}

/**
 * The SDK configuration is invalid: a malformed field caught at `createArmadaSdk`, or an RPC that doesn't
 * serve the configured chain / pool, caught before the first sync or preflight (so no checkpoint from the
 * wrong chain is ever saved).
 */
export class InvalidConfigError extends ArmadaError {
  readonly code = 'INVALID_CONFIG';
}

/** A `SpendSigner` violated its contract (wrong signature count, or returned none). */
export class SignerContractViolationError extends ArmadaError {
  readonly code = 'SIGNER_CONTRACT_VIOLATION';
}

/**
 * An SDK invariant broke: a bug, or state the SDK didn't write (a corrupted or foreign storage record, artifacts the
 * prover can't use). Not something the caller did; report it.
 */
export class InternalError extends ArmadaError {
  readonly code = 'INTERNAL';
}

/** Every SDK error code (SPEC §8). Consumers match on these, never on classes or message text. */
export const ERROR_CODES = [
  'ROOT_MISMATCH',
  'NOTE_ALREADY_SPENT',
  'FEE_QUOTE_EXPIRED',
  'ARTIFACT_INTEGRITY',
  'ARTIFACT_FETCH',
  'STORAGE_CONFLICT',
  'STORAGE_UNAVAILABLE',
  'NO_SPEND_CAPABILITY',
  'INSUFFICIENT_BALANCE',
  'RPC',
  'QUICK_SYNC_SCHEMA',
  'INDEXER_HTTP',
  'POSITION_GAP',
  'INVALID_KEY_MATERIAL',
  'PROOF_VERIFICATION',
  'UNSUPPORTED_CIRCUIT_SHAPE',
  'TOO_FRAGMENTED',
  'NOTHING_TO_CONSOLIDATE',
  'ABORTED',
  'INSTANCE_CLOSED',
  'PROVER_WORKER',
  'PROOF_HANDLE_INVALIDATED',
  'PROOF_EXPIRED',
  'INVALID_REQUEST',
  'INVALID_CONFIG',
  'SIGNER_CONTRACT_VIOLATION',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The error class for each code — what `isArmadaError(err, code)` narrows to. */
export interface ArmadaErrorByCode {
  ROOT_MISMATCH: RootMismatchError;
  NOTE_ALREADY_SPENT: NoteAlreadySpentError;
  FEE_QUOTE_EXPIRED: FeeQuoteExpiredError;
  ARTIFACT_INTEGRITY: ArtifactIntegrityError;
  ARTIFACT_FETCH: ArtifactFetchError;
  STORAGE_CONFLICT: StorageConflictError;
  STORAGE_UNAVAILABLE: StorageUnavailableError;
  NO_SPEND_CAPABILITY: NoSpendCapabilityError;
  INSUFFICIENT_BALANCE: InsufficientBalanceError;
  RPC: RpcError;
  QUICK_SYNC_SCHEMA: QuickSyncSchemaError;
  INDEXER_HTTP: IndexerHttpError;
  POSITION_GAP: PositionGapError;
  INVALID_KEY_MATERIAL: InvalidKeyMaterialError;
  PROOF_VERIFICATION: ProofVerificationError;
  UNSUPPORTED_CIRCUIT_SHAPE: UnsupportedCircuitShapeError;
  TOO_FRAGMENTED: TooFragmentedError;
  NOTHING_TO_CONSOLIDATE: NothingToConsolidateError;
  ABORTED: AbortedError;
  INSTANCE_CLOSED: InstanceClosedError;
  PROVER_WORKER: ProverWorkerError;
  PROOF_HANDLE_INVALIDATED: ProofHandleInvalidatedError;
  PROOF_EXPIRED: ProofExpiredError;
  INVALID_REQUEST: InvalidRequestError;
  INVALID_CONFIG: InvalidConfigError;
  SIGNER_CONTRACT_VIOLATION: SignerContractViolationError;
  INTERNAL: InternalError;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * Whether `err` is an SDK error — and, given `code`, one with that code (narrowed to its class, so its own fields,
 * like `RpcError.transport`, are typed). Matches on the `code` field, so it also recognises an error from another
 * copy of the SDK (ESM and CJS builds, or two bundled copies), where `instanceof` is false. Another library's error
 * with a `code` field (ethers' `NETWORK_ERROR`, say) isn't one.
 */
export function isArmadaError(err: unknown): err is ArmadaError;
export function isArmadaError<C extends ErrorCode>(err: unknown, code: C): err is ArmadaErrorByCode[C];
export function isArmadaError(err: unknown, code?: ErrorCode): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const errCode = (err as { code?: unknown }).code;
  if (typeof errCode !== 'string' || !KNOWN_CODES.has(errCode)) return false;
  return code === undefined || errCode === code;
}
