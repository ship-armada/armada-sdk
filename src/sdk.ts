// ABOUTME: createArmadaSdk instance (SPEC §4.1) — composes chain client + sync + prover + tx + wallet into a
// ABOUTME: per-instance handle (no singletons). Wallets sync from RPC, report balances, plan, and prove.

import {
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  reconstructHistory,
  erc20AddressFromHash,
  type SyncEventMap,
  type TXO,
  type Unsubscribe,
  type HistoryEntry,
  type ReceiverNoteKeys,
  type TokenBalance,
} from './sync/index';
import {
  WalletScanState,
  RpcEventSource,
  IndexerEventSource,
  decryptedCommitmentMatches,
  tryDecryptShield,
  shieldCommitmentMatches,
  ownedNoteFromTransactNote,
  PendingSpends,
  loadPendingSpends,
  savePendingSpends,
  withTokenAddresses,
  EncryptedStore,
  deriveWalletStorageKey,
  walletRecordId,
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
import { planList } from './tx/plan';
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
  InvalidRequestError,
  QuickSyncSchemaError,
  SignerContractViolationError,
  InstanceClosedError,
  isArmadaError,
} from './errors';
import { resolveConfig, type ResolvedConfig } from './config';
import { ChainClient } from './chain/client';
import { ChainState, CHAIN_CHUNK_BLOCKS, assertMatchesTree, assertShieldsMatchLeaves, noEvents, type ChainAdvance } from './chain/state';
import { WalletNotes } from './sync/wallet-notes';
import { WalletEvents, resolveTokenAddress } from './sync/wallet-events';
import { SpendPlanner } from './tx/spend-planner';
import { proveParamsFor } from './tx/prove-assembler';
import { loadWalletNotes, saveWalletNotes, clearWalletNotes } from './sync/scan-persistence';
import type { DecodedPoolEvents } from './sync/event-decoder';
import { startAutoSync } from './sync/auto-sync';
import type { ArmadaSdk, ArmadaSdkConfig, TelemetrySink } from './index';
// The sync rules live with the chain state; re-exported here, where tests and consumers have always found them.
export {
  classifyQuickSyncReason,
  quickSyncTelemetry,
  finalRootCheckRequired,
  shouldRecoverFromReorg,
  scanStateMissingLeaves,
} from './chain/sync-rules';
export type { QuickSyncReason, QuickSyncTelemetry } from './chain/sync-rules';
// The event payload builders live with the wallet's event stream; re-exported here, where tests have found them.
export { buildBalanceUpdate, buildReceivedNote } from './sync/wallet-events';

