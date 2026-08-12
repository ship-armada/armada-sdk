// ABOUTME: Transaction-building contracts (SPEC §4.6/§4.6.1) — inspectable Plan → ProofHandle pipeline,
// ABOUTME: typed adaptParams, in-band fee binding, and the native decode API for verifiers. FROZEN.

import type { CircuitShape } from '../prover/index';
import type { CommitmentCiphertextV2, ReceiverNoteKeys, TXO } from '../sync/index';
import type { TokenDataGetter, Chain } from '../core/index';
import type { TransactionData } from './serialize';

/** Mirrors the relayer `GET /fees` response. */
export interface FeeQuote {
  /** Per-operation fees, USDC raw (6dp) as strings, keyed by op (transfer, unshield, shield, ...). */
  readonly schedule: Readonly<Record<string, string>>;
  readonly broadcasterShieldedAddress: string;
  readonly feesCacheId: string;
  readonly expiresAt: number;
}

export interface CctpBinding {
  readonly kind: 'cctp';
  readonly recipient: `0x${string}`;
  readonly destDomain: number;
  readonly maxFee: bigint;
}

export interface DecodedBoundParams {
  readonly treeNumber: number;
  readonly minGasPrice: bigint;
  readonly unshield: number;
  readonly chainID: bigint;
  readonly adaptContract: `0x${string}`;
  readonly adaptParams: `0x${string}`;
  /**
   * The binding recovered from the WRAPPER calldata's plaintext args (not from `adaptParams` — that
   * is a one-way keccak commitment). Present only when decoding a wrapper entry point that carries
   * the destination tuple; `undefined` for a bare `transact()`.
   */
  readonly decodedAdaptParams?: CctpBinding;
}

