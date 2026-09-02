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
export class NonDeterministicSignerError extends ArmadaError {
  readonly code = 'NON_DETERMINISTIC_SIGNER';
}
export class ClaimSeedCounterError extends ArmadaError {
  readonly code = 'CLAIM_SEED_COUNTER';
}
/** Thrown by any spend-path call on a view-only wallet (no `SpendSigner` attached) — SPEC §4.2.2. */
export class NoSpendCapabilityError extends ArmadaError {
  readonly code = 'NO_SPEND_CAPABILITY';
}
/** Thrown when no single tree's spendable notes can cover a planned spend (amount + fee). */
export class InsufficientBalanceError extends ArmadaError {
  readonly code = 'INSUFFICIENT_BALANCE';
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
 */
export class PositionGapError extends ArmadaError {
  readonly code = 'POSITION_GAP';
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

/** A long operation (prove) was cancelled via its `AbortSignal`. Consumers match `code`, not message. */
export class AbortedError extends ArmadaError {
  readonly code = 'ABORTED';
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

/** A `SpendSigner` violated its contract (wrong signature count, or returned none). */
export class SignerContractViolationError extends ArmadaError {
  readonly code = 'SIGNER_CONTRACT_VIOLATION';
}
