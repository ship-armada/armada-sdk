// ABOUTME: Tests for ChainClient (F1, #143) — the one place the SDK talks to the RPC: the chain/pool check, parsed
// ABOUTME: pool logs, pool view reads (pinned to a block when asked), block hashes/timestamps, and teardown.

import { describe, it, expect } from 'vitest';
import { Interface, type Provider } from 'ethers';
import { ChainClient } from './client';
import { InvalidConfigError, RpcError } from '../errors';
import { POOL_V2_EVENT_ABI } from '../sync/event-decoder';

const POOL = `0x${'11'.repeat(20)}` as const;
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const poolIface = new Interface([
  'function rootHistory(uint256, bytes32) view returns (bool)',
  'function nullifiers(uint256, bytes32) view returns (bool)',
  'function treeNumber() view returns (uint256)',
  'function merkleRoot() view returns (bytes32)',
  'function nextLeafIndex() view returns (uint256)',
]);

// A scripted provider: records what it's asked, answers from `state`.
function fakeProvider(state: { chainId?: bigint; code?: string; failNetworkOnce?: boolean } = {}) {
  const calls: { method: string; args: unknown }[] = [];
  let failNetwork = state.failNetworkOnce === true;
  const provider = {
    async getNetwork() {
      calls.push({ method: 'getNetwork', args: undefined });
      if (failNetwork) {
        failNetwork = false;
        throw new Error('ECONNRESET');
      }
      return { chainId: state.chainId ?? 31337n };
    },
    async getCode(address: string) {
      calls.push({ method: 'getCode', args: address });
      return state.code ?? '0x6080';
    },
    async getBlockNumber() {
      return 42;
    },
    async getBlock(n: number) {
      return n > 42 ? null : { number: n, hash: b32(BigInt(n)), timestamp: 1_000 + n };
    },
    async getLogs(filter: unknown) {
      calls.push({ method: 'getLogs', args: filter });
      const pool = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
      const nullified = pool.encodeEventLog('Nullified', [3, [b32(9n)]]);
      return [
        { ...nullified, blockNumber: 10, transactionHash: b32(1n) },
        // A log of some other event at the pool address — not a pool event, skipped.
        { topics: [b32(123n)], data: '0x', blockNumber: 11, transactionHash: b32(2n) },
      ];
    },
    async call(tx: { to: string; data: string; blockTag?: unknown }) {
      calls.push({ method: 'call', args: tx });
      const d = poolIface.parseTransaction({ data: tx.data })!;
      switch (d.name) {
        case 'rootHistory':
          return poolIface.encodeFunctionResult('rootHistory', [BigInt(d.args[1]) === 5n]);
        case 'nullifiers':
          return poolIface.encodeFunctionResult('nullifiers', [BigInt(d.args[1]) === 6n]);
        case 'treeNumber':
          return poolIface.encodeFunctionResult('treeNumber', [2]);
        case 'merkleRoot':
          return poolIface.encodeFunctionResult('merkleRoot', [b32(77n)]);
        default:
          return poolIface.encodeFunctionResult('nextLeafIndex', [12]);
      }
    },
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  return { provider, calls, asProvider: provider as unknown as Provider };
}

const client = (p: Provider): ChainClient => new ChainClient(p, { chainId: 31337, poolAddress: POOL });

describe('ChainClient (F1, #143)', () => {
  it('checks the chain and pool once, and retries after a failed RPC call', async () => {
    const { asProvider, calls } = fakeProvider({ failNetworkOnce: true });
    const c = client(asProvider);
    await expect(c.ensureChain()).rejects.toThrow('ECONNRESET');
    await c.ensureChain();
    await c.ensureChain();
    expect(calls.filter((x) => x.method === 'getNetwork')).toHaveLength(2); // the failure isn't remembered; success is
    expect(calls.filter((x) => x.method === 'getCode')).toEqual([{ method: 'getCode', args: POOL }]);
  });

  it('rejects an RPC on another chain, or a pool address with no code, with InvalidConfigError', async () => {
    await expect(client(fakeProvider({ chainId: 1n }).asProvider).ensureChain()).rejects.toBeInstanceOf(InvalidConfigError);
    await expect(client(fakeProvider({ code: '0x' }).asProvider).ensureChain()).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it('reads the pool logs for a block range, parsed, skipping logs that are not pool events', async () => {
    const { asProvider, calls } = fakeProvider();
    const logs = await client(asProvider).getLogs(10, 20);
    expect(calls.find((x) => x.method === 'getLogs')?.args).toEqual({ address: POOL, fromBlock: 10, toBlock: 20 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ name: 'Nullified', blockNumber: 10, txid: b32(1n) });
  });

  it('answers the pool view reads: accepted roots and spent nullifiers', async () => {
    const c = client(fakeProvider().asProvider);
    expect(await c.isKnownRoot(0, 5n)).toBe(true);
    expect(await c.isKnownRoot(0, 4n)).toBe(false);
    expect(await c.isNullifierSpent(0, 6n)).toBe(true);
    expect(await c.isNullifierSpent(0, 7n)).toBe(false);
  });

  it('reads the pool tree pinned to the given block', async () => {
    const { asProvider, calls } = fakeProvider();
    expect(await client(asProvider).readPoolTree('0xabc')).toEqual({ treeNumber: 2, merkleRoot: 77n, nextLeafIndex: 12 });
    const tags = calls.filter((x) => x.method === 'call').map((x) => (x.args as { blockTag?: unknown }).blockTag);
    expect(tags).toEqual(['0xabc', '0xabc', '0xabc']);
  });

  it('reads the head, block hashes and timestamps (undefined for a block the node does not have), and code', async () => {
    const c = client(fakeProvider().asProvider);
    expect(await c.getBlockNumber()).toBe(42);
    expect(await c.getBlockHash(10)).toBe(b32(10n));
    expect(await c.getBlockHash(99)).toBeUndefined();
    expect(await c.getBlockTimestamp(10)).toBe(1_010);
    expect(await c.getBlockTimestamp(99)).toBeUndefined();
    expect(await c.hasCode(POOL)).toBe(true);
    expect(await client(fakeProvider({ code: '0x' }).asProvider).hasCode(POOL)).toBe(false);
  });

  it('wraps a provider failure in RpcError, telling an unreachable node from one that answered with an error (F4)', async () => {
    // WHY: raw ethers errors reached consumers, their `code` field sharing the namespace with the SDK's codes.
    const failing = (error: unknown): Provider => ({ getLogs: async () => { throw error; } }) as unknown as Provider;
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });
    const limited = Object.assign(new Error('query returned more than 10000 results'), { code: 'UNKNOWN_ERROR' });
    const a = await client(failing(down)).getLogs(1, 2).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(RpcError);
    expect(a).toMatchObject({ code: 'RPC', method: 'getLogs', transport: true, cause: down });
    const b = await client(failing(limited)).getLogs(1, 2).catch((e: unknown) => e);
    expect(b).toMatchObject({ code: 'RPC', method: 'getLogs', transport: false, cause: limited });
  });

  it('destroy() releases the provider', () => {
    const { provider, asProvider } = fakeProvider();
    client(asProvider).destroy();
    expect(provider.destroyed).toBe(true);
  });
});
