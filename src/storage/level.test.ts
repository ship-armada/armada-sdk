// ABOUTME: Tests for LevelStorageAdapter (§4.3) — exercised against a real abstract-level DB
// ABOUTME: (memory-level) for the storage contract, plus a stub for the locked-database conflict path.

import { describe, it, expect } from 'vitest';
import { MemoryLevel } from 'memory-level';
import { LevelStorageAdapter, type AbstractLevelLike } from './level';
import { StorageConflictError } from '../errors';
import type { StorageNamespace } from './index';

const ns = (deployBlock: number): StorageNamespace => ({
  schemaVersion: 1,
  chainId: 31337,
  poolAddress: '0x1111111111111111111111111111111111111111',
  deployBlock,
});
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);
const level = (): AbstractLevelLike => new MemoryLevel({ keyEncoding: 'utf8', valueEncoding: 'view' }) as unknown as AbstractLevelLike;

describe('LevelStorageAdapter (§4.3)', () => {
  it('put / get / del round-trip through a real abstract-level DB', async () => {
    const s = new LevelStorageAdapter(level());
    await s.open(ns(10));
    await s.put('chain/merkle/0', bytes('node'));
    expect(str((await s.get('chain/merkle/0'))!)).toBe('node');
    await s.del('chain/merkle/0');
    expect(await s.get('chain/merkle/0')).toBeUndefined();
    await s.close();
  });

  it('lists by prefix (ordered) and returns plain Uint8Array values', async () => {
    const s = new LevelStorageAdapter(level());
    await s.open(ns(10));
    await s.put('chain/note/2', bytes('two'));
    await s.put('chain/note/1', bytes('one'));
    await s.put('identity/wallet/x', bytes('id'));
    const out: [string, string][] = [];
    for await (const { key, value } of s.list('chain/note/')) out.push([key, str(value)]);
    expect(out).toEqual([['chain/note/1', 'one'], ['chain/note/2', 'two']]);
    await s.close();
  });

  it('resets chain-derived keys on a deploy change, preserving identity/ and durable/', async () => {
    const db = level();
    const s = new LevelStorageAdapter(db);
    expect(await s.open(ns(10))).toEqual({ reset: false });
    await s.put('chain/merkle/0', bytes('m'));
    await s.put('identity/wallet/x', bytes('id'));
    await s.put('durable/claim-counter', bytes('7'));

    // Reopen the SAME db under a changed deployBlock → chain state wiped, identity + durable kept.
    expect(await s.open(ns(20))).toEqual({ reset: true });
    expect(await s.get('chain/merkle/0')).toBeUndefined();
    expect(str((await s.get('identity/wallet/x'))!)).toBe('id');
    expect(str((await s.get('durable/claim-counter'))!)).toBe('7');
    expect(await s.open(ns(20))).toEqual({ reset: false }); // same namespace → no reset
    await s.close();
  });

  it('maps a locked database to StorageConflictError (advisory locking)', async () => {
    // classic-level throws LEVEL_LOCKED when a second process opens the same on-disk dir.
    const locked: AbstractLevelLike = {
      status: 'closed',
      open: async () => { throw Object.assign(new Error('IO error: lock held'), { code: 'LEVEL_LOCKED' }); },
      close: async () => {},
      get: async () => undefined,
      put: async () => {},
      del: async () => {},
      iterator: () => ({ all: async () => [] }),
    };
    await expect(new LevelStorageAdapter(locked).open(ns(1))).rejects.toBeInstanceOf(StorageConflictError);
  });
});