export interface PlanOutput {
  readonly toShieldedAddress: string;
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

/**
 * The shape/selection decision produced by `planTransfer` — everything except the tree-dependent
 * merkle proofs (the pure planner has no tree). The wallet augments this into a full `Plan`.
 */
export interface PlanSelection {
  readonly shape: CircuitShape;
  readonly merkleRoot: bigint;
  readonly summary: PlanSummary;
  readonly boundParams: DecodedBoundParams;
  /**
   * The input notes the plan selected (all from `boundParams.treeNumber`). The witness builder reads
   * each note's `random`/`value`/`position` from these and pairs it with the captured merkle proof.
   */
  readonly selectedInputs: readonly TXO[];
}

/**
 * The full inspectable plan handed to `prove`. Extends the selection with each selected input's merkle
 * proof, **captured at plan time from the same tree state as `merkleRoot`** (one per `selectedInputs`
 * entry, same order). The prover reads these instead of re-deriving proofs from live scan state, so the
 * path elements and the public-input root always correspond even if a sync appended commitments to the
 * tree between planning and proving — a stale proof against a fresh root would fail deep in the circuit.
 */
export interface Plan extends PlanSelection {
  readonly merkleProofs: readonly (readonly bigint[])[];
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
  /**
   * The proved `Transaction` struct itself — for embedding in a WRAPPER call (cross-chain unshield,
   * yield lend/redeem) via `transactionToTuple` + `Interface.encodeFunctionData`, instead of the bare
   * `transact()` calldata `toTransactCalldata` produces. Throws once invalidated.
   */
  toTransactionData(): TransactionData;
  invalidate(): void;
  readonly isValid: boolean;
  readonly expiresAt?: number;
}

/**
 * adaptParams binding encoders matching the deployed contracts (fixes #399). Each is a one-way
 * keccak256 commitment set on `boundParams.adaptParams`; the yield deposit vs redeem paths produce
 * distinct commitments. See `./adapt-params` for the implementations + `verify*` counterparts.
 */
export interface AdaptParamsEncoders {
  encodeCctpBinding(recipient: string, destinationDomain: number, maxFee: bigint): `0x${string}`;
  encodeYieldDepositBinding(
    npk: bigint,
    encryptedBundle: readonly [string, string, string],
    shieldKey: string,
  ): `0x${string}`;
  encodeYieldRedeemBinding(
    npk: bigint,
    encryptedBundle: readonly [string, string, string],
    shieldKey: string,
    feeNpk: bigint,
    feeEncryptedBundle: readonly [string, string, string],
    feeShieldKey: string,
    feeAmount: bigint,
  ): `0x${string}`;
}

// adaptParams binding encoders + verifiers (fixes #399).
export {
  CCTP_UNSHIELD_DOMAIN_TAG,
  encodeCctpBinding,
  verifyCctpBinding,
  encodeYieldDepositBinding,
  verifyYieldDepositBinding,
  encodeYieldRedeemBinding,
  verifyYieldRedeemBinding,
} from './adapt-params';

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

/** The broadcaster's identity for fee-note recovery — full identity (not just the viewing key). */
export type BroadcasterIdentity = ReceiverNoteKeys;

/**
 * Native decode for verifiers — understands bare `transact()` and the wrapper entry points,
 * replacing the relayer's synthetic-calldata normalization (§4.6). A `transact()` call carries a
 * `Transaction[]`, so the decoder returns one `DecodedTransact` per bundled transaction.
 *
 * `extractFeeOutput` recovers the in-band fee note addressed to the broadcaster. It takes the FULL
 * broadcaster identity (not just the viewing key) and is async because it must *bind* the decrypted
 * value to the transaction: decrypting a ciphertext with the viewing key alone yields an untrusted
 * claimed value — a malicious sender could attach a ciphertext claiming a large fee while the actual
 * on-chain commitment encodes zero or is addressed elsewhere. Binding requires recomputing
 * `npk = poseidon(broadcasterMasterPublicKey, random)` and confirming the note's commitment hash
 * appears in `decoded.commitments`, which needs the master public key.
 */
export interface TransactDecoder {
  decodeTransact(calldata: `0x${string}`): DecodedTransact[];
  extractFeeOutput(
    decoded: DecodedTransact,
    broadcaster: BroadcasterIdentity,
    tokenDataGetter: TokenDataGetter,
    chain?: Chain,
  ): Promise<{ tokenAddress: `0x${string}`; value: bigint } | undefined>;
}

// Native transact() calldata decoder + in-band fee-note recovery (the TransactDecoder methods).
export { decodeTransact, extractFeeOutput, TRANSACT_ABI } from './decode';

// Transfer planning — inspectable Plan (TXO selection + change + fee output + circuit shape).
export { planTransfer, planWitnessInputs } from './plan';
export type { PlanTransferParams, TransferOutputRequest, FeeRequest } from './plan';

// transact() calldata serializer (inverse of decodeTransact) — proof G2 swap + Transaction structs.
export { buildTransactCalldata, transactionToTuple } from './serialize';
export type { TransactionData, TransactionBoundParams } from './serialize';

// prove() orchestration + ProofHandle — witness → artifacts → proof → calldata.
export { prove } from './prove';
export type { ProveParams } from './prove';

// Shield-request builder — the ShieldRequest struct for privacyPool.shield() (#410).
export { buildShieldRequest, generateShieldPrivateKey } from './shield';
export type { ShieldRequest, ShieldRequestInput } from './shield';

// Gasless shield — EIP-712 ShieldIntent + requestsHash for GaslessShieldWrapper.gaslessShield (#410).
export { buildGaslessShield, hashShieldRequests, buildShieldIntentTypedData, hashShieldIntent } from './gasless-shield';
export type { GaslessShieldInput, ShieldIntent, ShieldIntentTypedData } from './gasless-shield';

// Circuit witness assembly — full notes + merkle proofs + SpendSigner signature → circuit inputs.
export { buildWitness, computeSpendIntentDigest, hashSpendBoundParams } from './witness';
export type {
  BuildWitnessParams,
  BuiltWitness,
  WitnessInput,
  WitnessOutputRequest,
  WitnessSenderContext,
  FormattedCircuitInputs,
  SpendIntentContext,
} from './witness';
