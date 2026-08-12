// ABOUTME: createArmadaSdk instance (SPEC §4.1) — composes provider + sync + prover + tx + wallet into a
// ABOUTME: per-instance handle (no singletons). Wallets sync from RPC, report balances, plan, and prove.

import { JsonRpcProvider, FallbackProvider, Interface, type Provider } from 'ethers';
import {
  WalletScanState,
  RpcEventSource,
  IndexerEventSource,
  SyncEmitter,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  tryDecryptShield,
  ownedNoteFromTransactNote,
  reconstructHistory,
  newReceivedNotes,
  saveScanState,
  loadScanState,
  POOL_V2_EVENT_ABI,
  type EventSource,
  type SyncEventMap,
  type Unsubscribe,
  type WalletDecryptors,
  type HistoryEntry,
  type ParsedPoolLog,
  type ReceiverNoteKeys,
  type TokenBalance,
} from './sync/index';
import { EncryptedStore, deriveWalletStorageKey, type StorageAdapter } from './storage/index';
import { planTransfer, prove, type Plan, type ProofHandle } from './tx/index';
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
  type TokenData,
  type TokenDataGetter,
  type Chain,
} from './core/index';
import type { ProveOptions, ProverAdapter, ArtifactSource } from './prover/index';
import { NoSpendCapabilityError, RootMismatchError } from './errors';
import type { ArmadaSdk, ArmadaSdkConfig, TelemetrySink } from './index';

// Per-instance shared context handed to each wallet.
interface SdkContext {
  readonly provider: Provider;
  /** Primary event source — the indexer when configured, else the RPC source. */
  readonly eventSource: EventSource;
  /** Always the RPC source: covers any tail the indexer lags, and is the verification fallback. */
  readonly rpcEventSource: RpcEventSource;
  /** On-chain pool commitment root at a given block — used to verify indexer-sourced batches. */
  readonly merkleRootAt: (blockTag: number) => Promise<string>;
  readonly tokenDataGetter: TokenDataGetter;
  readonly chain: Chain;
  readonly chainId: number;
  readonly usdcAddress: `0x${string}`;
  /** Pool deploy block — the genesis scan floor for wallets with no earlier creationBlock (e.g. ephemeral). */
  readonly deployBlock: number;
  /** Canonical 32-byte hash (no 0x) of USDC — maps owned-note token hashes back to the address. */
  readonly usdcHash: string;
  /** hash (no 0x) → TokenData for every registered token (USDC + additionalTokens) — resolves a
   *  balance's tokenHash back to its address for `balance:updated` emission. */
  readonly tokenByHash: ReadonlyMap<string, TokenData>;
  /** Yield adapter address (lowercased), when configured — an unshield to it marks a yield op. */
  readonly yieldAdapterAddress?: string;
  readonly poolAddress: `0x${string}`;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
  /** Raw environment adapter (already opened). Per-wallet stores wrap this with at-rest encryption. */
  readonly storage: StorageAdapter;
  /** When true, wallets persist through the raw adapter unencrypted — the §4.3 escape hatch. */
  readonly allowPlaintextStorage: boolean;
  /** Optional operational telemetry sink (SPEC §8) — emits quick-sync outcomes when an indexer is used. */
  readonly telemetry?: TelemetrySink;
}

/** Quick-sync observability payload emitted through the telemetry sink (SPEC §8-safe: block numbers + booleans only). */
export interface QuickSyncTelemetry {
  /** `served` = the indexer batch verified against the on-chain root; `root-mismatch-fallback` = it
   *  didn't, so the batch was discarded and the range re-scanned from RPC (truth). */
  readonly outcome: 'served' | 'root-mismatch-fallback';
  readonly fromBlock: number;
  readonly head: number;
  /** On the `served` path: the indexer lagged the chain head and RPC covered the tail. Always false on fallback. */
  readonly tailCovered: boolean;
}

/**
 * Decide the quick-sync observability event for a completed sync. Pure so the outcome taxonomy is
 * unit-testable without a provider. Returns null when no indexer is in play — a pure RPC sync has
 * nothing quick-sync to report. SPEC §8: the payload carries only block numbers + booleans, never
 * keys, addresses, or note plaintext.
 */
