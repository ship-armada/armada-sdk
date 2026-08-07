// ABOUTME: createArmadaSdk instance (SPEC §4.1) — composes provider + sync + prover + tx + wallet into a
// ABOUTME: per-instance handle (no singletons). Wallets sync from RPC, report balances, plan, and prove.

import { JsonRpcProvider, FallbackProvider, Interface, type Provider } from 'ethers';
import {
  WalletScanState,
  RpcEventSource,
  IndexerEventSource,
  tryDecryptCommitment,
  tryDecryptShield,
  ownedNoteFromTransactNote,
  reconstructReceiveHistory,
  saveScanState,
  loadScanState,
  POOL_V2_EVENT_ABI,
  type EventSource,
  type WalletDecryptors,
  type HistoryEntry,
  type TokenAddressResolver,
  type ParsedPoolLog,
  type ReceiverNoteKeys,
  type TokenBalance,
} from './sync/index';
import type { StorageAdapter } from './storage/index';
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
  initPoseidonPromise,
  type TokenData,
  type TokenDataGetter,
  type Chain,
} from './core/index';
import type { ProveOptions, ProverAdapter, ArtifactSource } from './prover/index';
import { NoSpendCapabilityError, RootMismatchError } from './errors';
import type { ArmadaSdk, ArmadaSdkConfig } from './index';

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
  /** Canonical 32-byte hash (no 0x) of USDC — maps owned-note token hashes back to the address. */
  readonly usdcHash: string;
  readonly poolAddress: `0x${string}`;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
  readonly storage: StorageAdapter;
}

class ArmadaWallet implements Wallet {
  private scanState = new WalletScanState();
  private syncedThrough: number;
  private hydrated = false;

  constructor(
    private readonly keyset: Keyset,
    creationBlock: number,
    private readonly signer: SpendSigner | undefined,
    private readonly ctx: SdkContext,
  ) {
    this.syncedThrough = creationBlock - 1;
  }

  get railgunAddress(): string {
    return this.keyset.railgunAddress;
  }
  get canSpend(): boolean {
    return this.signer !== undefined;
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
    const persisted = await loadScanState(this.ctx.storage, this.keyset.railgunAddress);
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
    };
  }

  // Apply a source's batch for [from, to] and report how far it covered.
  private async applyBatch(source: EventSource, from: number, to: number, decryptors: WalletDecryptors): Promise<number> {
    const batch = await source.getEvents(from, to);
    await this.scanState.apply(batch.events, decryptors);
    return batch.syncedThroughBlock;
  }

  // Sync [from, head] from the primary source, RPC-covering any tail the (indexer) source lagged.
  private async applyToHead(from: number, head: number, decryptors: WalletDecryptors): Promise<void> {
    const covered = await this.applyBatch(this.ctx.eventSource, from, head, decryptors);
    if (covered < head) await this.applyBatch(this.ctx.rpcEventSource, covered + 1, head, decryptors);
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

  async sync(): Promise<{ syncedThrough: number }> {
    await this.hydrate();
    const head = await this.ctx.provider.getBlockNumber();
    if (head <= this.syncedThrough) return { syncedThrough: this.syncedThrough };

    const from = this.syncedThrough + 1;
    const decryptors = this.decryptors();
    // Only the indexer source is untrusted; snapshot so we can roll back a bad batch.
    const usingIndexer = this.ctx.eventSource !== this.ctx.rpcEventSource;
    const rollback = usingIndexer ? this.scanState.snapshot() : undefined;

    await this.applyToHead(from, head, decryptors);

    if (usingIndexer) {
      try {
        await this.verifyCurrentRoot(head);
      } catch (err) {
        if (!(err instanceof RootMismatchError)) throw err;
        // Indexer served a tree that doesn't match chain — discard it and re-scan from RPC (truth).
        this.scanState = WalletScanState.restore(rollback!);
        await this.applyBatch(this.ctx.rpcEventSource, from, head, decryptors);
      }
    }

    this.syncedThrough = head;
    await saveScanState(this.ctx.storage, this.keyset.railgunAddress, this.scanState, head);
    return { syncedThrough: head };
  }

  async balances(): Promise<TokenBalance[]> {
    const head = await this.ctx.provider.getBlockNumber();
    return this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: 0 });
  }

  async history(options?: { sinceBlock?: number }): Promise<HistoryEntry[]> {
    const resolveToken: TokenAddressResolver = (hash) =>
      (hash.startsWith('0x') ? hash.slice(2) : hash) === this.ctx.usdcHash ? this.ctx.usdcAddress : undefined;
    let entries = reconstructReceiveHistory(
      this.scanState.ownedTxos(),
      this.scanState.spentNullifiers(),
      this.keyset.nullifyingKey,
      resolveToken,
    );
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
    const feeValue = BigInt(request.fee.schedule['transfer'] ?? '0');
    return planTransfer({
      txos,
      tokenAddress: this.ctx.usdcAddress,
      outputs: request.outputs.map((o) => ({ toRailgunAddress: o.to0zk, value: o.amount, ...(o.memo !== undefined ? { memo: o.memo } : {}) })),
      ...(feeValue > 0n ? { fee: { broadcasterRailgunAddress: request.fee.broadcasterRailgunAddress, value: feeValue } } : {}),
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
    if (plan.summary.feeOutput) outputs.push({ receiverAddress: plan.summary.feeOutput.toRailgunAddress, value: plan.summary.feeOutput.value });
    for (const o of plan.summary.outputs) outputs.push({ receiverAddress: o.toRailgunAddress, value: o.value, ...(o.memo !== undefined ? { memo: o.memo } : {}) });
    if (plan.summary.changeValue > 0n) outputs.push({ receiverAddress: this.keyset.railgunAddress, value: plan.summary.changeValue });

    return prove(
      {
        witness: {
          inputs,
          outputs,
          tokenAddress: this.ctx.usdcAddress,
          sender: {
            masterPublicKey: this.keyset.masterPublicKey,
            viewingPublicKey: this.keyset.viewingPublicKey,
            viewingPrivateKey: this.keyset.viewingPrivateKey,
            nullifyingKey: this.keyset.nullifyingKey,
            spendingPublicKey: this.keyset.spendingPublicKey,
            senderAddress: this.keyset.railgunAddress,
          },
          signer: this.signer,
          summary: plan.summary,
          merkleRoot: plan.merkleRoot,
          treeNumber: plan.boundParams.treeNumber,
          chainType: ChainType.EVM,
          chainId: this.ctx.chainId,
        },
        artifacts: this.ctx.artifacts,
        prover: this.ctx.prover,
        poolAddress: this.ctx.poolAddress,
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
  const tokenDataGetter: TokenDataGetter = {
    getTokenDataFromHash: async (_v: unknown, _c: unknown, tokenHash: string): Promise<TokenData> => {
      if ((tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash) === usdcHash) return usdcTokenData;
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
    usdcHash,
    poolAddress: config.pool.poolAddress,
    prover: config.prover,
    artifacts: config.artifacts,
    storage: config.storage,
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
    // the claiming flow can spend. `seed` is the claim's 32-byte root; scans from the pool's genesis.
    async ephemeralFromSeed(seed) {
      const keyset = await deriveKeyset(seed);
      const signer = await LocalSigner.fromRootSecret(seed);
      return new ArmadaWallet(keyset, 0, signer, ctx);
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
        railgunAddress: identity.railgunAddress,
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
