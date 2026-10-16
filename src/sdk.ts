// ABOUTME: createArmadaSdk instance (SPEC §4.1) — composes chain client + sync + prover + tx + wallet into a
// ABOUTME: per-instance handle (no singletons). Wallets sync from RPC, report balances, plan, and prove.

import {
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  reconstructHistory,
  erc20AddressFromHash,
  encodeSelfMetadata,
  type SyncEventMap,
  type TXO,
  type TokenAddressResolver,
  type Unsubscribe,
  type HistoryEntry,
  type ReceiverNoteKeys,
  type TokenBalance,
} from './sync/index';
import {
  WalletScanState,
  RpcEventSource,
  IndexerEventSource,
  SyncEmitter,
  decryptedCommitmentMatches,
  tryDecryptShield,
  shieldCommitmentMatches,
  ownedNoteFromTransactNote,
  newReceivedNotes,
  saveScanState,
  loadScanState,
  SCAN_STATE_KEY,
  PendingSpends,
  loadPendingSpends,
  savePendingSpends,
  tokenHashKey,
  withTokenAddresses,
  EncryptedStore,
  deriveWalletStorageKey,
  walletRecordId,
  planSpend,
  planWitnessInputs,
  prove,
  proveAll,
  runPreflight,
  type EventSource,
  type WalletDecryptors,
  type ProveParams,
} from './internal/index';
import type { StorageAdapter } from './storage/index';
import { ScopedStore } from './storage/scoped';
import { isCrossChainUnshield, type Plan, type PlanSelection, type ProofHandle, type PreflightResult } from './tx/index';
import { planConsolidate, txosAfterConsolidation } from './tx/consolidate';
import { maxTransferAmount, maxUnshieldAmount } from './tx/max-transfer';
import type { PlanTransferParams } from './tx/plan';
import { planList } from './tx/plan';
import type { WitnessOutputRequest } from './tx/witness';
import {
  deriveKeyset,
  deriveKeysetFromMnemonic,
  deriveViewOnlyIdentity,
  decodeShareableViewingKey,
  encodeShareableViewingKey,
  LocalSigner,
  type Keyset,
  type Wallet,
  type WalletFactory,
  type PlanTransferRequest,
  type ConsolidateRequest,
  type MaxTransferRequest,
  type MaxUnshieldRequest,
  type SpendSigner,
} from './wallet/index';
import {
  getTokenDataERC20,
  getTokenDataHash,
  ChainType,
  OutputType,
  TransactNote,
  encodeAddress,
  initPoseidonPromise,
  initCurve25519Promise,
  type TokenData,
  type TokenDataGetter,
  type Chain,
} from './core/index';
import type { ProveOptions, ProverAdapter, ArtifactSource } from './prover/index';
import {
  NoSpendCapabilityError,
  RootMismatchError,
  InvalidRequestError,
  QuickSyncSchemaError,
  SignerContractViolationError,
  InstanceClosedError,
} from './errors';
import { resolveConfig, type ResolvedConfig } from './config';
import { ChainClient } from './chain/client';
import { startAutoSync } from './sync/auto-sync';
import type { ArmadaSdk, ArmadaSdkConfig, ReorgRecoveryReason, TelemetrySink } from './index';

// Per-instance shared context handed to each wallet.
interface SdkContext {
  /** The validated config with every default applied. */
  readonly config: ResolvedConfig;
  /**
   * The RPC: the chain/pool check, pool logs and view reads, block hashes/timestamps. Its `ensureChain()` is awaited
   * before any sync or preflight, so no checkpoint from the wrong chain is ever saved.
   */
  readonly chainClient: ChainClient;
  /** Primary event source — the indexer when configured, else the RPC source. */
  readonly eventSource: EventSource;
  /** Always the RPC source: covers any tail the indexer lags, and is the verification fallback. */
  readonly rpcEventSource: RpcEventSource;
  readonly tokenDataGetter: TokenDataGetter;
  readonly chain: Chain;
  /** Active `wallet.watch()` stop functions for this SDK instance — stopped on `close()`. */
  readonly watchers: Set<() => void>;
  /** Every wallet the instance has handed out and not yet disposed — `close()` disposes them. */
  readonly wallets: Set<ArmadaWallet>;
  /** Set once `close()` starts; from then on the factory refuses new wallets. */
  readonly lifecycle: { closed: boolean };
  /** Canonical 32-byte hash (no 0x) of USDC — maps owned-note token hashes back to the address. */
  readonly usdcHash: string;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
  /** Raw environment adapter (already opened). Per-wallet stores wrap this with at-rest encryption. */
  readonly storage: StorageAdapter;
  /**
   * Optional operational telemetry sink (SPEC §8), wrapped by `safeTelemetry` — a consumer's sink that throws
   * can never affect the SDK.
   */
  readonly telemetry?: TelemetrySink;
}

/**
 * Why an untrusted-indexer quick-sync attempt was discarded for an RPC re-scan. The `outcome` field
 * keeps its two historical values (back-compat); `reason` disambiguates the ≥4 distinct causes that
 * `root-mismatch-fallback` used to conflate (#83). `unknown` is the honest bucket for an unexpected
 * cause — never silently folded into `root-mismatch`.
 */
export type QuickSyncReason = 'indexer-http-error' | 'schema-mismatch' | 'root-mismatch' | 'position-gap' | 'unknown';

/** Quick-sync observability payload emitted through the telemetry sink (SPEC §8-safe: block numbers + booleans only). */
export interface QuickSyncTelemetry {
  /** `served` = the indexer batch verified against the on-chain root; `root-mismatch-fallback` = it
   *  didn't, so the batch was discarded and the range re-scanned from RPC (truth). */
  readonly outcome: 'served' | 'root-mismatch-fallback';
  readonly fromBlock: number;
  readonly head: number;
  /** On the `served` path: the indexer lagged the chain head and RPC covered the tail. Always false on fallback. */
  readonly tailCovered: boolean;
  /** Set only on fallback: the classified cause of the discard (SPEC §8-safe — an enum, no PII). */
  readonly reason?: QuickSyncReason;
  /** Set only for an `indexer-http-error` fallback: the non-OK HTTP status the indexer returned. */
  readonly status?: number;
}

/**
 * Map a caught quick-sync fallback cause to its telemetry reason (+ HTTP status when applicable). Pure
 * and keyed on the typed-error `code` (never message text), so a 404 from a legacy endpoint is reported
 * as `indexer-http-error`, not a misleading `root-mismatch`. An unrecognized cause is `unknown` — the
 * classifier never asserts a cause it doesn't actually know (SPEC §8, #83).
 */
export function classifyQuickSyncReason(cause: unknown): { reason: QuickSyncReason; status?: number } {
  // Match on the stable `code`, not `instanceof`: identity checks break under the dual-package hazard
  // (an error thrown by one SDK copy fails `instanceof` in another) and contradict the errors.ts rule.
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code: unknown }).code : undefined;
  switch (code) {
    case 'INDEXER_HTTP': {
      const status = (cause as { status?: unknown }).status;
      return typeof status === 'number' ? { reason: 'indexer-http-error', status } : { reason: 'indexer-http-error' };
    }
    case 'QUICK_SYNC_SCHEMA':
      return { reason: 'schema-mismatch' };
    case 'ROOT_MISMATCH':
      return { reason: 'root-mismatch' };
    case 'POSITION_GAP':
      return { reason: 'position-gap' };
    default:
      return { reason: 'unknown' };
  }
}

/**
 * Decide the quick-sync observability event for a completed sync. Pure so the outcome taxonomy is
 * unit-testable without a provider. Returns null when no indexer is in play — a pure RPC sync has
 * nothing quick-sync to report. SPEC §8: the payload carries only block numbers + booleans + a
 * classified `reason` enum, never keys, addresses, or note plaintext.
 */
