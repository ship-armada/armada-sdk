// ABOUTME: EventSource tests — RpcEventSource (getLogs → decode) + IndexerEventSource (native
// ABOUTME: quick-sync fetch/parse), incl. the differential that indexer events == getLogs-decoded events.

import { describe, it, expect } from 'vitest';
import type { DecodedPoolEvents, ParsedPoolLog } from './event-decoder';
import { serializeQuickSync } from './quick-sync-wire';
import { RpcEventSource, IndexerEventSource } from './event-source';

const h = (b: string): string => b.repeat(32);

// A native decoded-event set — exactly what a getLogs scan produces + what the indexer must reconstruct.
const EVENTS: DecodedPoolEvents = {
  shields: [
    {
      tree: 0,
      position: 0,
      blockNumber: 10,
      txid: `0x${h('ab')}`,
      hash: h('aa'),
      npk: h('bb'),
      tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' },
      value: 1_000_000n,
      encryptedBundle: [h('c1'), h('c2'), h('c3')],
      shieldKey: h('dd'),
    },
  ],
  transacts: [
    {
      tree: 0,
      position: 1,
      blockNumber: 11,
      txid: `0x${h('cd')}`,
      hash: h('ee'),
      ciphertext: {
        ciphertext: [h('f0'), h('f1'), h('f2'), h('f3')],
        blindedSenderViewingKey: new Uint8Array([1, 2, 3, 4]),
        blindedReceiverViewingKey: new Uint8Array([9, 8, 7]),
        memo: '',
        annotationData: h('99'),
      },
    },
  ],
  nullifiers: [{ tree: 0, nullifier: 42n, blockNumber: 12, txid: `0x${h('ef')}` }],
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('RpcEventSource', () => {
  it('decodes getLogs output and reports the full requested range', async () => {
    const nullifiedLog = {
      name: 'Nullified',
      args: { treeNumber: 0, nullifier: [`0x${h('11')}`] },
      blockNumber: 50,
      txid: `0x${h('ab')}`,
    } as unknown as ParsedPoolLog;
    const src = new RpcEventSource(async () => [nullifiedLog]);

    const batch = await src.getEvents(1, 100);
    expect(batch.syncedThroughBlock).toBe(100); // RPC always covers the full window
    expect(batch.events.nullifiers).toHaveLength(1);
    expect(batch.events.nullifiers[0]).toMatchObject({ tree: 0, blockNumber: 50 });
  });
});

describe('IndexerEventSource', () => {
  it('fetches /v2/quick-sync and reconstructs the native decoded events (differential)', async () => {
    // WHY: the whole point of the native wire format — an indexer-served batch must decode to the
    // SAME DecodedPoolEvents a getLogs scan would produce, so both paths build an identical tree.
    let calledUrl = '';
    const fetchFn = (async (url: string) => {
      calledUrl = url;
      return jsonResponse(serializeQuickSync(EVENTS, 90));
    }) as unknown as typeof fetch;
    const src = new IndexerEventSource({ baseUrl: 'https://watcher.example/', chainId: 31337, fetchFn });

    const batch = await src.getEvents(1, 100);
    expect(calledUrl).toBe('https://watcher.example/v2/quick-sync/31337?fromBlock=1&toBlock=100');
    expect(batch.events).toEqual(EVENTS);
    expect(batch.syncedThroughBlock).toBe(90); // indexer lagged head → SDK will RPC-cover 91..100
  });

  it('caps syncedThroughBlock at the requested head even if the indexer over-reports', async () => {
    const fetchFn = (async () => jsonResponse(serializeQuickSync(EVENTS, 500))) as unknown as typeof fetch;
    const src = new IndexerEventSource({ baseUrl: 'https://watcher.example', chainId: 1, fetchFn });
    const batch = await src.getEvents(1, 100);
    expect(batch.syncedThroughBlock).toBe(100);
  });

  it('throws on a non-OK indexer response (→ SDK falls back to RPC)', async () => {
    const fetchFn = (async () => jsonResponse({}, false, 503)) as unknown as typeof fetch;
    const src = new IndexerEventSource({ baseUrl: 'https://watcher.example', chainId: 1, fetchFn });
    await expect(src.getEvents(1, 100)).rejects.toThrow(/503/);
  });
});