export function quickSyncTelemetry(input: {
  usingIndexer: boolean;
  tailCovered: boolean;
  fellBack: boolean;
  fromBlock: number;
  head: number;
}): { event: 'sync.quicksync'; data: QuickSyncTelemetry } | null {
  if (!input.usingIndexer) return null;
  return {
    event: 'sync.quicksync',
    data: {
      outcome: input.fellBack ? 'root-mismatch-fallback' : 'served',
      fromBlock: input.fromBlock,
      head: input.head,
      // On a root-mismatch fallback the indexer batch was discarded and the whole range RPC-rescanned,
      // so tail-cover is only meaningful on the served path.
      tailCovered: input.fellBack ? false : input.tailCovered,
    },
  };
}

/**
 * Resolve the per-wallet storage handle. By default the raw environment adapter is auto-wrapped in an
 * `EncryptedStore` keyed per wallet (from the viewing private key), so decrypted note data is
 * AEAD-encrypted at rest without the caller doing anything (SPEC §4.3, WS7.2 Option B). A per-wallet
 * key (not one instance-wide key) means one wallet cannot read another's records even in a shared
 * adapter. `allowPlaintext` (the `dangerouslyAllowPlaintextStorage` config flag) returns the raw
 * adapter unwrapped — the only path to plaintext at rest. Exported so the auto-wrap default is
 * unit-testable without a live chain.
 */
