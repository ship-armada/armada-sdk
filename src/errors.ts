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
