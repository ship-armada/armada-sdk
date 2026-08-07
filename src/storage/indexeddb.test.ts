// ABOUTME: IndexedDBStorageAdapter tests (fake-indexeddb) — KV round-trip, prefix list ordering,
// ABOUTME: identity-preserving resetChainState + namespace-change reset, and persistence across reopen.

import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { IndexedDBStorageAdapter } from './indexeddb'

const ns = (deployBlock: number): { schemaVersion: number; chainId: number; poolAddress: `0x${string}`; deployBlock: number } => ({
  schemaVersion: 1,
  chainId: 31337,
  poolAddress: `0x${'11'.repeat(20)}`,
  deployBlock,
})
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined): string | undefined => (b === undefined ? undefined : new TextDecoder().decode(b))

let counter = 0
const freshName = (): string => `test-db-${(counter += 1)}`

async function drain(store: IndexedDBStorageAdapter, prefix: string): Promise<Array<{ key: string; value: string }>> {
  const out: Array<{ key: string; value: string }> = []
  for await (const { key, value } of store.list(prefix)) out.push({ key, value: new TextDecoder().decode(value) })
  return out
}

describe('IndexedDBStorageAdapter', () => {
  it('round-trips put/get/del', async () => {
    const store = new IndexedDBStorageAdapter(freshName())
    await store.open(ns(0))
    await store.put('chain/a', enc('alpha'))
    expect(dec(await store.get('chain/a'))).toBe('alpha')
    expect(await store.get('chain/missing')).toBeUndefined()
    await store.del('chain/a')
    expect(await store.get('chain/a')).toBeUndefined()
    await store.close()
  })

  it('lists entries under a prefix, key-ordered, excluding others', async () => {
    const store = new IndexedDBStorageAdapter(freshName())
    await store.open(ns(0))
    await store.put('chain/2', enc('b'))
    await store.put('chain/1', enc('a'))
    await store.put('other/x', enc('z'))
    expect(await drain(store, 'chain/')).toEqual([
      { key: 'chain/1', value: 'a' },
      { key: 'chain/2', value: 'b' },
    ])
    await store.close()
  })

  it('resetChainState wipes chain-derived keys but preserves identity/*', async () => {
    const store = new IndexedDBStorageAdapter(freshName())
    await store.open(ns(0))
    await store.put('identity/wallet', enc('keep'))
    await store.put('chain/scan-state', enc('drop'))
    await store.resetChainState()
    expect(dec(await store.get('identity/wallet'))).toBe('keep')
    expect(await store.get('chain/scan-state')).toBeUndefined()
    await store.close()
  })

  it('open under a changed deployment resets chain state (identity preserved)', async () => {
    const name = freshName()
    const store = new IndexedDBStorageAdapter(name)
    await store.open(ns(100))
    await store.put('identity/wallet', enc('keep'))
    await store.put('chain/scan-state', enc('drop'))
    await store.close()

    // Reopen the SAME db under a different deployBlock → namespace mismatch → chain reset.
    const reopened = new IndexedDBStorageAdapter(name)
    await reopened.open(ns(200))
    expect(dec(await reopened.get('identity/wallet'))).toBe('keep')
    expect(await reopened.get('chain/scan-state')).toBeUndefined()
    await reopened.close()
  })

  it('persists across close + reopen (same db, same namespace)', async () => {
    const name = freshName()
    const a = new IndexedDBStorageAdapter(name)
    await a.open(ns(0))
    await a.put('chain/x', enc('persisted'))
    await a.close()

    const b = new IndexedDBStorageAdapter(name)
    await b.open(ns(0))
    expect(dec(await b.get('chain/x'))).toBe('persisted')
    await b.close()
  })
})