export function resolveWalletStorage(
  raw: StorageAdapter,
  viewingPrivateKey: Uint8Array,
  allowPlaintext: boolean,
): StorageAdapter {
  if (allowPlaintext) return raw;
  return new EncryptedStore(raw, deriveWalletStorageKey(viewingPrivateKey));
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
 * Pick the `/fees` schedule key whose tier matches the plan's operation, so the in-band fee note
 * commits the amount the relayer will actually require (SPEC §4.6.1). The relayer prices per
 * submission selector (`relayer/modules/privacy-relay.ts::advertisedFeeForSelector`):
 *   - bare `transact()` transfer/unshield → priced as MIN(transfer, unshield); either tier satisfies it,
 *   - yield redeem (unshield whose adaptContract is the yield adapter) → `redeemAndShield` → `crossContract`,
 *   - cross-chain unshield (CCTP adaptParams, non-yield adaptContract) → `atomicCrossChainUnshield` → `crossChainUnshield`.
 * Pure so the mapping is unit-testable without a wallet. Binding the wrong (lower) tier makes the
 * relayer reject the transaction after the user already proved for ~30s.
 */
export function feeScheduleKey(
  request: Pick<PlanTransferRequest, 'unshield'>,
  yieldAdapterAddress: string | undefined,
): 'transfer' | 'unshield' | 'crossChainUnshield' | 'crossContract' {
  if (!request.unshield) return 'transfer';
  const adaptContract = request.unshield.adaptContract?.toLowerCase();
  if (adaptContract !== undefined && yieldAdapterAddress !== undefined && adaptContract === yieldAdapterAddress) {
    return 'crossContract';
  }
  if (request.unshield.adaptParams !== undefined) return 'crossChainUnshield';
  return 'unshield';
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
  private scanState = new WalletScanState();
  private syncedThrough: number;
  private hydrated = false;
  private readonly emitter = new SyncEmitter();
  // Last-emitted per-token balance (keyed by tokenHash, no 0x) so a sync only pushes `balance:updated`
  // for tokens that actually changed — the diff that lets consumers avoid redundant re-reads.
  private readonly lastBalances = new Map<string, { spendable: bigint; pending: bigint }>();
  // Received-transfer keys already emitted as `note:received`. The first sync seeds this as a baseline
  // WITHOUT emitting (so a fresh load doesn't replay all past transfers as "received"); later syncs
  // emit only genuinely-new incoming notes.
  private readonly seenReceiveKeys = new Set<string>();
  private receiveBaselined = false;

  constructor(
    private readonly keyset: Keyset,
    creationBlock: number,
    private readonly signer: SpendSigner | undefined,
    private readonly ctx: SdkContext,
    // Ephemeral (claimable-payment) wallets are in-memory only: they never hydrate from or write to
    // the StorageAdapter, so no decrypted note data or seed-derived identity hits disk (SPEC §4.3/§6.5).
    private readonly ephemeral: boolean = false,
  ) {
    this.syncedThrough = creationBlock - 1;
    // Per-wallet at-rest encryption is on by default; the raw adapter is auto-wrapped (§4.3).
    this.storage = resolveWalletStorage(ctx.storage, keyset.viewingPrivateKey, ctx.allowPlaintextStorage);
  }

  // This wallet's storage handle — an EncryptedStore wrapping the shared adapter unless plaintext is allowed.
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

  // Restore persisted scan state on first use so we resume instead of rescanning from genesis.
  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    // Ephemeral wallets never touch storage — there is nothing persisted to restore (SPEC §6.5).
    if (this.ephemeral) {
      this.hydrated = true;
      return;
    }
    const persisted = await loadScanState(this.storage, this.keyset.shieldedAddress);
    if (persisted !== undefined && persisted.syncedThrough > this.syncedThrough) {
      this.scanState = persisted.state;
      this.syncedThrough = persisted.syncedThrough;
    }
    this.hydrated = true;
  }

  // Trial-decrypt closures over this wallet's viewing key — shared by the primary + tail applies.
  private decryptors(): WalletDecryptors {
    const receiver = this.receiver();
    return {
      transact: async (c) => {
        const note = await tryDecryptCommitment(c.ciphertext, receiver, this.ctx.tokenDataGetter, this.ctx.chain);
        return note ? ownedNoteFromTransactNote(note) : undefined;
      },
      shield: (c) => tryDecryptShield(c, receiver),
      sentTransact: async (c) => {
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
    source: EventSource,
    from: number,
    to: number,
    decryptors: WalletDecryptors,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<number> {
    const batch = await source.getEvents(from, to, onProgress);
    await this.scanState.apply(batch.events, decryptors);
    return batch.syncedThroughBlock;
  }

  // Sync [from, head] from the primary source, RPC-covering any tail the (indexer) source lagged.
  // Returns `tailCovered` — true when the primary (indexer) source stopped short of head and RPC
  // covered the remainder, for quick-sync observability.
  private async applyToHead(
    from: number,
    head: number,
    decryptors: WalletDecryptors,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<{ tailCovered: boolean }> {
    const covered = await this.applyBatch(this.ctx.eventSource, from, head, decryptors, onProgress);
    if (covered < head) {
      await this.applyBatch(this.ctx.rpcEventSource, covered + 1, head, decryptors, onProgress);
      return { tailCovered: true };
    }
    return { tailCovered: false };
  }

  /**
   * Verify the built commitment tree reproduces the on-chain root at `head`. Any dropped/reordered
   * commitment cascades leaf positions across tree boundaries, so the current (highest) tree's root
   * diverges — checking it against `merkleRoot()` at the same block is sufficient to detect a bad batch.
   */
  private async verifyCurrentRoot(head: number): Promise<void> {
    const trees = this.scanState.treeNumbers();
    if (trees.length === 0) return;
    const currentTree = trees[trees.length - 1]!;
    const computed = this.scanState.treeRoot(currentTree);
    const onChain = await this.ctx.merkleRootAt(head);
    const norm = (r: string): string => (r.startsWith('0x') ? r.slice(2) : r).toLowerCase();
    if (norm(computed) !== norm(onChain)) {
      throw new RootMismatchError(
        `indexer sync: tree ${currentTree} root ${computed} != on-chain merkleRoot ${onChain} @block ${head}`,
      );
    }
  }

  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  async sync(): Promise<{ fromBlock: number; syncedThrough: number; scanned: boolean }> {
    await this.hydrate();
    const head = await this.ctx.provider.getBlockNumber();
    const { fromBlock, scanned } = planSyncWindow(this.syncedThrough, head);
    if (!scanned) return { fromBlock, syncedThrough: this.syncedThrough, scanned: false };

    const from = fromBlock;
    const span = head - from + 1;
    const emitProgress = (coveredThrough: number): void => {
      const done = Math.max(0, Math.min(span, coveredThrough - from + 1));
      this.emitter.emit('scan:progress', { syncedThrough: coveredThrough, fraction: span <= 0 ? 1 : done / span });
    };

    this.emitter.emit('scan:started', { fromBlock, toBlock: head });
    this.emitter.emit('scan:progress', { syncedThrough: from - 1, fraction: 0 });
    try {
      const decryptors = this.decryptors();
      // Snapshot before applying so we can roll back a batch that fails root verification — on the
      // indexer path (untrusted source) AND the RPC path (a provider that silently truncates a
      // getLogs range yields a tree missing commitments that must not be persisted).
      const usingIndexer = this.ctx.eventSource !== this.ctx.rpcEventSource;
      const rollback = this.scanState.snapshot();

      const { tailCovered } = await this.applyToHead(from, head, decryptors, emitProgress);
      let fellBack = false;

      if (usingIndexer) {
        try {
          await this.verifyCurrentRoot(head);
        } catch (err) {
          if (!(err instanceof RootMismatchError)) throw err;
          // Indexer served a tree that doesn't match chain — discard it and re-scan from RPC (truth).
          fellBack = true;
          this.scanState = WalletScanState.restore(rollback);
          await this.applyBatch(this.ctx.rpcEventSource, from, head, decryptors, emitProgress);
        }
      }

      // Final guard (SPEC §4.4): the accepted tree — RPC baseline or post-fallback RPC rescan — must
      // reproduce the on-chain root. This is the ONLY verification on the pure-RPC path; a mismatch
      // means the provider returned bad/truncated logs, so roll back and refuse to advance the
      // checkpoint rather than persist a corrupt tree (a retry re-scans the range cleanly).
      if (finalRootCheckRequired(usingIndexer, fellBack)) {
        try {
          await this.verifyCurrentRoot(head);
        } catch (err) {
          if (!(err instanceof RootMismatchError)) throw err;
          this.scanState = WalletScanState.restore(rollback);
          throw err;
        }
      }

      // Quick-sync observability (SPEC §8): report whether the configured indexer served a
      // root-verified batch, lagged into an RPC tail, or was rejected for an RPC re-scan. No-op
      // when no indexer is configured. Never carries key material / addresses.
      const qs = quickSyncTelemetry({ usingIndexer, tailCovered, fellBack, fromBlock: from, head });
      // Cast bridges the precise payload type to the sink's untyped `Record<string, unknown>` contract
      // (the interface has no index signature, so the double-cast is the sanctioned boundary widening).
      if (qs !== null) this.ctx.telemetry?.emit(qs.event, qs.data as unknown as Readonly<Record<string, unknown>>);

      this.syncedThrough = head;
      // Ephemeral wallets keep their scan state in memory only — never write note data to disk (SPEC §6.5).
      if (!this.ephemeral) {
        await saveScanState(this.storage, this.keyset.shieldedAddress, this.scanState, head);
      }
      this.emitter.emit('scan:complete', { syncedThrough: head });
      this.emitBalanceUpdates(head);
      this.emitReceivedNotes();
      return { fromBlock, syncedThrough: head, scanned: true };
    } catch (err) {
      this.emitter.emit('scan:error', { error: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    }
  }

  // Push `note:received` for incoming transfers discovered since the last sync (`newReceivedNotes`
  // handles the classification + `tree:position` de-dup, mutating `seenReceiveKeys`). The first sync
  // seeds the baseline WITHOUT emitting, so a fresh load doesn't replay history as "received".
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
      const hashKey = txo.tokenHash.startsWith('0x') ? txo.tokenHash.slice(2) : txo.tokenHash;
      const tokenData = this.ctx.tokenByHash.get(hashKey);
      if (tokenData === undefined) continue; // unregistered token — can't resolve an address
      this.emitter.emit('note:received', {
        tokenAddress: tokenData.tokenAddress as `0x${string}`,
        value: txo.value,
        ...(txo.memo !== undefined ? { memo: txo.memo } : {}),
        ...(txo.senderShieldedAddress !== undefined ? { senderShieldedAddress: txo.senderShieldedAddress } : {}),
      });
    }
  }

  // Push `balance:updated` for each token whose (spendable, pending) changed since the last emit —
  // including a token fully spent (drops out of `balances()`, so we emit a zero). Unregistered tokens
  // (unknown hash → no address) are skipped. First sync after load emits the baseline for held tokens.
  private emitBalanceUpdates(head: number): void {
    const balances = this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: 0 });
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
    const key = tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash;
    const tokenData = this.ctx.tokenByHash.get(key);
    if (tokenData === undefined) return; // unregistered token — can't resolve an address to emit
    this.emitter.emit('balance:updated', { tokenAddress: tokenData.tokenAddress as `0x${string}`, spendable, pending });
  }

  async balances(): Promise<TokenBalance[]> {
    const head = await this.ctx.provider.getBlockNumber();
    return this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: 0 });
  }

  spendableNullifiers(): readonly { readonly tree: number; readonly nullifier: bigint }[] {
    return this.scanState
      .spendableTxos(this.keyset.nullifyingKey)
      .map((txo) => ({ tree: txo.tree, nullifier: TransactNote.getNullifier(this.keyset.nullifyingKey, txo.position) }));
  }

  async history(options?: { sinceBlock?: number }): Promise<HistoryEntry[]> {
    let entries = reconstructHistory({
      ownedTxos: this.scanState.ownedTxos(),
      spentNullifiers: this.scanState.spentNullifiers(),
      unshields: this.scanState.unshieldEvents(),
      sentOutputs: this.scanState.sentOutputs(),
      nullifyingKey: this.keyset.nullifyingKey,
      usdcHash: this.ctx.usdcHash,
      usdcAddress: this.ctx.usdcAddress,
      ...(this.ctx.yieldAdapterAddress !== undefined ? { yieldAdapterAddress: this.ctx.yieldAdapterAddress } : {}),
    });
    if (options?.sinceBlock !== undefined) {
      const since = options.sinceBlock;
      entries = entries.filter((e) => e.blockNumber >= since);
    }
    // Attach block timestamps, batched over the distinct blocks the entries touch.
    const times = new Map<number, number>();
    await Promise.all(
      [...new Set(entries.map((e) => e.blockNumber))].map(async (b) => {
        const block = await this.ctx.provider.getBlock(b);
        if (block !== null) times.set(b, block.timestamp);
      }),
    );
    return entries.map((e) => {
      const ts = times.get(e.blockNumber);
      return ts !== undefined ? { ...e, timestamp: ts } : e;
    });
  }

  async planTransfer(request: PlanTransferRequest): Promise<Plan> {
    if (!this.canSpend) throw new NoSpendCapabilityError('planTransfer: wallet has no SpendSigner');
    const txos = this.scanState.spendableTxos(this.keyset.nullifyingKey);
    const roots = new Map<number, bigint>();
    for (const txo of txos) {
      if (!roots.has(txo.tree)) roots.set(txo.tree, BigInt(`0x${this.scanState.treeRoot(txo.tree)}`));
    }
    // Bind the fee tier that matches this plan's op, falling back to `transfer` for an older relayer
    // schedule that predates the per-op keys, then to 0 (no fee note) if even that is absent.
    const scheduleKey = feeScheduleKey(request, this.ctx.yieldAdapterAddress);
    const feeValue = BigInt(request.fee.schedule[scheduleKey] ?? request.fee.schedule['transfer'] ?? '0');
    return planTransfer({
      txos,
      // Defaults to USDC; a caller can spend any pool token (e.g. yield vault shares on redeem).
      tokenAddress: request.tokenAddress ?? this.ctx.usdcAddress,
      outputs: request.outputs.map((o) => ({ toShieldedAddress: o.to0zk, value: o.amount, ...(o.memo !== undefined ? { memo: o.memo } : {}) })),
      ...(feeValue > 0n ? { fee: { broadcasterShieldedAddress: request.fee.broadcasterShieldedAddress, value: feeValue } } : {}),
      ...(request.unshield
        ? {
            unshield: {
              recipient: request.unshield.recipient,
              value: request.unshield.amount,
              ...(request.unshield.adaptParams ? { adaptParams: request.unshield.adaptParams } : {}),
              ...(request.unshield.adaptContract ? { adaptContract: request.unshield.adaptContract } : {}),
            },
          }
        : {}),
      roots,
      chainID: BigInt(this.ctx.chainId),
    });
  }

  async prove(plan: Plan, options?: ProveOptions): Promise<ProofHandle> {
    if (!this.signer) throw new NoSpendCapabilityError('prove: wallet has no SpendSigner');
    const inputs = plan.selectedInputs.map((txo) => {
      const proof = this.scanState.merkleProof(txo.tree, txo.position);
      return { random: txo.random, value: txo.value, position: txo.position, merkleProofElements: proof.elements.map((e) => BigInt(`0x${e}`)) };
    });
    // Emit order (Spike 2): broadcaster fee note FIRST, then recipients, then change back to self.
    const outputs: WitnessOutputRequest[] = [];
    if (plan.summary.feeOutput) outputs.push({ receiverAddress: plan.summary.feeOutput.toShieldedAddress, value: plan.summary.feeOutput.value });
    for (const o of plan.summary.outputs) outputs.push({ receiverAddress: o.toShieldedAddress, value: o.value, ...(o.memo !== undefined ? { memo: o.memo } : {}) });
    if (plan.summary.changeValue > 0n) outputs.push({ receiverAddress: this.keyset.shieldedAddress, value: plan.summary.changeValue });

    return prove(
      {
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
          signer: this.signer,
          summary: plan.summary,
          merkleRoot: plan.merkleRoot,
          treeNumber: plan.boundParams.treeNumber,
          chainType: ChainType.EVM,
          chainId: this.ctx.chainId,
          unshield: plan.boundParams.unshield,
          // adaptContract/adaptParams are SNARK public inputs (bound-params hash + spend signature);
          // pass the plan's values so a cross-chain unshield's CCTP binding is committed by the proof.
          adaptContract: plan.boundParams.adaptContract,
          adaptParams: plan.boundParams.adaptParams,
          ...(plan.summary.unshield ? { unshieldOutput: plan.summary.unshield } : {}),
        },
        artifacts: this.ctx.artifacts,
        prover: this.ctx.prover,
        poolAddress: this.ctx.poolAddress,
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
      },
      options,
    );
  }

  async exportDisclosure(): Promise<Uint8Array> {
    throw new Error('exportDisclosure: not implemented — selective disclosure lands separately (SPEC §5.3)');
  }

  shareViewingKey(): string {
    return encodeShareableViewingKey({
      viewingPrivateKey: this.keyset.viewingPrivateKey,
      spendingPublicKey: this.keyset.spendingPublicKey,
    });
  }
}

