// ABOUTME: Wallet-layer contracts (SPEC §4.2) — the SpendSigner custody boundary, enrollment factory,
// ABOUTME: and view-only wallets. Implementations land in Phase 2; the interfaces are FROZEN here.

import type { DecodedBoundParams, PlanSummary, Plan, ProofHandle, FeeQuote } from '../tx/index';
import type { ProveOptions } from '../prover/index';
import type { TokenBalance, HistoryEntry } from '../sync/index';

export type EddsaSignature = { readonly R8: readonly [bigint, bigint]; readonly S: bigint };

/**
 * A fully-bound spend intent handed to the signer. `message` is the pinned poseidon digest (§2);
 * `context` carries everything needed to inspect/gate the intent (decoded adapt calldata included).
 */
export interface SpendSignRequest {
  readonly message: bigint;
  readonly context: {
    readonly nullifiers: readonly bigint[];
    readonly commitmentsOut: readonly bigint[];
    readonly merkleRoot: bigint;
    readonly boundParams: DecodedBoundParams;
    readonly summary: PlanSummary;
  };
}

/**
 * Custody boundary (SPEC §4.2.1). Batch semantics are part of the contract: the signer receives the
 * ENTIRE batch of fully-bound intents before releasing ANY signature — "approve one signature =
 * approve one fully-bound intent". Implementations: `LocalSigner` (from rootSecret), `ExternalSigner`
 * (out-of-process — transport defined by the integration, NOT the SDK), later `ThresholdSigner`.
 */
export interface SpendSigner {
  getSpendingPublicKey(): Promise<[bigint, bigint]>;
  signBatch(requests: readonly SpendSignRequest[]): Promise<EddsaSignature[]>;
}

/** A loaded wallet: viewing capability ± spend capability (view-only = no SpendSigner attached). */
export interface Wallet {
  readonly railgunAddress: string;
  readonly canSpend: boolean;
  /** Scan the pool from the wallet's creation block to chain head, updating its TXO/balance state. */
  sync(): Promise<{ syncedThrough: number }>;
  /** Per-token spendable/pending balances over the synced TXO set. */
  balances(): Promise<TokenBalance[]>;
  /** Reconstructed transaction history from the wallet's own scan state (SPEC §5). Works view-only. */
  history(options?: { sinceBlock?: number }): Promise<HistoryEntry[]>;
  planTransfer(request: PlanTransferRequest): Promise<Plan>;
  /** Requests signatures from the attached SpendSigner during witness assembly, then proves. */
  prove(plan: Plan, options?: ProveOptions): Promise<ProofHandle>;
  /** Verifiable single-note disclosure receipt (SPEC §5.3). Available on view-only wallets too. */
  exportDisclosure(txoRef: string): Promise<Uint8Array>;
  /** Export this wallet's shareable viewing key (Railgun wire format) — grants view-only capability. */
  shareViewingKey(): string;
}

export interface PlanTransferRequest {
  readonly outputs: readonly { to0zk: string; amount: bigint; memo?: string }[];
  readonly unshield?: { recipient: `0x${string}`; amount: bigint; adaptParams?: `0x${string}` };
  readonly fee: FeeQuote;
}

/** Enrollment factory (SPEC §4.2). rootSecret is the canonical identity; no mnemonic intermediary. */
export interface WalletFactory {
  fromRootSecret(rootSecret: Uint8Array, opts: { creationBlock: number; signer?: SpendSigner }): Promise<Wallet>;
  /** Ephemeral, in-memory only, never persisted — for claimable payments (SPEC §6). */
  ephemeralFromSeed(seed: Uint8Array): Promise<Wallet>;
  /** BIP-39 compat for the relayer's existing mnemonic-provisioned wallet only. */
  fromMnemonic(mnemonic: string, opts: { creationBlock: number; signer?: SpendSigner }): Promise<Wallet>;
  /** View-only: full scan/balance/disclosure, no spend (spend-path calls throw NoSpendCapabilityError). */
  viewOnlyFromViewingKey(shareableViewingKey: string, opts: { creationBlock: number }): Promise<Wallet>;
}

// Implementations.
export { deriveKeyset, deriveKeysetFromMnemonic } from './derive';
export type { Keyset } from './derive';
export { LocalSigner } from './local-signer';

export { ExternalSigner } from './external-signer';
export type { SignBackend, PublicKeyBackend } from './external-signer';
export { deriveViewOnlyIdentity } from './view-only';
export type { ViewOnlyIdentity } from './view-only';
export { encodeShareableViewingKey, decodeShareableViewingKey } from './shareable-viewing-key';
export type { ShareableViewingKeyMaterial } from './shareable-viewing-key';