export function quickSyncTelemetry(input: {
  usingIndexer: boolean;
  tailCovered: boolean;
  fellBack: boolean;
  fromBlock: number;
  head: number;
  /** The caught fallback cause (only meaningful when `fellBack`); classified into `reason`/`status`. */
  cause?: unknown;
}): { event: 'sync.quicksync'; data: QuickSyncTelemetry } | null {
  if (!input.usingIndexer) return null;
  // Only fallbacks carry a cause to classify; the served path emits neither reason nor status.
  const { reason, status } = input.fellBack ? classifyQuickSyncReason(input.cause) : { reason: undefined, status: undefined };
  return {
    event: 'sync.quicksync',
    data: {
      outcome: input.fellBack ? 'root-mismatch-fallback' : 'served',
      fromBlock: input.fromBlock,
      head: input.head,
      // On a fallback the indexer batch was discarded and the whole range RPC-rescanned, so tail-cover
      // is only meaningful on the served path.
      tailCovered: input.fellBack ? false : input.tailCovered,
      ...(reason !== undefined ? { reason } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
}

// A wallet's keys without the spending PRIVATE key: the wallet only ever needs the public half (for the witness).
// Signing is the SpendSigner's job, so the private key lives in the signer or nowhere (#140).
type WalletKeys = Omit<Keyset, 'spendingPrivateKey'>;

function withoutSpendKey(keyset: Keyset): WalletKeys {
  return {
    spendingPublicKey: keyset.spendingPublicKey,
    viewingPublicKey: keyset.viewingPublicKey,
    viewingPrivateKey: keyset.viewingPrivateKey,
    nullifyingKey: keyset.nullifyingKey,
    masterPublicKey: keyset.masterPublicKey,
    shieldedAddress: keyset.shieldedAddress,
  };
}

// The signer a factory attaches to a freshly derived keyset, leaving at most one copy of the spend key: a LocalSigner
// takes the derived buffer as its own; with an explicit signer, or view-only, the derived key is zeroed at once.
async function signerFor(keyset: Keyset, opts: { signer?: SpendSigner; viewOnly?: boolean }): Promise<AttachedSigner | undefined> {
  if (opts.signer !== undefined) {
    keyset.spendingPrivateKey.fill(0);
    await assertSignerHoldsKey(opts.signer, keyset.spendingPublicKey);
    return { signer: opts.signer, owned: false };
  }
  if (opts.viewOnly === true) {
    keyset.spendingPrivateKey.fill(0);
    return undefined;
  }
  return { signer: LocalSigner.fromKeyset(keyset), owned: true };
}

// A wallet's signer, and whether the SDK made it. `wallet.dispose()` disposes only a signer the SDK made: one the app
// passed in is the app's to dispose (it may serve other wallets).
interface AttachedSigner {
  readonly signer: SpendSigner;
  readonly owned: boolean;
}

// A signer must hold the wallet's spending key: one that doesn't would be accepted as `canSpend`, then fail as an
// opaque circuit error after its signatures were released (#140).
async function assertSignerHoldsKey(signer: SpendSigner, spendingPublicKey: readonly [bigint, bigint]): Promise<void> {
  const [x, y] = await signer.getSpendingPublicKey();
  if (x !== spendingPublicKey[0] || y !== spendingPublicKey[1]) {
    throw new SignerContractViolationError("the SpendSigner's spending public key isn't this wallet's");
  }
}

// The storage layout version, part of the deployment namespace: a store written under another version is reset
// (chain-derived records wiped and rebuilt by a rescan). 2: wallet records moved under per-wallet scopes (#138).
const STORAGE_SCHEMA_VERSION = 2;

/**
 * Resolve the per-wallet storage handle: the wallet's own scope of the shared adapter (`ScopedStore`, tagged with
 * the wallet's opaque record id), so wallets sharing an adapter can't list, overwrite or decrypt each other's
 * records (SPEC §4.3, WS-2). By default the scope wraps an `EncryptedStore` keyed per wallet (from the viewing
 * private key), so decrypted note data is AEAD-encrypted at rest without the caller doing anything (WS7.2
 * Option B), with the full scoped key as the AAD. `allowPlaintext` (the `dangerouslyAllowPlaintextStorage` config
 * flag) drops only the encryption — the only path to plaintext at rest. Exported so the defaults are unit-testable
 * without a live chain.
 */
export function resolveWalletStorage(
  raw: StorageAdapter,
  viewingPrivateKey: Uint8Array,
  allowPlaintext: boolean,
): StorageAdapter {
  const values = allowPlaintext ? raw : new EncryptedStore(raw, deriveWalletStorageKey(viewingPrivateKey));
  return new ScopedStore(values, walletRecordId(viewingPrivateKey));
}

/**
 * Whether a completed sync still owes a final on-chain root verification (SPEC §4.4: "root
 * verification after each batch"). The indexer-served path already verified before acceptance, so
 * only the RPC baseline path and the post-fallback RPC rescan need the closing check — but every
 * sync ends having confirmed its accepted tree against the pool's root. Pure so the invariant
 * "the RPC baseline path is never left unverified" (the H3 regression) is unit-testable.
 */
export function finalRootCheckRequired(usingIndexer: boolean, fellBack: boolean): boolean {
  return !usingIndexer || fellBack;
}

/**
 * The head block a sync scans TO — the chain head minus `confirmationDepth` (SPEC §4.4 reorg safety). By
 * not scanning the last `confirmationDepth` blocks, a reorg of that depth or shallower can never remove a
 * commitment we already persisted (the append-only tree can't un-append it), so the phantom-leaf/stuck-sync
 * failure mode is avoided at the source. `0` (default) scans to head. Floored at 0. Pure for testability.
 */
export function effectiveScanHead(rawHead: number, confirmationDepth: number): number {
  return Math.max(0, rawHead - confirmationDepth);
}

/**
 * Whether a sync should self-heal from a reorg-poisoned PERSISTED tree by resetting + rescanning, rather
 * than rethrowing (SPEC §4.4). True only when the failure is a `RootMismatchError`, the pre-batch (persisted)
 * state ITSELF fails root verification (so the poison predates this batch — a reorg removed an already-scanned
 * leaf), and we are not already inside a recovery (guards an infinite reset loop). Pure for testability.
 */
export function shouldRecoverFromReorg(error: unknown, persistedRootsInvalid: boolean, recovering: boolean): boolean {
  return error instanceof RootMismatchError && persistedRootsInvalid && !recovering;
}

/**
 * Whether a sync failure means the local tree is MISSING leaves: a leaf arrived beyond the tree's next
 * position, so part of the chain was skipped — a checkpoint that advanced past unapplied events, or a tree
 * started after the pool's first commitment. No retry fills that gap; only a rescan can. Keyed on the
 * error's `code` and fields, not identity (dual-package safe). Pure for testability.
 */
export function scanStateMissingLeaves(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; expected?: unknown; received?: unknown };
  return e.code === 'POSITION_GAP' && typeof e.expected === 'number' && typeof e.received === 'number' && e.received > e.expected;
}

/**
 * Build a `balance:updated` payload for a token, resolving its address via `resolve`. The payload
 * carries BOTH the canonical `tokenHash` (normalized to the `balances()` join key) and the resolved
 * `tokenAddress`. Returns `undefined` for a hash with no registered token — an address can't be
 * recovered, so the caller skips the emit. Pure so the payload shape is unit-testable without a wallet.
 */
export function buildBalanceUpdate(
  tokenHash: string,
  spendable: bigint,
  pending: bigint,
  resolve: TokenAddressResolver,
): SyncEventMap['balance:updated'] | undefined {
  const tokenAddress = resolve(tokenHash);
  if (tokenAddress === undefined) return undefined; // unregistered token — no address to report
  return { tokenHash: tokenHashKey(tokenHash), tokenAddress, spendable, pending };
}

/**
 * Build a `note:received` payload from a freshly discovered owned TXO, resolving its token address
 * via `resolve`. Carries both `tokenHash` and `tokenAddress`, plus memo/sender when the sender
 * disclosed them. Returns `undefined` for an unregistered token (skipped — no address to report).
 */
export function buildReceivedNote(txo: TXO, resolve: TokenAddressResolver): SyncEventMap['note:received'] | undefined {
  const tokenAddress = resolve(txo.tokenHash);
  if (tokenAddress === undefined) return undefined; // unregistered token — no address to report
  return {
    tokenHash: tokenHashKey(txo.tokenHash),
    tokenAddress,
    value: txo.value,
    ...(txo.memo !== undefined ? { memo: txo.memo } : {}),
    ...(txo.senderShieldedAddress !== undefined ? { senderShieldedAddress: txo.senderShieldedAddress } : {}),
  };
}

/**
 * Decide a sync's resume window from the last synced block + current chain head. Pure so the
 * resume decision (the thing that must never regress to a genesis rescan) is unit-testable without
 * a provider. `fromBlock` is the resume point (checkpoint + 1); `scanned` is false when the head
 * hasn't advanced past the checkpoint, so no getLogs work is done.
 */
export function planSyncWindow(
  syncedThrough: number,
  head: number,
): { fromBlock: number; scanned: boolean } {
  return { fromBlock: syncedThrough + 1, scanned: head > syncedThrough };
}

// Max concurrent `getBlock` calls when attaching timestamps in history() — bounds RPC fan-out.
const HISTORY_BLOCK_CONCURRENCY = 8;

// Any EVM address: a plain unshield's max doesn't depend on where it goes, only on its value.
const MAX_UNSHIELD_PROBE_RECIPIENT = '0x0000000000000000000000000000000000000001' as const;

class ArmadaWallet implements Wallet {
  private scanState = new WalletScanState();
  private syncedThrough: number;
  // Hash of block `syncedThrough` when it was scanned — the reorg check compares it with the chain's
  // current hash at that height. Undefined before the first sync (or when the node didn't return it).
  private syncedThroughHash: string | undefined;
  // Optimistic in-flight spend holds (issue #55) — the wallet's own intent, kept apart from the chain-derived
  // scan state (which a sync replaces wholesale) and written durably whenever a hold changes.
  private holds = new PendingSpends();
  private readonly emitter = new SyncEmitter();
  // Last-emitted per-token balance (keyed by tokenHash, no 0x) so a sync only pushes `balance:updated`
  // for tokens that actually changed — the diff that lets consumers avoid redundant re-reads.
  private readonly lastBalances = new Map<string, { spendable: bigint; pending: bigint }>();
  // Received-transfer keys already emitted as `note:received`. A loaded wallet seeds this from its saved
  // notes; a wallet with no saved state seeds it on its first sync WITHOUT emitting (so a fresh wallet
  // doesn't replay its history as "received"). Later syncs emit only genuinely-new incoming notes.
  private readonly seenReceiveKeys = new Set<string>();
  private receiveBaselined = false;
  // The in-flight sync run, if any — concurrent sync() calls coalesce onto it instead of both building on
  // the same committed state (which would double-apply a range and throw a position gap).
  private syncInFlight: Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> | undefined;
  // The active auto-sync unsubscribe (issue #59), if this wallet is watching — one loop per wallet.
  private watchStop: Unsubscribe | undefined;
  // In-flight proofs: dispose() waits for them, so it never wipes keys a witness is still being built from.
  private readonly proving = new Set<Promise<unknown>>();
  // Aborted by dispose(): cancels in-flight proofs, telling a signer still waiting on approval to stop, so dispose()
  // doesn't wait on a person.
  private readonly lifetime = new AbortController();
  // Set by dispose() (directly, or via sdk.close()): every call afterwards throws InstanceClosedError.
  private disposed = false;
  private readonly signer: SpendSigner | undefined;
  private readonly ownsSigner: boolean;

  constructor(
    private readonly keyset: WalletKeys,
    private readonly creationBlock: number,
    attached: AttachedSigner | undefined,
    private readonly ctx: SdkContext,
    // Ephemeral (claimable-payment) wallets are in-memory only: they never load from or write to
    // the StorageAdapter, so no decrypted note data or seed-derived identity hits disk (SPEC §4.3/§6.5).
    private readonly ephemeral: boolean = false,
  ) {
    // The tree is always built from the pool's deploy block: it is append-only from leaf 0, so starting
    // later would hit the first earlier commitment as a position gap. `creationBlock` only limits which
    // notes the wallet looks for (see `decryptors`).
    this.syncedThrough = ctx.config.deployBlock - 1;
    // This wallet's own scope of the shared adapter, encrypted at rest by default (§4.3).
    this.storage = resolveWalletStorage(ctx.storage, keyset.viewingPrivateKey, ctx.config.allowPlaintextStorage);
    this.signer = attached?.signer;
    this.ownsSigner = attached?.owned === true;
    ctx.wallets.add(this);
  }

  private assertUsable(): void {
    if (this.disposed) throw new InstanceClosedError('wallet: used after wallet.dispose() or sdk.close()');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watchStop?.();
    this.lifetime.abort();
    // Let in-flight work settle first: a sync stops at its next step (it checks `disposed`), and a proof stops on its
    // aborted signal. Only then are the keys they read wiped.
    await Promise.allSettled([this.syncInFlight, ...this.proving]);
    if (this.ownsSigner) this.signer?.dispose?.();
    // Best-effort: the viewing key buffer is wiped, but bigint keys (the nullifying key) can't be, and the engine may
    // hold string copies of key material (docs/guide/security.md).
    this.keyset.viewingPrivateKey.fill(0);
    this.ctx.wallets.delete(this);
  }

  // This wallet's storage handle: its own scope of the shared adapter (under its opaque record id, never the 0zk
  // address — record keys are plaintext, §4.3), wrapping an EncryptedStore unless plaintext is allowed.
  private readonly storage: StorageAdapter;

  get shieldedAddress(): string {
    return this.keyset.shieldedAddress;
  }
  get canSpend(): boolean {
    return this.signer !== undefined;
  }
  get persists(): boolean {
    return !this.ephemeral;
  }

  private receiver(): ReceiverNoteKeys {
    return {
      addressData: { masterPublicKey: this.keyset.masterPublicKey, viewingPublicKey: this.keyset.viewingPublicKey },
      viewingPrivateKey: this.keyset.viewingPrivateKey,
    };
  }

  /**
   * Load this wallet's saved state — scan checkpoint and spend holds — so a sync resumes instead of
   * rescanning. The factory calls this once before returning the wallet, so every read (including the
   * synchronous ones) sees the saved state from the start. Ephemeral wallets never touch storage (§6.5).
   */
  async load(): Promise<void> {
    if (this.ephemeral) return;
    const persisted = await loadScanState(this.storage);
    if (persisted !== undefined && persisted.syncedThrough > this.syncedThrough) {
      this.scanState = persisted.state;
      this.syncedThrough = persisted.syncedThrough;
      this.syncedThroughHash = persisted.syncedThroughHash;
      // The saved notes are already known: seed the receive baseline from them, so the first sync reports
      // exactly the notes that arrived since the checkpoint (e.g. while the app was closed).
      newReceivedNotes(this.scanState.ownedTxos(), this.scanState.spentNullifiers(), this.keyset.nullifyingKey, this.seenReceiveKeys);
      this.receiveBaselined = true;
    }
    this.holds = await loadPendingSpends(this.storage);
    // A hold whose spend the saved state already confirms is done.
    this.holds.releaseConfirmed(this.scanState.spentNullifiers());
  }

  // Trial-decrypt closures over this wallet's viewing key — shared by the primary + tail applies. Notes
  // committed before `creationBlock` are not looked for: the wallet didn't exist yet (the tree still
  // includes their leaves).
  private decryptors(): WalletDecryptors {
    const receiver = this.receiver();
    const discovers = (blockNumber: number): boolean => blockNumber >= this.creationBlock;
    return {
      transact: async (c) => {
        if (!discovers(c.blockNumber)) return undefined;
        const note = await tryDecryptCommitment(c.ciphertext, receiver, this.ctx.tokenDataGetter, this.ctx.chain);
        if (note === undefined) return undefined;
        // Verify the decrypted preimage hashes to the on-chain commitment (engine 9.6.0 fix): drop a
        // crafted ciphertext whose (npk, token, value) don't match the committed leaf, rather than
        // record a wrong-value TXO that inflates the balance and can't be spent.
        if (!decryptedCommitmentMatches(note, c.hash)) return undefined;
        return ownedNoteFromTransactNote(note);
      },
      shield: async (c) => {
        if (!discovers(c.blockNumber)) return undefined;
        const owned = await tryDecryptShield(c, receiver);
        // The RPC decoder derives the leaf hash from these same fields, so a mismatch can only come from a
        // quick-sync indexer misstating our note's value or token. Throw (don't drop): the indexer batch is
        // discarded and the range rescanned from RPC, so the note is recorded with its real value.
        if (owned !== undefined && !shieldCommitmentMatches(c)) {
          throw new QuickSyncSchemaError(`quick-sync: shield ${c.tree}:${c.position} value/token does not match its leaf hash`);
        }
        return owned;
      },
      sentTransact: async (c) => {
        if (!discovers(c.blockNumber)) return undefined;
        const note = await tryDecryptSentCommitment(c.ciphertext, receiver, this.ctx.tokenDataGetter, this.ctx.chain);
        if (note === undefined) return undefined;
        const outputType = note.outputType ?? OutputType.Transfer;
        if (outputType === OutputType.Change) return undefined; // change is handled receive-side
        return {
          txid: c.txid,
          blockNumber: c.blockNumber,
          tokenHash: note.tokenHash,
          value: note.value,
          recipientShieldedAddress: encodeAddress(note.receiverAddressData),
          outputType,
          ...(note.memoText !== undefined && note.memoText !== '' ? { memo: note.memoText } : {}),
        };
      },
    };
  }

  // Apply a source's batch for [from, to] and report how far it covered. `onProgress` is threaded into
  // the fetch, so it fires per block-window as the source chunks the range — driving granular progress.
  private async applyBatch(
    state: WalletScanState,
    source: EventSource,
    from: number,
    to: number,
    decryptors: WalletDecryptors,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<number> {
    const batch = await source.getEvents(from, to, onProgress);
    await state.apply(batch.events, decryptors);
    return batch.syncedThroughBlock;
  }

  // Sync [from, head] from the primary source, RPC-covering any tail the (indexer) source lagged.
  // Returns `tailCovered` — true when the primary (indexer) source stopped short of head and RPC
  // covered the remainder, for quick-sync observability.
  private async applyToHead(
    state: WalletScanState,
    from: number,
    head: number,
    decryptors: WalletDecryptors,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<{ tailCovered: boolean }> {
    const covered = await this.applyBatch(state, this.ctx.eventSource, from, head, decryptors, onProgress);
    if (covered < head) {
      await this.applyBatch(state, this.ctx.rpcEventSource, covered + 1, head, decryptors, onProgress);
      return { tailCovered: true };
    }
    return { tailCovered: false };
  }

  /**
   * Verify EVERY built tree's root is an accepted on-chain root for that tree (`pool.rootHistory`), not
   * just the current (highest) tree. A dropped tail of a COMPLETED tree does not shift the current tree's
   * root, so a single-tree check misses it; a per-tree `rootHistory` membership check catches any
   * dropped/reordered/extra commitment in any tree. `rootHistory` is cumulative, so the current tree's
   * live root is a member too. `head` is informational (the check is against current chain state).
   */
  private async verifyRoots(state: WalletScanState, head: number): Promise<void> {
    const trees = state.treeNumbers();
    await Promise.all(
      trees.map(async (tree) => {
        const computed = state.treeRoot(tree);
        const root = BigInt(computed.startsWith('0x') ? computed : `0x${computed}`);
        if (!(await this.ctx.chainClient.isKnownRoot(tree, root))) {
          throw new RootMismatchError(`sync: tree ${tree} root ${computed} not in pool rootHistory @block ${head}`);
        }
      }),
    );
  }

  /**
   * Verify the tree a sync built is EXACTLY the pool's tree at the scanned block (SPEC §4.4): the pool's
   * current tree number, leaf count, and root, read pinned to `blockTag`, must match the local tree — and
   * every earlier tree must still pass `verifyRoots`. Membership alone isn't enough for the current tree:
   * the pool records a root after every insert, so a log set cut off at an event boundary (a lagging
   * getLogs backend, an indexer omitting its tail) has a historical root and would pass, letting the
   * checkpoint skip the missing events.
   */
  private async verifySyncedTree(state: WalletScanState, head: number, blockTag: string | number): Promise<void> {
    await this.verifyRoots(state, head);
    const pool = await this.ctx.chainClient.readPoolTree(blockTag);
    const localRoot = BigInt(`0x${state.treeRoot(pool.treeNumber)}`);
    const localLeaves = state.treeLength(pool.treeNumber);
    const aheadOfPool = state.treeNumbers().some((tree) => tree > pool.treeNumber);
    if (aheadOfPool || localLeaves !== pool.nextLeafIndex || localRoot !== pool.merkleRoot) {
      throw new RootMismatchError(
        `sync: tree ${pool.treeNumber} built locally (${localLeaves} leaves, root 0x${localRoot.toString(16)}) does not match ` +
          `the pool @block ${head} (${pool.nextLeafIndex} leaves, root 0x${pool.merkleRoot.toString(16)})`,
      );
    }
  }

  /**
   * Whether the chain was reorganised under the checkpoint: the block hash recorded when `syncedThrough`
   * was scanned is no longer the chain's hash at that height. A reorg at or below the checkpoint always
   * changes it — including the commonest shapes (a tx re-included one block later, a same-height
   * replacement), which otherwise surface as a position gap or as no error at all.
   */
  private async checkpointReorged(): Promise<boolean> {
    if (this.syncedThroughHash === undefined) return false;
    const canonical = await this.ctx.chainClient.getBlockHash(this.syncedThrough);
    return canonical !== undefined && canonical !== this.syncedThroughHash;
  }

  /**
   * Reset chain-derived state and rescan from the deploy block (blunt recovery — a surgical per-tree
   * rebuild is tracked in issue #75). Callers guard against a loop with `recovering`. `reason` goes to
   * telemetry (SPEC §8-safe: an enum and a block number) so an operator can see why rescans happen.
   */
  private async recoverByRescan(
    reason: ReorgRecoveryReason,
  ): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> {
    this.assertUsable();
    this.ctx.telemetry?.emit('sync.reorg-recovery', { fromBlock: this.ctx.config.deployBlock, reason });
    await this.resetChainDerivedState();
    return this.runSync(true);
  }

  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe {
    this.assertUsable();
    return this.emitter.on(event, listener);
  }

  watch(options?: { intervalMs?: number; immediate?: boolean; onError?: (err: Error) => void }): Unsubscribe {
    this.assertUsable();
    if (this.watchStop !== undefined) {
      throw new InvalidRequestError('watch: this wallet is already watching (stop the existing watcher first)');
    }
    const intervalMs = options?.intervalMs ?? this.ctx.config.autoSyncIntervalMs;
    const stop = startAutoSync(() => this.sync(), {
      intervalMs,
      ...(options?.immediate !== undefined ? { immediate: options.immediate } : {}),
      ...(options?.onError !== undefined ? { onError: options.onError } : {}),
    });
    // Wrap stop so it also deregisters from the instance + SDK-close registry, and is idempotent.
    const unsubscribe = (): void => {
      if (this.watchStop !== unsubscribe) return;
      stop();
      this.ctx.watchers.delete(unsubscribe);
      this.watchStop = undefined;
    };
    this.watchStop = unsubscribe;
    this.ctx.watchers.add(unsubscribe); // so close() halts a still-running watcher (§ leaked-timer safety)
    return unsubscribe;
  }

  async syncStatus(): Promise<{ syncedThrough: number; syncing: boolean }> {
    this.assertUsable();
    // Cheap status (SPEC §4.4): the checkpoint (loaded from storage when the wallet was created) + whether
    // a sync is in flight. No getLogs, no state change.
    return { syncedThrough: this.syncedThrough, syncing: this.syncInFlight !== undefined };
  }

  async sync(): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> {
    this.assertUsable();
    // Coalesce concurrent syncs (UI poll + manual refresh) onto one run: two runs both building on the
    // same committed tree would double-apply a range and throw a merkle position gap.
    if (this.syncInFlight !== undefined) return this.syncInFlight;
    const run = this.runSync();
    this.syncInFlight = run;
    try {
      return await run;
    } finally {
      this.syncInFlight = undefined;
    }
  }

  private async runSync(recovering = false): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> {
    // Never scan (and so never save a checkpoint) from an RPC that doesn't serve the configured chain/pool.
    await this.ctx.chainClient.ensureChain();
    // A reorg under the checkpoint (SPEC §4.4) invalidates the persisted tree — the append-only tree can't
    // un-append an orphaned leaf — so rescan. Checked before the head comparison below: a same-height
    // reorg leaves the head unchanged but still replaces the checkpoint block.
    if (!recovering && (await this.checkpointReorged())) return this.recoverByRescan('checkpoint-reorged');
    // Scan only to head − confirmationDepth so a reorg of that depth or shallower can't remove a leaf we
    // already persisted (§4.4 reorg safety); `confirmationDepth: 0` (default) scans to head. A deeper
    // reorg is caught by the checkpoint hash check above.
    const chainHead = await this.ctx.chainClient.getBlockNumber();
    const head = effectiveScanHead(chainHead, this.ctx.config.confirmationDepth);
    const { fromBlock, scanned } = planSyncWindow(this.syncedThrough, head);
    if (!scanned) return { fromBlock, syncedThrough: this.syncedThrough, scanned: false };
    // Pin verification to the exact block scanned — by hash when the node returns it — so the pool state
    // the tree is checked against is the state the logs came from; a reorg of `head` mid-sync makes the
    // pinned read fail instead of verifying against a different chain.
    const headHash = await this.ctx.chainClient.getBlockHash(head);
    const blockTag = headHash ?? head;

    const from = fromBlock;
    const span = head - from + 1;
    const emitProgress = (coveredThrough: number): void => {
      const done = Math.max(0, Math.min(span, coveredThrough - from + 1));
      this.emitter.emit('scan:progress', { syncedThrough: coveredThrough, fraction: span <= 0 ? 1 : done / span });
    };

    this.emitter.emit('scan:started', { fromBlock, toBlock: head });
    this.emitter.emit('scan:progress', { syncedThrough: from - 1, fraction: 0 });

    const decryptors = this.decryptors();
    const usingIndexer = this.ctx.eventSource !== this.ctx.rpcEventSource;
    // Apply the batch to a COPY of the committed state; it replaces the live state only once it is verified
    // and saved. Readers (planning, balances, history) never see a half-applied or unverified batch, and
    // ANY failure below — a partial apply, a root mismatch, a save error — just discards the copy: the
    // committed state and checkpoint were never touched, so a retry re-scans the range cleanly.
    let next = this.scanState.clone();
    try {
      let tailCovered = false;
      let fellBack = false;
      // Preserved so telemetry can classify WHY the indexer batch was discarded (#83) — an HTTP 404, a
      // wire-schema skew, a position gap, or a genuine root mismatch, not one mislabel for all four.
      let fallbackCause: unknown;

      if (usingIndexer) {
        try {
          // The indexer is untrusted: its fetch, wire-schema parse, apply, AND root-verify all live
          // inside this try so ANY failure — malformed/garbage response, HTTP error, position gap, root
          // mismatch — discards the batch and re-scans from RPC (the source of truth), rather than
          // failing the whole sync on a degraded indexer (SPEC §4.4).
          ({ tailCovered } = await this.applyToHead(next, from, head, decryptors, emitProgress));
          await this.verifySyncedTree(next, head, blockTag);
        } catch (err) {
          fellBack = true;
          fallbackCause = err;
          next = this.scanState.clone();
          await this.applyBatch(next, this.ctx.rpcEventSource, from, head, decryptors, emitProgress);
        }
      } else {
        ({ tailCovered } = await this.applyToHead(next, from, head, decryptors, emitProgress));
      }

      // Final guard (SPEC §4.4): the accepted tree — RPC baseline or post-fallback RPC rescan — must
      // reproduce the on-chain root. This is the ONLY verification on the pure-RPC path; a mismatch means
      // the provider returned bad/truncated logs. It throws → the copy is discarded and the checkpoint
      // doesn't advance, so a retry re-scans the range cleanly instead of persisting a corrupt tree.
      if (finalRootCheckRequired(usingIndexer, fellBack)) {
        await this.verifySyncedTree(next, head, blockTag);
      }

      // Quick-sync observability (SPEC §8): report whether the configured indexer served a
      // root-verified batch, lagged into an RPC tail, or was rejected for an RPC re-scan — and, on a
      // rejection, the classified `reason` (+ HTTP status) for it. No-op when no indexer is configured.
      // Never carries key material / addresses.
      const qs = quickSyncTelemetry({ usingIndexer, tailCovered, fellBack, fromBlock: from, head, cause: fallbackCause });
      if (qs !== null) this.ctx.telemetry?.emit(qs.event, qs.data);

      // A wallet disposed mid-sync (or a closing SDK) keeps nothing from it: stop before saving or committing.
      this.assertUsable();
      // Ephemeral wallets keep their scan state in memory only — never write note data to disk (SPEC §6.5).
      if (!this.ephemeral) {
        await saveScanState(this.storage, next, head, headHash);
      }
      // Commit: only now — verified and saved — does the new state become the one readers see, and the
      // checkpoint advance. A save failure above leaves both where they were.
      this.scanState = next;
      this.syncedThrough = head;
      this.syncedThroughHash = headHash;
      await this.releaseConfirmedHolds();
      this.emitter.emit('scan:complete', { syncedThrough: head });
      // Balance events use the chain head, as `balances()` does, so both agree on spendable vs pending.
      this.emitBalanceUpdates(chainHead);
      this.emitReceivedNotes();
      return { fromBlock, syncedThrough: head, scanned: true };
    } catch (err) {
      // Cancelled by dispose()/close() (its RPC calls may fail first, on the destroyed provider): no recovery, no
      // scan:error — the caller learns the wallet is closed.
      if (this.disposed) {
        throw err instanceof InstanceClosedError ? err : new InstanceClosedError('sync: cancelled by wallet.dispose() or sdk.close()', { cause: err });
      }
      // Two failures no retry can fix, so self-heal by rescanning from the deploy block (`recovering`
      // guards a loop): (1) the local tree is missing leaves — a leaf arrived past its next position, so part
      // of the chain was skipped; (2) a reorg removed an already-PERSISTED leaf the hash check couldn't see
      // (a record saved without a hash), so the committed state itself fails root verification.
      if (!recovering && scanStateMissingLeaves(err)) return this.recoverByRescan('missing-leaves');
      if (shouldRecoverFromReorg(err, await this.persistedRootsInvalid(head), recovering)) {
        return this.recoverByRescan('persisted-root-invalid');
      }
      this.emitter.emit('scan:error', { error: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    }
  }

  /** True if the committed (= persisted) tree state fails on-chain root verification. */
  private async persistedRootsInvalid(head: number): Promise<boolean> {
    try {
      await this.verifyRoots(this.scanState, head);
      return false;
    } catch (err) {
      return err instanceof RootMismatchError;
    }
  }

  /**
   * Reset chain-derived state (in-memory + persisted record) to rescan from the deploy block. Identity and
   * the spend holds (issue #55) live outside the scan state, so they survive — dropping a hold here would
   * let a follow-up spend reselect an input whose submission is still in flight.
   */
  private async resetChainDerivedState(): Promise<void> {
    this.scanState = new WalletScanState();
    this.syncedThrough = this.ctx.config.deployBlock - 1;
    this.syncedThroughHash = undefined;
    this.lastBalances.clear();
    this.seenReceiveKeys.clear();
    this.receiveBaselined = false;
    // Delete the poisoned record so a crash mid-rescan can't load it again.
    if (!this.ephemeral) await this.storage.del(SCAN_STATE_KEY);
  }

  // Push `note:received` for incoming transfers discovered since the last sync (`newReceivedNotes`
  // handles the classification + `tree:position` de-dup, mutating `seenReceiveKeys`). A wallet with no
  // saved state seeds the baseline on its first sync WITHOUT emitting, so it doesn't replay history.
  private emitReceivedNotes(): void {
    const fresh = newReceivedNotes(
      this.scanState.ownedTxos(),
      this.scanState.spentNullifiers(),
      this.keyset.nullifyingKey,
      this.seenReceiveKeys,
    );
    if (!this.receiveBaselined) {
      this.receiveBaselined = true;
      return; // baseline: `seenReceiveKeys` is now seeded; don't emit historical receives on first load
    }
    for (const txo of fresh) {
      const payload = buildReceivedNote(txo, (h) => this.resolveTokenAddress(h));
      if (payload === undefined) continue; // unregistered token — can't resolve an address
      this.emitter.emit('note:received', payload);
    }
  }

  // Push `balance:updated` for each token whose (spendable, pending) changed since the last emit —
  // including a token fully spent (drops out of `balances()`, so we emit a zero). Unregistered tokens
  // (unknown hash → no address) are skipped. First sync after load emits the baseline for held tokens.
  private emitBalanceUpdates(head: number): void {
    this.prunePendingSpends();
    const balances = this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: this.ctx.config.finalityThreshold }, this.holds.list());
    const seen = new Set<string>();
    for (const b of balances) {
      seen.add(b.tokenHash);
      const prev = this.lastBalances.get(b.tokenHash);
      if (prev !== undefined && prev.spendable === b.spendable && prev.pending === b.pending) continue;
      this.lastBalances.set(b.tokenHash, { spendable: b.spendable, pending: b.pending });
      this.emitTokenBalance(b.tokenHash, b.spendable, b.pending);
    }
    for (const [tokenHash, prev] of this.lastBalances) {
      if (seen.has(tokenHash) || (prev.spendable === 0n && prev.pending === 0n)) continue;
      this.lastBalances.set(tokenHash, { spendable: 0n, pending: 0n });
      this.emitTokenBalance(tokenHash, 0n, 0n);
    }
  }

  private emitTokenBalance(tokenHash: string, spendable: bigint, pending: bigint): void {
    const payload = buildBalanceUpdate(tokenHash, spendable, pending, (h) => this.resolveTokenAddress(h));
    if (payload === undefined) return; // unregistered token — can't resolve an address to emit
    this.emitter.emit('balance:updated', payload);
  }

  // Resolve an owned-note token hash to its registered ERC-20 address, or undefined when the hash
  // isn't in the SDK's token registry. Shared by `balances()` and the `balance:updated`/`note:received`
  // emit paths so all three surfaces speak the same hash↔address mapping.
  private resolveTokenAddress(tokenHash: string): `0x${string}` | undefined {
    // ERC20 token hashes are self-describing (the hash IS the padded address) — resolve any pool token
    // directly, no registry (issue #90). Non-ERC20 (NFT) hashes are out of scope and return undefined.
    return erc20AddressFromHash(tokenHash);
  }

  async balances(): Promise<TokenBalance[]> {
    this.assertUsable();
    this.prunePendingSpends();
    const head = await this.ctx.chainClient.getBlockNumber();
    const raw = this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: this.ctx.config.finalityThreshold }, this.holds.list());
    return withTokenAddresses(raw, (h) => this.resolveTokenAddress(h));
  }

  spendableNullifiers(): readonly { readonly tree: number; readonly nullifier: bigint }[] {
    this.assertUsable();
    return this.scanState
      .spendableTxos(this.keyset.nullifyingKey, this.holds.list())
      .map((txo) => ({ tree: txo.tree, nullifier: TransactNote.getNullifier(this.keyset.nullifyingKey, txo.position) }));
  }

  async preflight(plan: Plan | readonly Plan[], options?: { quoteDeadline?: number }): Promise<PreflightResult> {
    this.assertUsable();
    // Cheap pre-proof checks (SPEC §4.7): the proved root must still be accepted by the pool, no input
    // note may already be spent on-chain, and (if a deadline is given) the fee quote must still be usable —
    // turning the 30-second-proof-then-revert failure into a typed finding. Nullifiers are derived from
    // THIS plan's selected inputs (not the whole wallet), so it works view-only too.
    await this.ctx.chainClient.ensureChain();
    const plans = planList(plan);
    const nullifiers = this.planNullifiers(plans);
    // Cross-chain unshield (a CCTP adaptParams binding) → add a messenger-liveness check when configured.
    const messenger = this.ctx.config.cctpMessenger;
    const isCrossChain = plans.some((p) => isCrossChainUnshield(p.boundParams, this.ctx.config.yieldAdapterAddress));
    const cctpLiveness =
      isCrossChain && messenger !== undefined
        ? (): Promise<boolean> => this.ctx.chainClient.hasCode(messenger)
        : undefined;
    return runPreflight({
      plan,
      nullifiers,
      queries: {
        isKnownRoot: (tree, root) => this.ctx.chainClient.isKnownRoot(tree, root),
        isNullifierSpent: (tree, nullifier) => this.ctx.chainClient.isNullifierSpent(tree, nullifier),
      },
      ...(options?.quoteDeadline !== undefined ? { quoteDeadline: options.quoteDeadline } : {}),
      ...(cctpLiveness !== undefined ? { cctpLiveness } : {}),
      now: Date.now(),
    });
  }

  async history(options?: { sinceBlock?: number }): Promise<HistoryEntry[]> {
    this.assertUsable();
    let entries = reconstructHistory({
      ownedTxos: this.scanState.ownedTxos(),
      spentNullifiers: this.scanState.spentNullifiers(),
      unshields: this.scanState.unshieldEvents(),
      sentOutputs: this.scanState.sentOutputs(),
      shieldRelayerFees: this.scanState.shieldRelayerFees(),
      nullifyingKey: this.keyset.nullifyingKey,
      shieldedAddress: this.keyset.shieldedAddress,
      resolveToken: (h) => this.resolveTokenAddress(h),
      usdcHash: this.ctx.usdcHash,
      ...(this.ctx.config.yieldAdapterAddress !== undefined ? { yieldAdapterAddress: this.ctx.config.yieldAdapterAddress } : {}),
    });
    if (options?.sinceBlock !== undefined) {
      const since = options.sinceBlock;
      entries = entries.filter((e) => e.blockNumber >= since);
    }
    // Attach block timestamps, fetched over the distinct blocks the entries touch. Capped concurrency:
    // an unbounded Promise.all over a 10k-note wallet's blocks would flood the RPC and get rate-limited.
    const times = new Map<number, number>();
    const distinctBlocks = [...new Set(entries.map((e) => e.blockNumber))];
    for (let i = 0; i < distinctBlocks.length; i += HISTORY_BLOCK_CONCURRENCY) {
      const chunk = distinctBlocks.slice(i, i + HISTORY_BLOCK_CONCURRENCY);
      await Promise.all(
        chunk.map(async (b) => {
          const timestamp = await this.ctx.chainClient.getBlockTimestamp(b);
          if (timestamp !== undefined) times.set(b, timestamp);
        }),
      );
    }
    return entries.map((e) => {
      const ts = times.get(e.blockNumber);
      return ts !== undefined ? { ...e, timestamp: ts } : e;
    });
  }

  async planTransfer(request: PlanTransferRequest): Promise<Plan[]> {
    this.assertUsable();
    if (!this.canSpend) throw new NoSpendCapabilityError('planTransfer: wallet has no SpendSigner');
    this.prunePendingSpends();
    const txos = this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list());
    // A fragmented transfer yields >1 group, submitted atomically as one transact([...]); each group is
    // an independent Plan proved separately (the caller proves all, then combines the calldata).
    return this.withMerkleProofs(planSpend(this.spendParams(request, txos, this.rootsFor(txos))));
  }

  async planTransferAfter(consolidation: readonly Plan[], request: PlanTransferRequest): Promise<PlanSelection[]> {
    this.assertUsable();
    this.prunePendingSpends();
    // Plan over the notes as they'd be once the consolidation confirms (its merged notes in the current
    // tree). Planning only — the hypothetical notes can't be proved, so no merkle proofs are captured.
    const currentTree = this.currentTree();
    const txos = txosAfterConsolidation(
      this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list()),
      consolidation,
      currentTree,
    );
    const roots = this.rootsFor(txos);
    if (!roots.has(currentTree)) roots.set(currentTree, BigInt(`0x${this.scanState.treeRoot(currentTree)}`));
    return planSpend(this.spendParams(request, txos, roots));
  }

  async maxTransferAmount(request: MaxTransferRequest): Promise<bigint> {
    this.assertUsable();
    this.prunePendingSpends();
    const txos = this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list());
    // The planner request for a transfer (`transfer` fee tier); the max probes it with its own amounts.
    return maxTransferAmount(this.spendParams({ ...request, outputs: [] }, txos, this.rootsFor(txos)));
  }

  async maxUnshieldAmount(request: MaxUnshieldRequest): Promise<bigint> {
    this.assertUsable();
    this.prunePendingSpends();
    const txos = this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list());
    // The planner request for this unshield (at the caller's per-proof fee); the max probes its value.
    const destination = request.unshield ?? { recipient: MAX_UNSHIELD_PROBE_RECIPIENT };
    const params = this.spendParams(
      {
        outputs: [],
        ...(request.fee !== undefined ? { fee: request.fee } : {}),
        ...(request.tokenAddress !== undefined ? { tokenAddress: request.tokenAddress } : {}),
        unshield: { ...destination, amount: 0n },
      },
      txos,
      this.rootsFor(txos),
    );
    return maxUnshieldAmount({ ...params, unshield: params.unshield! });
  }

  async consolidate(request: ConsolidateRequest): Promise<Plan[]> {
    this.assertUsable();
    if (!this.canSpend) throw new NoSpendCapabilityError('consolidate: wallet has no SpendSigner');
    const supportedShapes = this.ctx.config.supportedShapes;
    if (supportedShapes === undefined) {
      throw new InvalidRequestError('consolidate: pool.supportedShapes is required (it sizes the merge groups)');
    }
    this.prunePendingSpends();
    const txos = this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list());
    // A consolidation is a bare transact() self-spend, priced by the relayer at the `transfer` tier, PER
    // PROOF, always in USDC (the only token the relayer counts).
    const fee = request.fee;
    return this.withMerkleProofs(
      planConsolidate({
        txos,
        tokenAddress: request.tokenAddress ?? this.ctx.config.usdcAddress,
        ...(fee !== undefined && fee.perProof > 0n
          ? {
              fee: {
                broadcasterShieldedAddress: fee.broadcasterShieldedAddress,
                value: fee.perProof,
                tokenAddress: this.ctx.config.usdcAddress,
              },
            }
          : {}),
        roots: this.rootsFor(txos),
        currentTree: this.currentTree(),
        chainID: BigInt(this.ctx.config.chainId),
        supportedShapes,
      }),
    );
  }

  // The pool's current (latest) tree: the scan rebuilds every tree, so the highest one seen.
  private currentTree(): number {
    const trees = this.scanState.treeNumbers();
    return trees.length === 0 ? 0 : Math.max(...trees);
  }

  // The current root of every tree the notes sit in, read from the same scan state the proofs come from.
  private rootsFor(txos: readonly TXO[]): Map<number, bigint> {
    const roots = new Map<number, bigint>();
    for (const txo of txos) {
      if (!roots.has(txo.tree)) roots.set(txo.tree, BigInt(`0x${this.scanState.treeRoot(txo.tree)}`));
    }
    return roots;
  }

  /**
   * Reject a cross-chain (CCTP) unshield the hub pool would revert (#134), before any proving. It is cross-chain
   * when it carries a CCTP binding, or commits `adaptParams` to anything but the yield adapter (the same test
   * preflight uses). It must then:
   *   - carry its decoded `adaptBinding`, so the planner can check `maxFee < value`;
   *   - spend USDC (CCTP bridges USDC only);
   *   - pay the pool (the final recipient is in the binding);
   *   - name no `adaptContract`.
   */
  private assertCrossChainUnshield(request: PlanTransferRequest): void {
    const unshield = request.unshield;
    if (unshield === undefined) return;
    const crossChain =
      unshield.adaptBinding !== undefined ||
      (unshield.adaptParams !== undefined &&
        isCrossChainUnshield(
          { adaptContract: unshield.adaptContract ?? `0x${'00'.repeat(20)}`, adaptParams: unshield.adaptParams },
          this.ctx.config.yieldAdapterAddress,
        ));
    if (!crossChain) return;
    if (unshield.adaptBinding === undefined) {
      throw new InvalidRequestError('cross-chain unshield: needs unshield.adaptBinding (the decoded CCTP destination matching adaptParams)');
    }
    if (unshield.adaptContract !== undefined && BigInt(unshield.adaptContract) !== 0n) {
      throw new InvalidRequestError('cross-chain unshield: must not name an adaptContract (the pool rejects it)');
    }
    if ((request.tokenAddress ?? this.ctx.config.usdcAddress).toLowerCase() !== this.ctx.config.usdcAddress.toLowerCase()) {
      throw new InvalidRequestError('cross-chain unshield: must spend USDC (CCTP bridges USDC only)');
    }
    if (unshield.recipient.toLowerCase() !== this.ctx.config.poolAddress.toLowerCase()) {
      throw new InvalidRequestError(
        'cross-chain unshield: must pay the pool (unshield.recipient is the pool address; the final recipient is in the CCTP binding)',
      );
    }
  }

  /**
   * An in-proof fee note is minted in the spent token, and the relayer only counts USDC (#115). So reject a fee on
   * any other token's spend rather than plan one the relayer refuses after proving. A yield redeem pays its fee
   * contract-side (omit `fee`); `consolidate` pays a non-USDC merge's fee from a separate USDC group.
   */
  private assertUsdcFee(request: PlanTransferRequest): void {
    if (request.fee === undefined || request.fee.perProof <= 0n) return;
    if ((request.tokenAddress ?? this.ctx.config.usdcAddress).toLowerCase() === this.ctx.config.usdcAddress.toLowerCase()) return;
    throw new InvalidRequestError(
      'a non-USDC spend can\'t carry an in-proof fee: the fee note is paid in the spent token and the relayer only ' +
        'counts USDC. A yield redeem pays its fee contract-side (omit `fee`); merge non-USDC notes with consolidate, ' +
        'which pays the fee from a separate USDC group.',
    );
  }

  // The planner request for a transfer/unshield over `txos`.
  private spendParams(request: PlanTransferRequest, txos: readonly TXO[], roots: ReadonlyMap<number, bigint>): PlanTransferParams {
    this.assertCrossChainUnshield(request);
    this.assertUsdcFee(request);
    // The caller's fee is PER PROOF: a split spend pays it once per group (planSpend scales it). No fee
    // (or zero) means no fee note.
    const fee = request.fee;
    return {
      txos,
      // Defaults to USDC; a caller can spend any pool token (e.g. yield vault shares on redeem).
      tokenAddress: request.tokenAddress ?? this.ctx.config.usdcAddress,
      outputs: request.outputs.map((o) => ({ toShieldedAddress: o.to0zk, value: o.amount, ...(o.memo !== undefined ? { memo: o.memo } : {}) })),
      ...(fee !== undefined && fee.perProof > 0n ? { fee: { broadcasterShieldedAddress: fee.broadcasterShieldedAddress, value: fee.perProof } } : {}),
      ...(request.unshield
        ? {
            unshield: {
              recipient: request.unshield.recipient,
              value: request.unshield.amount,
              ...(request.unshield.adaptParams ? { adaptParams: request.unshield.adaptParams } : {}),
              ...(request.unshield.adaptContract ? { adaptContract: request.unshield.adaptContract } : {}),
              ...(request.unshield.adaptBinding ? { adaptBinding: request.unshield.adaptBinding } : {}),
            },
          }
        : {}),
      roots,
      chainID: BigInt(this.ctx.config.chainId),
      ...(this.ctx.config.supportedShapes !== undefined ? { supportedShapes: this.ctx.config.supportedShapes } : {}),
      sweepNoteThreshold: this.ctx.config.sweepNoteThreshold,
    };
  }

  // Capture each selected input's merkle proof from the SAME scan state the roots came from (no await
  // since roots were read), so each plan owns proofs consistent with its `merkleRoot`. `prove()` uses
  // these rather than re-reading live state, closing the plan→prove tree-append race (SPEC §4.6).
  private withMerkleProofs(selections: readonly PlanSelection[]): Plan[] {
    return selections.map((selection) => ({
      ...selection,
      merkleProofs: selection.selectedInputs.map((txo) =>
        this.scanState.merkleProof(txo.tree, txo.position).elements.map((e) => BigInt(`0x${e}`)),
      ),
    }));
  }

  async prove(plan: Plan, options?: ProveOptions): Promise<ProofHandle> {
    this.assertUsable();
    if (!this.signer) throw new NoSpendCapabilityError('prove: wallet has no SpendSigner');
    const signer = this.signer;
    return this.trackProof(options, async (opts) => prove(this.proveParams(plan, signer, opts), opts));
  }

  async proveAll(plans: readonly Plan[], options?: ProveOptions): Promise<ProofHandle[]> {
    this.assertUsable();
    if (!this.signer) throw new NoSpendCapabilityError('proveAll: wallet has no SpendSigner');
    const signer = this.signer;
    return this.trackProof(options, async (opts) => proveAll(plans.map((plan) => this.proveParams(plan, signer, opts)), opts));
  }

  // Run a proof that dispose() can cancel and waits for: its signal fires on the caller's signal or on dispose().
  private async trackProof<T>(options: ProveOptions | undefined, run: (options: ProveOptions) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const signals = options?.signal !== undefined ? [this.lifetime.signal, options.signal] : [this.lifetime.signal];
    for (const signal of signals) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const proof = run({ ...options, signal: controller.signal });
    this.proving.add(proof);
    try {
      return await proof;
    } catch (err) {
      if (this.disposed) throw new InstanceClosedError('prove: cancelled by wallet.dispose() or sdk.close()', { cause: err });
      throw err;
    } finally {
      this.proving.delete(proof);
      // A long-lived wallet proves many times: don't leave a listener on its lifetime signal per proof.
      for (const signal of signals) signal.removeEventListener('abort', abort);
    }
  }

  // The prove() inputs for one plan: its captured witness inputs, fee-first outputs, and the bound params.
  private proveParams(plan: Plan, signer: SpendSigner, options?: ProveOptions): ProveParams {
    // Use the proofs the plan captured at plan time (NOT a fresh scan-state read) so the path elements
    // match `plan.merkleRoot` even if a sync advanced the tree since planning (SPEC §4.6).
    const inputs = planWitnessInputs(plan);
    // Emit order (Spike 2): broadcaster fee note FIRST, then recipients, then change back to self. Each
    // output carries its OutputType so sender-side recovery can tell fee/recipient/change apart later.
    const outputs: WitnessOutputRequest[] = [];
    if (plan.summary.feeOutput) outputs.push({ receiverAddress: plan.summary.feeOutput.toShieldedAddress, value: plan.summary.feeOutput.value, outputType: OutputType.BroadcasterFee });
    for (const o of plan.summary.outputs) outputs.push({ receiverAddress: o.toShieldedAddress, value: o.value, outputType: OutputType.Transfer, ...(o.memo !== undefined ? { memo: o.memo } : {}) });
    if (plan.summary.changeValue > 0n) {
      // Optionally stash caller metadata in the change note's memo (issue #88 lever 3). The change note
      // is self-owned, so a fresh scan recovers this on history() even after local storage is cleared.
      const changeMemo = options?.selfMetadata !== undefined ? encodeSelfMetadata(options.selfMetadata) : undefined;
      outputs.push({
        receiverAddress: this.keyset.shieldedAddress,
        value: plan.summary.changeValue,
        outputType: OutputType.Change,
        ...(changeMemo !== undefined ? { memo: changeMemo } : {}),
      });
    }

    return {
      witness: {
        inputs,
        outputs,
        // The spent token comes from the plan (defaults to USDC; e.g. yield-share token on redeem).
        tokenAddress: plan.summary.tokenAddress,
        sender: {
          masterPublicKey: this.keyset.masterPublicKey,
          viewingPublicKey: this.keyset.viewingPublicKey,
          viewingPrivateKey: this.keyset.viewingPrivateKey,
          nullifyingKey: this.keyset.nullifyingKey,
          spendingPublicKey: this.keyset.spendingPublicKey,
          senderAddress: this.keyset.shieldedAddress,
        },
        signer,
        summary: plan.summary,
        merkleRoot: plan.merkleRoot,
        treeNumber: plan.boundParams.treeNumber,
        chainType: ChainType.EVM,
        chainId: this.ctx.config.chainId,
        unshield: plan.boundParams.unshield,
        // adaptContract/adaptParams are SNARK public inputs (bound-params hash + spend signature);
        // pass the plan's values so a cross-chain unshield's CCTP binding is committed by the proof.
        adaptContract: plan.boundParams.adaptContract,
        adaptParams: plan.boundParams.adaptParams,
        // Decoded CCTP binding (inspection-only) so the signer sees the destination it authorizes (§4.2.1).
        ...(plan.boundParams.decodedAdaptParams ? { decodedAdaptParams: plan.boundParams.decodedAdaptParams } : {}),
        ...(plan.summary.unshield ? { unshieldOutput: plan.summary.unshield } : {}),
      },
      artifacts: this.ctx.artifacts,
      prover: this.ctx.prover,
      poolAddress: this.ctx.config.poolAddress,
      ...(options?.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      // The public unshield preimage the contract pays out on (npk = recipient EVM address).
      ...(plan.summary.unshield
        ? {
            unshieldPreimage: {
              npk: BigInt(plan.summary.unshield.recipient),
              tokenType: 0,
              tokenAddress: plan.summary.tokenAddress,
              tokenSubID: 0n,
              value: plan.summary.unshield.value,
            },
          }
        : {}),
    };
  }

  async markSpendPending(plan: Plan | readonly Plan[], txid: string): Promise<void> {
    this.assertUsable();
    if (!this.canSpend) throw new NoSpendCapabilityError('markSpendPending: wallet has no SpendSigner');
    this.holds.mark(this.planNullifiers(planList(plan)), txid, Date.now(), this.scanState.spentNullifiers());
    await this.saveHolds();
  }

  // The (tree, nullifier) of every input note the plans spend.
  private planNullifiers(plans: readonly Plan[]): { tree: number; nullifier: bigint }[] {
    return plans.flatMap((p) =>
      p.selectedInputs.map((txo) => ({
        tree: txo.tree,
        nullifier: TransactNote.getNullifier(this.keyset.nullifyingKey, txo.position),
      })),
    );
  }

  async clearSpendPending(txid: string): Promise<void> {
    this.assertUsable();
    if (this.holds.clear(txid)) await this.saveHolds();
  }

  // Write the holds record — awaited, so a resolved markSpendPending/clearSpendPending is durable.
  private async saveHolds(): Promise<void> {
    if (!this.ephemeral) await savePendingSpends(this.storage, this.holds);
  }

  // After a sync commits, holds whose spend it confirmed (their `Nullified` event is in) are done.
  private async releaseConfirmedHolds(): Promise<void> {
    if (this.holds.releaseConfirmed(this.scanState.spentNullifiers())) await this.saveHolds();
  }

  // Release optimistic in-flight spend holds past their TTL (issue #55) before any read that depends on
  // spendability — the safety net for a submission that never confirmed (dropped/reverted/app crash).
  private prunePendingSpends(): void {
    // In memory only: the saved record is pruned by the same TTL whenever it's loaded, and rewritten on
    // the next hold change.
    this.holds.prune(Date.now() - this.ctx.config.pendingSpendTtlMs);
  }

  shareViewingKey(): string {
    this.assertUsable();
    return encodeShareableViewingKey({
      viewingPrivateKey: this.keyset.viewingPrivateKey,
      spendingPublicKey: this.keyset.spendingPublicKey,
    });
  }
}