/**
 * Construct an SDK instance — replaces `startRailgunEngine` + `loadProvider` + NETWORK_CONFIG patching.
 * Multiple instances per process are supported; all state is instance-scoped. `close()` releases the
 * prover's workers.
 *
 * Scan state persists through `config.storage` (namespaced by pool/deployBlock): a wallet's `sync()`
 * resumes from the last synced block rather than rescanning from genesis.
 */
export async function createArmadaSdk(config: ArmadaSdkConfig): Promise<ArmadaSdk> {
  await initPoseidonPromise;

  // Namespace the store by (schema, chain, pool, deployBlock); a mismatch resets chain-derived state.
  await config.storage.open({ schemaVersion: 1, chainId: config.pool.chainId, poolAddress: config.pool.poolAddress, deployBlock: config.pool.deployBlock });

  const provider: Provider =
    config.rpc.urls.length > 1
      ? new FallbackProvider(config.rpc.urls.map((u) => new JsonRpcProvider(u)))
      : new JsonRpcProvider(config.rpc.urls[0]);

  const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
  const getLogs = async (fromBlock: number, toBlock: number): Promise<ParsedPoolLog[]> => {
    const logs = await provider.getLogs({ address: config.pool.poolAddress, fromBlock, toBlock });
    const parsed: ParsedPoolLog[] = [];
    for (const log of logs) {
      const desc = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (desc === null) continue;
      parsed.push({ name: desc.name, args: desc.args as unknown as ParsedPoolLog['args'], blockNumber: log.blockNumber, txid: log.transactionHash });
    }
    return parsed;
  };

  const usdcTokenData = getTokenDataERC20(config.pool.usdcAddress);
  const usdcHash = getTokenDataHash(usdcTokenData);
  // Resolve a note's token hash → tokenData for USDC + any configured additional tokens (yield vault
  // shares, etc.). A hash isn't reversible to an address, so only pre-registered tokens are scannable.
  const tokenByHash = new Map<string, TokenData>();
  for (const address of [config.pool.usdcAddress, ...(config.pool.additionalTokens ?? [])]) {
    const tokenData = getTokenDataERC20(address);
    tokenByHash.set(getTokenDataHash(tokenData), tokenData);
  }
  const tokenDataGetter: TokenDataGetter = {
    getTokenDataFromHash: async (_v: unknown, _c: unknown, tokenHash: string): Promise<TokenData> => {
      const tokenData = tokenByHash.get(tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash);
      if (tokenData !== undefined) return tokenData;
      throw new Error(`createArmadaSdk: unknown token hash ${tokenHash}`);
    },
  };

  // RPC source is always built (source of truth + tail/verification fallback). An indexer, when
  // configured, becomes the primary fast path serving the native `/v2/quick-sync` wire contract.
  const rpcEventSource = new RpcEventSource(getLogs);
  const eventSource: EventSource = config.indexer
    ? new IndexerEventSource({ baseUrl: config.indexer.url, chainId: config.pool.chainId })
    : rpcEventSource;

  // On-chain commitment root at a block — read at the synced head so verification compares like-for-like.
  const rootIface = new Interface(['function merkleRoot() view returns (bytes32)']);
  const merkleRootAt = async (blockTag: number): Promise<string> => {
    const data = rootIface.encodeFunctionData('merkleRoot', []);
    const res = await provider.call({ to: config.pool.poolAddress, data, blockTag });
    return rootIface.decodeFunctionResult('merkleRoot', res)[0] as string;
  };

  const ctx: SdkContext = {
    provider,
    eventSource,
    rpcEventSource,
    merkleRootAt,
    tokenDataGetter,
    chain: { type: ChainType.EVM, id: config.pool.chainId },
    chainId: config.pool.chainId,
    usdcAddress: config.pool.usdcAddress,
    deployBlock: config.pool.deployBlock,
    usdcHash,
    tokenByHash,
    ...(config.pool.wrappers?.yieldAdapter !== undefined
      ? { yieldAdapterAddress: config.pool.wrappers.yieldAdapter.toLowerCase() }
      : {}),
    poolAddress: config.pool.poolAddress,
    prover: config.prover,
    artifacts: config.artifacts,
    storage: config.storage,
    allowPlaintextStorage: config.dangerouslyAllowPlaintextStorage === true,
    ...(config.telemetry !== undefined ? { telemetry: config.telemetry } : {}),
  };

  const wallet: WalletFactory = {
    async fromRootSecret(rootSecret, opts) {
      const keyset = await deriveKeyset(rootSecret);
      return new ArmadaWallet(keyset, opts.creationBlock, opts.signer, ctx);
    },
    async fromMnemonic(mnemonic, opts) {
      const keyset = await deriveKeysetFromMnemonic(mnemonic);
      return new ArmadaWallet(keyset, opts.creationBlock, opts.signer, ctx);
    },
    // Ephemeral (claimable payments, SPEC §6): in-memory, never persisted, auto-attaches a signer so
    // the claiming flow can spend. `seed` is the claim's 32-byte root; scans from the pool's deploy
    // block (block 0 would force a multi-million-block getLogs that public RPCs reject).
    async ephemeralFromSeed(seed) {
      const keyset = await deriveKeyset(seed);
      const signer = await LocalSigner.fromRootSecret(seed);
      return new ArmadaWallet(keyset, config.pool.deployBlock, signer, ctx, true);
    },
    async viewOnlyFromViewingKey(shareableViewingKey, opts) {
      const { viewingPrivateKey, spendingPublicKey } = decodeShareableViewingKey(shareableViewingKey);
      const identity = await deriveViewOnlyIdentity(viewingPrivateKey, spendingPublicKey);
      // View-only: no spending PRIVATE key, no signer → spend-path calls throw NoSpendCapabilityError.
      const keyset: Keyset = {
        spendingPublicKey,
        spendingPrivateKey: new Uint8Array(0),
        viewingPublicKey: identity.viewingPublicKey,
        viewingPrivateKey,
        nullifyingKey: identity.nullifyingKey,
        masterPublicKey: identity.masterPublicKey,
        shieldedAddress: identity.shieldedAddress,
      };
      return new ArmadaWallet(keyset, opts.creationBlock, undefined, ctx);
    },
  };

  return {
    wallet,
    async close() {
      await config.prover.close();
      await config.storage.close();
    },
  };
}
