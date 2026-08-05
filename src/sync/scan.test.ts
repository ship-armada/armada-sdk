// ABOUTME: Unit tests for scan checkpoints + the resumable scan orchestrator — persistence,
// ABOUTME: encrypted-at-rest, resetChainState wipe, incremental resume, and crash-safe checkpointing.

import { describe, it, expect, vi } from 'vitest';
import { MemoryStorageAdapter } from '../storage/memory';
import { EncryptedStore, deriveStorageKey } from '../storage/encrypted';
import type { StorageNamespace } from '../storage/index';
import { CheckpointStore } from './checkpoints';
import { runScan } from './scan';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const blockLogs = () =>
  vi.fn(async (from: number, to: number): Promise<number[]> => range(from, to));

describe('CheckpointStore', () => {
  it('set / get / clear round-trip, isolated by (wallet, chain)', async () => {
    const cp = new CheckpointStore(new MemoryStorageAdapter());
    await cp.set('w1', 31337, { syncedThrough: 100 });
    expect(await cp.get('w1', 31337)).toEqual({ syncedThrough: 100 });
    expect(await cp.get('w2', 31337)).toBeUndefined();
    expect(await cp.get('w1', 1)).toBeUndefined();
    await cp.clear('w1', 31337);
    expect(await cp.get('w1', 31337)).toBeUndefined();
  });

  it('encrypts the checkpoint at rest when wrapped in EncryptedStore', async () => {
    const inner = new MemoryStorageAdapter();
    const cp = new CheckpointStore(new EncryptedStore(inner, deriveStorageKey(new Uint8Array(32).fill(3))));
    await cp.set('w1', 31337, { syncedThrough: 42 });
    expect(await cp.get('w1', 31337)).toEqual({ syncedThrough: 42 });
    const raw = await inner.get('chain/scan-checkpoint/31337/w1');
    expect(new TextDecoder().decode(raw!)).not.toContain('syncedThrough');
  });

  it('is wiped by resetChainState (checkpoints are chain-derived)', async () => {
    const storage = new MemoryStorageAdapter();
    const ns: StorageNamespace = {
      schemaVersion: 1,
      chainId: 31337,
      poolAddress: '0x1111111111111111111111111111111111111111',
      deployBlock: 5,
    };
    await storage.open(ns);
    const cp = new CheckpointStore(storage);
    await cp.set('w1', 31337, { syncedThrough: 100 });
    await storage.resetChainState();
    expect(await cp.get('w1', 31337)).toBeUndefined();
  });
});

describe('runScan', () => {
  it('scans deployBlock..head on first run, then resumes incrementally', async () => {
    const cp = new CheckpointStore(new MemoryStorageAdapter());
    const seen: number[] = [];
    const push = async (events: number[]) => {
      seen.push(...events);
    };

    const r1 = await runScan(cp, {
      walletId: 'w1', chainId: 31337, deployBlock: 10, headBlock: 20,
      getLogs: blockLogs(), onEvents: push,
    });
    expect(r1).toEqual({ fromBlock: 10, syncedThrough: 20, scanned: true });
    expect(seen).toEqual(range(10, 20));

    const r2 = await runScan(cp, {
      walletId: 'w1', chainId: 31337, deployBlock: 10, headBlock: 25,
      getLogs: blockLogs(), onEvents: push,
    });
    expect(r2).toEqual({ fromBlock: 21, syncedThrough: 25, scanned: true }); // no re-scan of 10..20
    expect(seen).toEqual(range(10, 25));
  });

  it('is a no-op when already synced to head', async () => {
    const cp = new CheckpointStore(new MemoryStorageAdapter());
    await cp.set('w1', 31337, { syncedThrough: 25 });
    const getLogs = blockLogs();
    const r = await runScan(cp, {
      walletId: 'w1', chainId: 31337, deployBlock: 10, headBlock: 25,
      getLogs, onEvents: async () => {},
    });
    expect(r.scanned).toBe(false);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('does NOT advance the checkpoint if onEvents throws (crash-safe re-fetch)', async () => {
    const cp = new CheckpointStore(new MemoryStorageAdapter());
    await expect(
      runScan(cp, {
        walletId: 'w1', chainId: 31337, deployBlock: 10, headBlock: 20,
        getLogs: blockLogs(), onEvents: async () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');
    expect(await cp.get('w1', 31337)).toBeUndefined();
  });
});
