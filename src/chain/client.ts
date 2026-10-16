// ABOUTME: ChainClient (F1, #143) — the SDK's one connection to the RPC: the chain/pool check, parsed pool logs, pool
// ABOUTME: view reads (accepted roots, spent nullifiers, the tree pinned to a block), block hashes/timestamps. Failures are RpcErrors.

import { FallbackProvider, Interface, JsonRpcProvider, type Provider } from 'ethers';
import { InvalidConfigError, RpcError } from '../errors';
import { POOL_V2_EVENT_ABI, type ParsedPoolLog } from '../sync/event-decoder';

/** The pool a client reads: the chain the RPC must serve, and the pool contract on it. */
export interface ChainClientPool {
  readonly chainId: number;
  readonly poolAddress: `0x${string}`;
}

/** The pool's tree state at one block (SPEC §4.4 sync verification). */
export interface PoolTreeState {
  readonly treeNumber: number;
  readonly merkleRoot: bigint;
  readonly nextLeafIndex: number;
}

const POOL_VIEWS = new Interface([
  'function rootHistory(uint256, bytes32) view returns (bool)',
  'function nullifiers(uint256, bytes32) view returns (bool)',
  'function treeNumber() view returns (uint256)',
  'function merkleRoot() view returns (bytes32)',
  'function nextLeafIndex() view returns (uint256)',
]);
const POOL_EVENTS = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
const bytes32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;

// Run one provider call, turning its failure into an RpcError naming the call (the provider's error is the cause).
async function rpc<T>(method: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RpcError(method, err);
  }
}

export class ChainClient {
  // A confirmed chain/pool check, shared by concurrent callers. A failed check isn't kept, so it's retried.
  private chainConfirmed: Promise<void> | undefined;

  constructor(
    private readonly provider: Provider,
    private readonly pool: ChainClientPool,
  ) {}

  /**
   * A client over `urls`. Several URLs fail over (quorum 1): ethers' default quorum of ceil(n/2) makes one node
   * lagging near head fail getLogs/call outright instead of falling through to a healthy one.
   */
  static fromRpcUrls(urls: readonly string[], pool: ChainClientPool): ChainClient {
    const provider: Provider =
      urls.length > 1
        ? new FallbackProvider(urls.map((u) => new JsonRpcProvider(u)), undefined, { quorum: 1 })
        : new JsonRpcProvider(urls[0]);
    return new ChainClient(provider, pool);
  }

  /**
   * Resolves once the RPC is confirmed to serve `pool.chainId` and `pool.poolAddress` has code. Checked lazily (so
   * creating an SDK stays offline-capable) and once per client; a failed RPC read is retried on the next call.
   * Rejects with `InvalidConfigError` on a mismatch.
   */
  ensureChain(): Promise<void> {
    this.chainConfirmed ??= (async () => {
      const network = await rpc('getNetwork', () => this.provider.getNetwork());
      if (Number(network.chainId) !== this.pool.chainId) {
        throw new InvalidConfigError(`rpc serves chain ${network.chainId}, but pool.chainId is ${this.pool.chainId}`);
      }
      if ((await rpc('getCode', () => this.provider.getCode(this.pool.poolAddress))) === '0x') {
        throw new InvalidConfigError(`pool.poolAddress ${this.pool.poolAddress} has no contract code on chain ${this.pool.chainId}`);
      }
    })().catch((err: unknown) => {
      this.chainConfirmed = undefined;
      throw err;
    });
    return this.chainConfirmed;
  }

  /** The pool's event logs in `[fromBlock, toBlock]`, parsed; logs that aren't pool events are skipped. */
  async getLogs(fromBlock: number, toBlock: number): Promise<ParsedPoolLog[]> {
    const logs = await rpc('getLogs', () => this.provider.getLogs({ address: this.pool.poolAddress, fromBlock, toBlock }));
    const parsed: ParsedPoolLog[] = [];
    for (const log of logs) {
      const desc = POOL_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
      if (desc === null) continue;
      parsed.push({ name: desc.name, args: desc.args as unknown as ParsedPoolLog['args'], blockNumber: log.blockNumber, txid: log.transactionHash });
    }
    return parsed;
  }

  getBlockNumber(): Promise<number> {
    return rpc('getBlockNumber', () => this.provider.getBlockNumber());
  }

  /** Block `n`'s hash, or undefined when the node doesn't return the block. */
  async getBlockHash(n: number): Promise<string | undefined> {
    return (await rpc('getBlock', () => this.provider.getBlock(n)))?.hash ?? undefined;
  }

  /** Block `n`'s timestamp (seconds), or undefined when the node doesn't return the block. */
  async getBlockTimestamp(n: number): Promise<number | undefined> {
    return (await rpc('getBlock', () => this.provider.getBlock(n)))?.timestamp;
  }

  /** Whether `address` has contract code. */
  async hasCode(address: string): Promise<boolean> {
    return (await rpc('getCode', () => this.provider.getCode(address))) !== '0x';
  }

  /** Whether `root` is in the pool's accepted root history for `treeNumber` (SPEC §4.4/§4.7). */
  async isKnownRoot(treeNumber: number, root: bigint): Promise<boolean> {
    const data = POOL_VIEWS.encodeFunctionData('rootHistory', [treeNumber, bytes32(root)]);
    const res = await rpc('call', () => this.provider.call({ to: this.pool.poolAddress, data }));
    return POOL_VIEWS.decodeFunctionResult('rootHistory', res)[0] as boolean;
  }

  /** Whether `(treeNumber, nullifier)` is already spent on-chain (SPEC §4.7). */
  async isNullifierSpent(treeNumber: number, nullifier: bigint): Promise<boolean> {
    const data = POOL_VIEWS.encodeFunctionData('nullifiers', [treeNumber, bytes32(nullifier)]);
    const res = await rpc('call', () => this.provider.call({ to: this.pool.poolAddress, data }));
    return POOL_VIEWS.decodeFunctionResult('nullifiers', res)[0] as boolean;
  }

  /**
   * The pool's current tree number, root and leaf count as of `blockTag`. A hash tag needs only recent state (well
   * within a non-archive node's window for any sensible confirmationDepth); an orphaned hash fails the read rather
   * than answering from another fork.
   */
  async readPoolTree(blockTag: string | number): Promise<PoolTreeState> {
    const read = async (fn: 'treeNumber' | 'merkleRoot' | 'nextLeafIndex'): Promise<unknown> => {
      const res = await rpc('call', () => this.provider.call({ to: this.pool.poolAddress, data: POOL_VIEWS.encodeFunctionData(fn, []), blockTag }));
      return POOL_VIEWS.decodeFunctionResult(fn, res)[0];
    };
    const [treeNumber, merkleRoot, nextLeafIndex] = await Promise.all([read('treeNumber'), read('merkleRoot'), read('nextLeafIndex')]);
    return { treeNumber: Number(treeNumber), merkleRoot: BigInt(merkleRoot as string), nextLeafIndex: Number(nextLeafIndex) };
  }

  /** Release the provider: its polling timers and sockets would keep a Node process alive. */
  destroy(): void {
    this.provider.destroy();
  }
}