// Per-instance shared context handed to each wallet.
interface SdkContext {
  /** The validated config with every default applied. */
  readonly config: ResolvedConfig;
  /**
   * The RPC: the chain/pool check, pool logs and view reads, block hashes/timestamps. Its `ensureChain()` is awaited
   * before any sync or preflight, so no checkpoint from the wrong chain is ever saved.
   */
  readonly chainClient: ChainClient;
  /** The instance's verified trees and chain checkpoint, and the one sync driver that advances them. */
  readonly chainState: ChainState;
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
// 3: scan state split into a checkpoint, the wallet's notes (own spends only), and chunked tree records (#143).
// 4: one chain state per instance (trees + checkpoint in a shared plaintext scope); each wallet keeps only its notes.
const STORAGE_SCHEMA_VERSION = 4;

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

// The tag of the instance's own scope. Wallet tags are hex record ids, so it can't collide with one.
const CHAIN_SCOPE_TAG = 'shared';

/**
 * Resolve the instance's storage handle for its chain state: its own scope of the shared adapter, in plaintext. The
 * trees and the chain checkpoint are public (leaf hashes, block numbers), so they aren't encrypted. Exported so tests
 * can seed or inspect chain state without a live chain.
 */
export function resolveChainStorage(raw: StorageAdapter): StorageAdapter {
  return new ScopedStore(raw, CHAIN_SCOPE_TAG);
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

class ArmadaWallet implements Wallet {
  // The wallet's private notes (owned notes, its own spends, notes it authored). The trees are the instance's, in
  // `ChainState`; the notes are synced through `syncedThrough`, never past the chain's checkpoint.
  private notes = new WalletNotes();
  private syncedThrough: number;
  // Hash of block `syncedThrough` when it was scanned — the reorg check compares it with the chain's
  // current hash at that height. Undefined before the first sync (or when the node didn't return it).
  private syncedThroughHash: string | undefined;
  // Optimistic in-flight spend holds (issue #55) — the wallet's own intent, kept apart from the chain-derived
  // scan state (which a sync replaces wholesale) and written durably whenever a hold changes.
  private holds = new PendingSpends();
  private readonly events = new WalletEvents();
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
  // Set once load() finishes. The wallet is registered from construction (so close() disposes it even mid-load), but
  // takes chain batches only once its saved notes are loaded.
  private ready = false;
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

  // The wallet's view of the scan: the instance's verified trees plus its own notes.
  private get scanState(): WalletScanState {
    return new WalletScanState(this.ctx.chainState.tree, this.notes);
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
    if (this.ephemeral) {
      this.ready = true;
      return;
    }
    const persisted = await loadWalletNotes(this.storage);
    // Notes saved past the chain's checkpoint (its records were lost or reset) aren't backed by verified trees, so
    // they're ignored and rescanned.
    if (
      persisted !== undefined &&
      persisted.syncedThrough > this.syncedThrough &&
      persisted.syncedThrough <= this.ctx.chainState.syncedThrough
    ) {
      this.notes = persisted.notes;
      this.syncedThrough = persisted.syncedThrough;
      this.syncedThroughHash = persisted.syncedThroughHash;
      // The saved notes are already known: seed the receive baseline from them, so the first sync reports
      // exactly the notes that arrived since the checkpoint (e.g. while the app was closed).
      this.events.baselineReceives(this.notes.ownedTxos(), this.notes.spentNullifiers(), this.keyset.nullifyingKey);
    }
    this.holds = await loadPendingSpends(this.storage);
    // A hold whose spend the saved state already confirms is done.
    this.holds.releaseConfirmed(this.scanState.spentNullifiers());
    this.ready = true;
  }

  // Trial-decrypt closures over this wallet's viewing key — shared by the primary + tail applies. Notes
  // committed before `creationBlock` are not looked for: the wallet didn't exist yet (the tree still
  // includes their leaves).
  private decryptors(): WalletDecryptors {
    const receiver = this.receiver();
    const discovers = (blockNumber: number): boolean => blockNumber >= this.creationBlock;
    return {
      nullifyingKey: this.keyset.nullifyingKey,
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

  /**
   * Bring the notes up to the chain's checkpoint (`target`): fetch the events from where the notes stop — or from
   * `creationBlock`, if later — and read the wallet's notes from them, a chunk at a time (each saved before the next,
   * as the chain does). The trees are already verified, so the batch isn't verified again; instead every commitment
   * in it must match the verified leaf at its position. An indexer batch that doesn't is discarded for an RPC one; an
   * RPC batch that doesn't fails the sync.
   */
  private async catchUp(target: number, onProgress: (coveredThroughBlock: number) => void): Promise<void> {
    const chain = this.ctx.chainState;
    const from = Math.max(this.syncedThrough + 1, this.creationBlock);
    if (from > target) {
      // Nothing the wallet could own lies in range: it starts at the chain's checkpoint.
      await this.ingest(noEvents(), new Map(), target, chain.syncedThroughHash);
      return;
    }
    for (let start = from; start <= target; start += CHAIN_CHUNK_BLOCKS) {
      const end = Math.min(start + CHAIN_CHUNK_BLOCKS - 1, target);
      const endHash = end === target ? chain.syncedThroughHash : await this.ctx.chainClient.getBlockHash(end);
      const events = await this.fetchMatchingTree(start, end, onProgress);
      // Every pool-event block's timestamp in the range, not just the wallet's (#135; see `ChainState.timestampsFor`).
      await this.ingest(events, await chain.timestampsFor(events), end, endHash);
    }
  }

  // Fetch `[from, to]` for a catch-up and check it against the verified trees (see `catchUp`).
  private async fetchMatchingTree(from: number, to: number, onProgress: (coveredThroughBlock: number) => void): Promise<DecodedPoolEvents> {
    const chain = this.ctx.chainState;
    if (this.ctx.eventSource !== this.ctx.rpcEventSource) {
      try {
        const served = (await chain.fetchEvents(this.ctx.eventSource, from, to, onProgress)).events;
        assertShieldsMatchLeaves(served);
        assertMatchesTree(served, chain.tree);
        return served;
      } catch {
        // Deliberately swallowed: the indexer is untrusted, and RPC is read instead.
      }
    }
    const events = (await chain.fetchEvents(this.ctx.rpcEventSource, from, to, onProgress)).events;
    assertMatchesTree(events, chain.tree);
    return events;
  }

  /**
   * Read the wallet's notes from a batch of events through `through` (whose hash is `throughHash`, when known), save
   * them, and commit them. The commit happens only once the notes are saved, so a failure leaves the wallet where it
   * was, and a retry reads the range again.
   */
  private async ingest(
    events: DecodedPoolEvents,
    timestamps: ReadonlyMap<number, number>,
    through: number,
    throughHash: string | undefined,
  ): Promise<void> {
    const next = this.notes.clone();
    await next.apply(events, this.decryptors());
    next.recordBlockTimestamps(timestamps);
    // A wallet disposed mid-sync (or a closing SDK) keeps nothing from it: stop before saving or committing.
    this.assertUsable();
    const position = { syncedThrough: through, ...(throughHash !== undefined ? { syncedThroughHash: throughHash } : {}) };
    // Ephemeral wallets keep their notes in memory only — never write note data to disk (SPEC §6.5).
    if (!this.ephemeral) await saveWalletNotes(this.storage, next, position);
    this.notes = next;
    this.syncedThrough = through;
    this.syncedThroughHash = throughHash;
    await this.releaseConfirmedHolds();
  }

  /**
   * Whether the notes can't stand on the chain state: saved past its checkpoint, or reorganised under their own
   * checkpoint (the block hash recorded then is no longer the chain's hash at that height). A wallet created after a
   * chain-wide reset (which reset the wallets loaded then) can still hold notes from the orphaned chain.
   */
  private async notesStale(): Promise<boolean> {
    const chain = this.ctx.chainState;
    if (this.syncedThrough > chain.syncedThrough) return true;
    if (this.syncedThroughHash === undefined) return false;
    // Level with the chain on the same block: the chain has just checked that hash (`resetIfReorged`).
    if (this.syncedThrough === chain.syncedThrough && this.syncedThroughHash === chain.syncedThroughHash) return false;
    const canonical = await this.ctx.chainClient.getBlockHash(this.syncedThrough);
    return canonical !== undefined && canonical !== this.syncedThroughHash;
  }

  /**
   * Drop the notes (in memory + the saved record) to read them again from the deploy block. Identity and the spend
   * holds (issue #55) live outside the notes, so they survive — dropping a hold here would let a follow-up spend
   * reselect an input whose submission is still in flight.
   */
  async resetNotes(): Promise<void> {
    this.notes = new WalletNotes();
    this.syncedThrough = this.ctx.config.deployBlock - 1;
    this.syncedThroughHash = undefined;
    this.events.reset();
    // Delete the poisoned record so a crash mid-rescan can't load it again.
    if (!this.ephemeral) await clearWalletNotes(this.storage);
  }

  /**
   * Hand a batch the chain just verified to every wallet whose notes stop where it starts (this one included), so one
   * fetch serves them all. Another wallet that fails to take it stays behind and catches up on its own next sync.
   */
  private async deliver(batch: ChainAdvance, chainHead: number): Promise<void> {
    for (const wallet of [...this.ctx.wallets]) {
      if (!wallet.ready || wallet.syncedThrough !== batch.fromBlock - 1) continue;
      if (wallet === this) {
        await this.ingest(batch.events, batch.timestamps, batch.toBlock, batch.toBlockHash);
        continue;
      }
      try {
        await wallet.ingest(batch.events, batch.timestamps, batch.toBlock, batch.toBlockHash);
        wallet.emitUpdates(chainHead);
      } catch {
        // Deliberately swallowed: this sync is the other wallet's to report, not ours.
      }
    }
  }

  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe {
    this.assertUsable();
    return this.events.on(event, listener);
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

  private async runSync(): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> {
    // Never scan (and so never save a checkpoint) from an RPC that doesn't serve the configured chain/pool.
    await this.ctx.chainClient.ensureChain();
    const chain = this.ctx.chainState;
    return chain.exclusive(async () => {
      try {
        this.assertUsable();
        // A reorg under the chain's checkpoint resets the chain and every wallet's notes, for a rescan.
        await chain.resetIfReorged();
        if (await this.notesStale()) await this.resetNotes();
        // Scan only to head − confirmationDepth so a reorg of that depth or shallower can't remove a leaf we
        // already persisted (§4.4 reorg safety); `confirmationDepth: 0` (default) scans to head. A deeper
        // reorg is caught by the checkpoint hash checks above.
        const chainHead = await this.ctx.chainClient.getBlockNumber();
        const head = effectiveScanHead(chainHead, this.ctx.config.confirmationDepth);
        const { fromBlock, scanned } = planSyncWindow(this.syncedThrough, head);
        if (!scanned) return { fromBlock, syncedThrough: this.syncedThrough, scanned: false };
        const headHash = await this.ctx.chainClient.getBlockHash(head);

        const span = head - fromBlock + 1;
        const emitProgress = (coveredThrough: number): void => {
          const done = Math.max(0, Math.min(span, coveredThrough - fromBlock + 1));
          this.events.emit('scan:progress', { syncedThrough: coveredThrough, fraction: span <= 0 ? 1 : done / span });
        };
        this.events.emit('scan:started', { fromBlock, toBlock: head });
        this.events.emit('scan:progress', { syncedThrough: fromBlock - 1, fraction: 0 });

        // Behind the chain (new, or loaded from an older save): catch up to its checkpoint first, so this wallet is
        // level with the chain when it advances and reads the new batch with the others.
        if (this.syncedThrough < chain.syncedThrough) await this.catchUp(chain.syncedThrough, emitProgress);
        await chain.advance(head, headHash, emitProgress, (batch) => this.deliver(batch, chainHead));

        this.events.emit('scan:complete', { syncedThrough: this.syncedThrough });
        this.emitUpdates(chainHead);
        return { fromBlock, syncedThrough: this.syncedThrough, scanned: true };
      } catch (err) {
        // Cancelled by dispose()/close() (its RPC calls may fail first, on the destroyed provider): no scan:error —
        // the caller learns the wallet is closed.
        if (this.disposed || this.ctx.lifecycle.closed) {
          throw isArmadaError(err, 'INSTANCE_CLOSED') ? err : new InstanceClosedError('sync: cancelled by wallet.dispose() or sdk.close()', { cause: err });
        }
        this.events.emit('scan:error', { error: err instanceof Error ? err : new Error(String(err)) });
        throw err;
      }
    });
  }

  // Push `balance:updated` for the tokens whose balance changed, then `note:received` for new incoming notes. Balance
  // events use the chain head, as `balances()` does, so both agree on spendable vs pending.
  private emitUpdates(chainHead: number): void {
    this.prunePendingSpends();
    this.events.balancesChanged(
      this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: chainHead, finalityThreshold: this.ctx.config.finalityThreshold }, this.holds.list()),
    );
    this.events.notesReceived(this.notes.ownedTxos(), this.notes.spentNullifiers(), this.keyset.nullifyingKey);
  }

  async balances(): Promise<TokenBalance[]> {
    this.assertUsable();
    this.prunePendingSpends();
    const head = await this.ctx.chainClient.getBlockNumber();
    const raw = this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: this.ctx.config.finalityThreshold }, this.holds.list());
    return withTokenAddresses(raw, resolveTokenAddress);
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
      resolveToken: resolveTokenAddress,
      usdcHash: this.ctx.usdcHash,
      ...(this.ctx.config.yieldAdapterAddress !== undefined ? { yieldAdapterAddress: this.ctx.config.yieldAdapterAddress } : {}),
    });
    if (options?.sinceBlock !== undefined) {
      const since = options.sinceBlock;
      entries = entries.filter((e) => e.blockNumber >= since);
    }
    // Block timestamps come from the notes: sync recorded them while fetching every pool-event block's, so asking
    // the RPC here — for exactly this wallet's blocks — would tell it which transactions are the wallet's (#135).
    return entries.map((e) => {
      const ts = this.notes.blockTimestamp(e.blockNumber);
      return ts !== undefined ? { ...e, timestamp: ts } : e;
    });
  }

  // A planner over the trees as they are now (committed state), for one planning call.
  private planner(): SpendPlanner {
    return new SpendPlanner(this.ctx.config, this.ctx.chainState.tree);
  }

  // The notes a spend can select: spendable, with optimistic in-flight holds pruned to their TTL and excluded.
  private spendableTxos(): TXO[] {
    this.prunePendingSpends();
    return this.scanState.spendableTxos(this.keyset.nullifyingKey, this.holds.list());
  }

  async planTransfer(request: PlanTransferRequest): Promise<Plan[]> {
    this.assertUsable();
    if (!this.canSpend) throw new NoSpendCapabilityError('planTransfer: wallet has no SpendSigner');
    return this.planner().planTransfer(request, this.spendableTxos());
  }

  async planTransferAfter(consolidation: readonly Plan[], request: PlanTransferRequest): Promise<PlanSelection[]> {
    this.assertUsable();
    return this.planner().planTransferAfter(consolidation, request, this.spendableTxos());
  }

  async maxTransferAmount(request: MaxTransferRequest): Promise<bigint> {
    this.assertUsable();
    return this.planner().maxTransferAmount(request, this.spendableTxos());
  }

  async maxUnshieldAmount(request: MaxUnshieldRequest): Promise<bigint> {
    this.assertUsable();
    return this.planner().maxUnshieldAmount(request, this.spendableTxos());
  }

  async consolidate(request: ConsolidateRequest): Promise<Plan[]> {
    this.assertUsable();
    if (!this.canSpend) throw new NoSpendCapabilityError('consolidate: wallet has no SpendSigner');
    return this.planner().consolidate(request, this.spendableTxos());
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

  // The prove() inputs for one plan (see `proveParamsFor`).
  private proveParams(plan: Plan, signer: SpendSigner, options?: ProveOptions): ProveParams {
    return proveParamsFor(plan, this.keyset, signer, this.ctx.config, this.ctx, options);
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
      if (address === undefined) throw new InvalidRequestError(`createArmadaSdk: unsupported non-ERC20 token hash ${tokenHash}`);
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

  // The instance's chain state: one set of verified trees for every wallet, in the adapter's shared scope.
  const lifecycle = { closed: false };
  const wallets = new Set<ArmadaWallet>();
  const chainState = new ChainState({
    client: chainClient,
    eventSource,
    rpcEventSource,
    storage: resolveChainStorage(config.storage),
    deployBlock: resolved.deployBlock,
    ...(telemetry !== undefined ? { telemetry } : {}),
    isClosed: () => lifecycle.closed,
  });
  // A chain reset for a rescan drops every wallet's notes too: a reorg may have orphaned some of them.
  chainState.onReset = async () => {
    for (const w of wallets) await w.resetNotes();
  };
  await chainState.load();

  const ctx: SdkContext = {
    config: resolved,
    chainClient,
    chainState,
    eventSource,
    rpcEventSource,
    tokenDataGetter,
    chain: { type: ChainType.EVM, id: resolved.chainId },
    watchers: new Set<() => void>(),
    wallets,
    lifecycle,
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
    sync: {
      async status() {
        assertOpen();
        return { syncedThrough: chainState.syncedThrough, syncing: chainState.syncing };
      },
    },
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
