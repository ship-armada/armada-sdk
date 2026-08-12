// ABOUTME: Wallet-layer contracts (SPEC §4.2) — the SpendSigner custody boundary, enrollment factory,
// ABOUTME: and view-only wallets. Implementations land in Phase 2; the interfaces are FROZEN here.

import type { Plan, ProofHandle, FeeQuote, SpendIntentContext, CctpBinding, PreflightResult } from '../tx/index';
import type { ProveOptions } from '../prover/index';
import type { TokenBalance, HistoryEntry, SyncEventMap, Unsubscribe } from '../sync/index';

export type EddsaSignature = { readonly R8: readonly [bigint, bigint]; readonly S: bigint };

/**
 * A fully-bound spend intent handed to the signer. `message` is the pinned poseidon digest (§2);
 * `context` (a `SpendIntentContext`) carries everything needed to inspect/gate the intent — decoded
 * adapt calldata AND the output ciphertexts — so a signer can recompute `message` via
 * `computeSpendIntentDigest(context)` and refuse a digest that doesn't match the context it approved.
 */
export interface SpendSignRequest {
  readonly message: bigint;
  readonly context: SpendIntentContext;
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
  /** Optional: release/zeroize held key material (SPEC §4.2). A disposed signer refuses to sign. */
  dispose?(): void;
}

/** A loaded wallet: viewing capability ± spend capability (view-only = no SpendSigner attached). */
export interface Wallet {
  readonly shieldedAddress: string;
  readonly canSpend: boolean;
  /**
   * Whether this wallet's scan state is written to the StorageAdapter. `false` for ephemeral
   * (claimable-payment) wallets, which are in-memory only and never touch storage (SPEC §4.2/§4.3/§6.5)
   * — no decrypted note data, and no seed-derived identity, ever hits disk on either side of a claim.
   */
  readonly persists: boolean;
  /**
   * Scan the pool from the wallet's last synced block to chain head, updating its TXO/balance state.
   * Resumes from the persisted checkpoint (no rescan from genesis). Returns the window that was
   * covered: `fromBlock` (the resume point = checkpoint + 1), the new `syncedThrough` (chain head),
   * and `scanned` (false when head hadn't advanced past the checkpoint, i.e. no work was done).
   */
  sync(): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }>;
  /**
   * Current sync state (SPEC §4.4 `sdk.sync.status`) — the persisted checkpoint block and whether a sync
   * is in flight. Cheap: hydrates the checkpoint from storage once, does no getLogs and no state change.
   */
  syncStatus(): Promise<{ syncedThrough: number; syncing: boolean }>;
  /** Per-token spendable/pending balances over the synced TXO set. */
  balances(): Promise<TokenBalance[]>;
  /** Reconstructed transaction history from the wallet's own scan state (SPEC §5). Works view-only. */
  history(options?: { sinceBlock?: number }): Promise<HistoryEntry[]>;
  planTransfer(request: PlanTransferRequest): Promise<Plan>;
  /**
   * Cheap pre-proof checks over a plan (SPEC §4.7) — root freshness, input nullifiers unspent, and
   * (if a `feeQuote` is passed) quote freshness. Returns a finding per check; the caller decides policy.
   * Works view-only. Turns the 30s-proof-then-revert failure into a typed, pre-proof result.
   */
  preflight(plan: Plan, options?: { feeQuote?: FeeQuote }): Promise<PreflightResult>;
  /** Requests signatures from the attached SpendSigner during witness assembly, then proves. */
  prove(plan: Plan, options?: ProveOptions): Promise<ProofHandle>;
  /** Verifiable single-note disclosure receipt (SPEC §5.3). Available on view-only wallets too. */
  exportDisclosure(txoRef: string): Promise<Uint8Array>;
  /** Export this wallet's shareable viewing key (Railgun wire format) — grants view-only capability. */
  shareViewingKey(): string;
  /**
   * The `(tree, nullifier)` of every currently-spendable owned note — a pure read of the scan state.
   * For an on-chain nullifier cross-check (WI-5): querying the pool's nullifier set for these catches
   * a quick-sync indexer that omitted a `Nullified` event, which the commitment-root verify can't
   * detect (a missing nullifier doesn't change the tree root). Works view-only.
   */
  spendableNullifiers(): readonly { readonly tree: number; readonly nullifier: bigint }[];
  /**
   * Subscribe to scan/balance events (SPEC §5.2); returns an unsubscribe fn. The typed, multi-listener
   * replacement for the stock engine's single global balance callback. Per `sync()` that does work:
   * `scan:started` → `scan:complete`, then `balance:updated` for each token whose balance changed
   * (a token fully spent emits a zero). `scan:error` fires if the scan throws.
   */
  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe;
}

export interface PlanTransferRequest {
  readonly outputs: readonly { to0zk: string; amount: bigint; memo?: string }[];
  readonly unshield?: {
    recipient: `0x${string}`;
    amount: bigint;
    adaptParams?: `0x${string}`;
    adaptContract?: `0x${string}`;
    /** Decoded CCTP binding matching `adaptParams` — surfaced to the signer for destination inspection (§4.2.1). */
    adaptBinding?: CctpBinding;
  };
  readonly fee: FeeQuote;
  /**
   * Token being spent. Defaults to the pool's USDC. Set it to spend a non-USDC shielded balance
   * (e.g. yield vault shares on redeem) — the wallet scans all pool tokens, so any held balance is
   * spendable. Must match the token of the selected input notes.
   */
  readonly tokenAddress?: `0x${string}`;
}

/** Enrollment factory (SPEC §4.2). rootSecret is the canonical identity; no mnemonic intermediary. */
export interface WalletFactory {
  /**
   * Load a wallet from its rootSecret. Spend-capable by DEFAULT (SPEC §4.2.1: `LocalSigner` is the
   * default) — the SDK derives a `LocalSigner` internally, since the rootSecret already grants spend
   * power. Pass `signer` to attach a different signer (e.g. `ExternalSigner`), or `viewOnly: true` for
   * a view-only wallet from a rootSecret (no spend key held; spend-path calls throw NoSpendCapabilityError).
   */
  fromRootSecret(
    rootSecret: Uint8Array,
    opts: { creationBlock: number; signer?: SpendSigner; viewOnly?: boolean },
  ): Promise<Wallet>;
  /** Ephemeral, in-memory only, never persisted — for claimable payments (SPEC §6). */
  ephemeralFromSeed(seed: Uint8Array): Promise<Wallet>;
  /**
   * BIP-39 compat for the relayer's mnemonic-provisioned wallet. Validates the mnemonic checksum;
   * spend-capable by default (auto-derives a `LocalSigner`), with `signer`/`viewOnly` overrides and an
   * optional `derivationIndex` (default 0).
   */
  fromMnemonic(
    mnemonic: string,
    opts: { creationBlock: number; signer?: SpendSigner; viewOnly?: boolean; derivationIndex?: number },
  ): Promise<Wallet>;
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