/**
 * Wrap a consumer's telemetry sink so a throwing sink (an uninitialized Sentry, a failing transport, a bad
 * serializer) can never fail a sync, block reorg recovery, or fail `createArmadaSdk`. Telemetry is
 * observation only; losing an event is always better than changing what the SDK does.
 */
export function safeTelemetry(sink: TelemetrySink | undefined): TelemetrySink | undefined {
  if (sink === undefined) return undefined;
  return {
    emit(...args) {
      try {
        sink.emit(...args);
      } catch {
        // Deliberately swallowed: see above.
      }
    },
  };
}

/**
 * Construct an SDK instance — replaces `startRailgunEngine` + `loadProvider` + NETWORK_CONFIG patching.
 * Multiple instances per process are supported; all state is instance-scoped. `close()` cancels in-flight
 * syncs, disposes every wallet, and releases the provider, the prover's workers and storage.
 *
 * Scan state persists through `config.storage` (namespaced by pool/deployBlock): a wallet's `sync()`
 * resumes from the last synced block rather than rescanning from genesis.
 */
export async function createArmadaSdk(config: ArmadaSdkConfig): Promise<ArmadaSdk> {
  // Gate on BOTH engine WASM crypto inits before returning a ready instance — Poseidon (tree/note
  // hashing, needed for root verification) AND curve25519 (ECDH shared-key derivation in note
  // decryption). Each fires as its own module-load side effect; awaiting only Poseidon left the first
  // scan able to trial-decrypt against un-ready curve25519 WASM (tree hashing works, so `verifyRoots`
  // passes, but decryption can silently yield nothing). Awaiting both makes "ready" an explicit contract.
  await Promise.all([initPoseidonPromise, initCurve25519Promise]);

  // Fail fast on a malformed config (no network) — before opening storage or dialing anything.
  const resolved = resolveConfig(config);
  const telemetry = safeTelemetry(config.telemetry);

  // Namespace the store by (schema, chain, pool, deployBlock); a mismatch resets chain-derived state.
  const { reset } = await config.storage.open({ schemaVersion: STORAGE_SCHEMA_VERSION, chainId: resolved.chainId, poolAddress: resolved.poolAddress, deployBlock: resolved.deployBlock });
  if (reset) {
    // Surface redeploy resets so an operator can see chain-derived state being wiped (SPEC §8-safe:
    // public chain config only, no keys/addresses/amounts).
    telemetry?.emit('storage.chain-reset', { chainId: resolved.chainId, deployBlock: resolved.deployBlock });
  }

  const chainClient = ChainClient.fromRpcUrls(resolved.rpcUrls, { chainId: resolved.chainId, poolAddress: resolved.poolAddress });

  const usdcTokenData = getTokenDataERC20(resolved.usdcAddress);
  const usdcHash = getTokenDataHash(usdcTokenData);
  // Resolve a note's token hash → tokenData for ANY pool ERC20 (issue #90). An ERC20 hash IS the padded
  // address (mirrors the stock engine's TokenDataGetter), so every ERC20 is self-describing — no registry
  // and no pre-registration. Non-ERC20 (NFT) hashes are out of scope (SPEC §1.4) and rejected.
  const tokenDataGetter: TokenDataGetter = {
    getTokenDataFromHash: async (_v: unknown, _c: unknown, tokenHash: string): Promise<TokenData> => {
      const address = erc20AddressFromHash(tokenHash);
      if (address === undefined) throw new Error(`createArmadaSdk: unsupported non-ERC20 token hash ${tokenHash}`);
      return getTokenDataERC20(address);
    },
  };

  // RPC source is always built (source of truth + tail/verification fallback). An indexer, when
  // configured, becomes the primary fast path serving the native `/v2/quick-sync` wire contract.
  const rpcEventSource = new RpcEventSource((fromBlock, toBlock) => chainClient.getLogs(fromBlock, toBlock));
  const eventSource: EventSource = resolved.indexer
    ? new IndexerEventSource({
        baseUrl: resolved.indexer.url,
        chainId: resolved.chainId,
        ...(resolved.indexer.fetchFn !== undefined ? { fetchFn: resolved.indexer.fetchFn } : {}),
      })
    : rpcEventSource;

  const ctx: SdkContext = {
    config: resolved,
    chainClient,
    eventSource,
    rpcEventSource,
    tokenDataGetter,
    chain: { type: ChainType.EVM, id: resolved.chainId },
    watchers: new Set<() => void>(),
    wallets: new Set<ArmadaWallet>(),
    lifecycle: { closed: false },
    usdcHash,
    prover: config.prover,
    artifacts: config.artifacts,
    storage: config.storage,
    ...(telemetry !== undefined ? { telemetry } : {}),
  };

  const assertOpen = (): void => {
    if (ctx.lifecycle.closed) throw new InstanceClosedError('sdk: used after close()');
  };

  // Every wallet is returned with its saved state already loaded (scan checkpoint + spend holds). One whose load
  // raced close() is disposed rather than handed out.
  const loaded = async (w: ArmadaWallet): Promise<ArmadaWallet> => {
    await w.load();
    if (ctx.lifecycle.closed) {
      await w.dispose();
      assertOpen();
    }
    return w;
  };

  const wallet: WalletFactory = {
    async fromRootSecret(rootSecret, opts) {
      assertOpen();
      const keyset = await deriveKeyset(rootSecret);
      // Spend-capable by default: an explicit `signer` wins; else `viewOnly` opts out of spend entirely;
      // else a LocalSigner over the derived key (the rootSecret already grants spend power, so withholding it
      // buys no security — the least-privilege path is a view-only wallet from a viewing key).
      const signer = await signerFor(keyset, opts);
      return loaded(new ArmadaWallet(withoutSpendKey(keyset), opts.creationBlock, signer, ctx));
    },
    async fromMnemonic(mnemonic, opts) {
      assertOpen();
      const index = opts.derivationIndex ?? 0;
      // deriveKeysetFromMnemonic validates the BIP-39 checksum. Spend-capable by default (like
      // fromRootSecret): explicit signer wins, `viewOnly` opts out, else a LocalSigner over the derived key.
      const keyset = await deriveKeysetFromMnemonic(mnemonic, index);
      const signer = await signerFor(keyset, opts);
      return loaded(new ArmadaWallet(withoutSpendKey(keyset), opts.creationBlock, signer, ctx));
    },
    // Ephemeral (claimable payments, SPEC §6): in-memory, never persisted, auto-attaches a signer so
    // the claiming flow can spend. `seed` is the claim's 32-byte root; scans from the pool's deploy
    // block (block 0 would force a multi-million-block getLogs that public RPCs reject).
    async ephemeralFromSeed(seed) {
      assertOpen();
      const keyset = await deriveKeyset(seed);
      const signer: AttachedSigner = { signer: LocalSigner.fromKeyset(keyset), owned: true };
      return loaded(new ArmadaWallet(withoutSpendKey(keyset), resolved.deployBlock, signer, ctx, true));
    },
    async viewOnlyFromViewingKey(shareableViewingKey, opts) {
      assertOpen();
      const { viewingPrivateKey, spendingPublicKey } = decodeShareableViewingKey(shareableViewingKey);
      const identity = await deriveViewOnlyIdentity(viewingPrivateKey, spendingPublicKey);
      // No spending private key here at all. Spend-capable only with a `signer` (e.g. over an HSM), which must hold
      // this wallet's spending key; without one, spend-path calls throw NoSpendCapabilityError.
      const keys: WalletKeys = {
        spendingPublicKey,
        viewingPublicKey: identity.viewingPublicKey,
        viewingPrivateKey,
        nullifyingKey: identity.nullifyingKey,
        masterPublicKey: identity.masterPublicKey,
        shieldedAddress: identity.shieldedAddress,
      };
      if (opts.signer !== undefined) await assertSignerHoldsKey(opts.signer, spendingPublicKey);
      const signer: AttachedSigner | undefined = opts.signer !== undefined ? { signer: opts.signer, owned: false } : undefined;
      return loaded(new ArmadaWallet(keys, opts.creationBlock, signer, ctx));
    },
  };

  return {
    wallet,
    async close() {
      if (ctx.lifecycle.closed) return;
      ctx.lifecycle.closed = true;
      // Stop any active wallet.watch() loops first (issue #59) so a watcher can't fire sync() against a
      // torn-down provider. Copy to an array: each stop() mutates the set it's iterating.
      for (const stop of [...ctx.watchers]) stop();
      // Release every resource even if an earlier close throws: the ethers provider holds polling
      // timers/sockets that keep a Node process alive (a leak in the relayer/tests) if never destroyed.
      try {
        // Cancel in-flight work first: a destroyed provider fails a running sync's next RPC call, and a closed
        // prover fails a running proof, so the wallets below settle promptly.
        chainClient.destroy();
      } finally {
        try {
          await config.prover.close();
        } finally {
          // Each wallet waits for its in-flight sync and proofs to settle, then wipes its keys. Storage closes last,
          // so a sync settling late never writes to a closed store.
          await Promise.allSettled([...ctx.wallets].map((w) => w.dispose()));
          await config.storage.close();
        }
      }
    },
  };
}
