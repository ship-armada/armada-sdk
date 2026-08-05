// ABOUTME: Transaction-building contracts (SPEC §4.6/§4.6.1) — inspectable Plan → ProofHandle pipeline,
// ABOUTME: typed adaptParams, in-band fee binding, and the native decode API for verifiers. FROZEN.

import type { CircuitShape } from '../prover/index';
import type { CommitmentCiphertextV2 } from '../sync/index';

/** Mirrors the relayer `GET /fees` response. */
export interface FeeQuote {
  /** Per-operation fees, USDC raw (6dp) as strings, keyed by op (transfer, unshield, shield, ...). */
  readonly schedule: Readonly<Record<string, string>>;
  readonly broadcasterRailgunAddress: string;
  readonly feesCacheId: string;
  readonly expiresAt: number;
}

export interface CctpBinding {
  readonly kind: 'cctp';
  readonly recipient: `0x${string}`;
  readonly destDomain: number;
  readonly maxFee: bigint;
}
export interface YieldBinding {
  readonly kind: 'yield';
  readonly adapter: `0x${string}`;
  readonly minShares: bigint;
}

export interface DecodedBoundParams {
  readonly treeNumber: number;
  readonly minGasPrice: bigint;
  readonly unshield: number;
  readonly chainID: bigint;
  readonly adaptContract: `0x${string}`;
  readonly adaptParams: `0x${string}`;
  readonly decodedAdaptParams?: CctpBinding | YieldBinding;
}

export interface PlanOutput {
  readonly toRailgunAddress: string;
  readonly value: bigint;
  readonly tokenAddress: `0x${string}`;
  readonly memo?: string;
}

/** Human/policy-inspectable summary of a plan — surfaced to the SpendSigner. */
export interface PlanSummary {
  readonly tokenAddress: `0x${string}`;
  readonly inputTotal: bigint;
  readonly outputs: readonly PlanOutput[];
  readonly changeValue: bigint;
  readonly feeOutput?: PlanOutput;
  readonly unshield?: { readonly recipient: `0x${string}`; readonly value: bigint };
}

/** Selected TXOs, change, shape, fee output — inspectable BEFORE proving. */
export interface Plan {
  readonly shape: CircuitShape;
  readonly merkleRoot: bigint;
  readonly summary: PlanSummary;
  readonly boundParams: DecodedBoundParams;
}

/** Calldata ready for submission. */
export interface TransactCalldata {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly value: bigint;
}

/**
 * Owns the proof and the exact plan it proves. No populate-time argument re-matching (the stock
 * SDK's silent proof-cache contract): a handle either encodes its own calldata or is explicitly
 * invalid (`invalidate()`, TTL, or plan-state change). A signed/proved tx has NO on-chain expiry —
 * it stays valid until an input note is nullified; `expiresAt` is a signer/app policy hint only.
 */
export interface ProofHandle {
  toTransactCalldata(): TransactCalldata;
  invalidate(): void;
  readonly isValid: boolean;
  readonly expiresAt?: number;
}

/** Provided encoders for the deployed contracts (fixes #399). */
export interface AdaptParamsEncoders {
  encodeCctpBinding(recipient: `0x${string}`, destDomain: number, maxFee: bigint): `0x${string}`;
  encodeYieldBinding(adapter: `0x${string}`, minShares: bigint): `0x${string}`;
}

export interface DecodedTransact {
  readonly nullifiers: readonly bigint[];
  readonly commitments: readonly bigint[];
  readonly merkleRoot: bigint;
  readonly boundParams: DecodedBoundParams;
  /**
   * The output note ciphertexts carried in `boundParams` (one per new commitment). `extractFeeOutput`
   * decrypts these with the broadcaster viewing key to recover the in-band fee note.
   */
  readonly commitmentCiphertexts: readonly CommitmentCiphertextV2[];
  /** Set only for unshields — the plaintext unshield preimage (recipient npk, token, value). */
  readonly unshieldPreimage?: {
    readonly npk: bigint;
    readonly tokenAddress: `0x${string}`;
    readonly value: bigint;
  };
}

/**
 * Native decode for verifiers — understands bare `transact()` and the wrapper entry points,
 * replacing the relayer's synthetic-calldata normalization (§4.6). A `transact()` call carries a
 * `Transaction[]`, so the decoder returns one `DecodedTransact` per bundled transaction.
 * `extractFeeOutput` reconstructs the fee note addressed to the given viewing key.
 */
export interface TransactDecoder {
  decodeTransact(calldata: `0x${string}`): DecodedTransact[];
  extractFeeOutput(
    decoded: DecodedTransact,
    viewingKey: Uint8Array,
  ): { tokenAddress: `0x${string}`; value: bigint } | undefined;
}

// Native transact() calldata decoder (implements TransactDecoder.decodeTransact).
export { decodeTransact, TRANSACT_ABI } from './decode';
