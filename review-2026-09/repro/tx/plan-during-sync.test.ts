// ABOUTME: Repro — WalletScanState.apply inserts leaves across awaits, so a planTransfer that runs while a sync
// ABOUTME: is suspended mid-transaction reads a tree root that never exists on-chain (not in rootHistory).
import { describe, it, expect } from 'vitest';
import { WalletScanState } from '../../../src/sync/index';
import { initPoseidonPromise } from '../../../src/core/index';

const leaf = (n: number) => n.toString(16).padStart(64, '0');
const commit = (position: number, n: number) => ({
  tree: 0, position, blockNumber: 10, txid: `0x${'aa'.repeat(32)}`, hash: leaf(n),
  ciphertext: {} as never,
});

describe('plan during in-flight sync', () => {
  it('exposes a mid-transaction root while apply() is awaiting a decrypt', async () => {
    await initPoseidonPromise;
    const state = new WalletScanState();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const decryptors = {
      transact: async () => { calls += 1; if (calls === 1) await gate; return undefined; },
    };
    // One on-chain transact() emitting two commitments → one root appended to rootHistory (after both).
    const applying = state.apply({ shields: [], transacts: [commit(0, 1), commit(1, 2)], nullifiers: [], unshields: [] }, decryptors as never);
    await new Promise((r) => setTimeout(r, 0));
    const midRoot = state.treeRoot(0); // what wallet.rootsFor() would hand planTransfer right now
    release();
    await applying;
    const finalRoot = state.treeRoot(0);
    const pre = new WalletScanState();
    expect(midRoot).not.toBe(finalRoot);
    // midRoot is the 1-leaf root — never a pool root, since the pool inserts both leaves in one insertLeaves().
    expect(pre.treeNumbers()).toEqual([]);
  });
});
