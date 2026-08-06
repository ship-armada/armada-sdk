// ABOUTME: createArmadaSdk instance (SPEC §4.1) — composes provider + sync + prover + tx + wallet into a
// ABOUTME: per-instance handle (no singletons). Wallets sync from RPC, report balances, plan, and prove.

import { JsonRpcProvider, FallbackProvider, Interface, type Provider } from 'ethers';
import {
  WalletScanState,
  fetchLogsRanged,
  decodePoolEvents,
  tryDecryptCommitment,
  tryDecryptShield,
  ownedNoteFromTransactNote,
  POOL_V2_EVENT_ABI,
  type ParsedPoolLog,
  type ReceiverNoteKeys,
  type TokenBalance,
} from './sync/index';
import { planTransfer, prove, type Plan, type ProofHandle } from './tx/index';
import type { WitnessOutputRequest } from './tx/witness';
import {
  deriveKeyset,
  deriveKeysetFromMnemonic,
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
import { NoSpendCapabilityError } from './errors';
import type { ArmadaSdk, ArmadaSdkConfig } from './index';

// Per-instance shared context handed to each wallet.
interface SdkContext {
  readonly provider: Provider;
  readonly getLogs: (fromBlock: number, toBlock: number) => Promise<ParsedPoolLog[]>;
  readonly tokenDataGetter: TokenDataGetter;
  readonly chain: Chain;
  readonly chainId: number;
  readonly usdcAddress: `0x${string}`;
  readonly poolAddress: `0x${string}`;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
}

class ArmadaWallet implements Wallet {
  private readonly scanState = new WalletScanState();
  private syncedThrough: number;

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

  async sync(): Promise<{ syncedThrough: number }> {
    const head = await this.ctx.provider.getBlockNumber();
    if (head <= this.syncedThrough) return { syncedThrough: this.syncedThrough };

    const parsed = await fetchLogsRanged(this.ctx.getLogs, { fromBlock: this.syncedThrough + 1, toBlock: head });
    const decoded = decodePoolEvents(parsed);
    const receiver = this.receiver();
    await this.scanState.apply(decoded, {
      transact: async (c) => {
        const note = await tryDecryptCommitment(c.ciphertext, receiver, this.ctx.tokenDataGetter, this.ctx.chain);
        return note ? ownedNoteFromTransactNote(note) : undefined;
      },
      shield: (c) => tryDecryptShield(c, receiver),
    });
    this.syncedThrough = head;
    return { syncedThrough: head };
  }

  async balances(): Promise<TokenBalance[]> {
    const head = await this.ctx.provider.getBlockNumber();
    return this.scanState.balances(this.keyset.nullifyingKey, { currentBlock: head, finalityThreshold: 0 });
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
}

/**
 * Construct an SDK instance — replaces `startRailgunEngine` + `loadProvider` + NETWORK_CONFIG patching.
 * Multiple instances per process are supported; all state is instance-scoped. `close()` releases the
 * prover's workers.
 *
 * NOTE: scan state is in-memory per wallet for now; persisting it through `config.storage`
 * (checkpoints + TXO records) is a follow-up. Custody factory methods beyond `fromRootSecret`
 * (ephemeral / mnemonic / view-only) land with the custody-lifecycle work.
 */
export async function createArmadaSdk(config: ArmadaSdkConfig): Promise<ArmadaSdk> {
  await initPoseidonPromise;

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

  const ctx: SdkContext = {
    provider,
    getLogs,
    tokenDataGetter,
    chain: { type: ChainType.EVM, id: config.pool.chainId },
    chainId: config.pool.chainId,
    usdcAddress: config.pool.usdcAddress,
    poolAddress: config.pool.poolAddress,
    prover: config.prover,
    artifacts: config.artifacts,
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
    async viewOnlyFromViewingKey() {
      // Needs the shareable-viewing-key wire codec (a flagged format decision) + its export
      // counterpart; view-only wallets land in a separate increment (SPEC §4.2.2).
      throw new Error('viewOnlyFromViewingKey: not implemented — pending the shareable-viewing-key wire codec');
    },
  };

  return {
    wallet,
    async close() {
      await config.prover.close();
    },
  };
}
