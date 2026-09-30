// ABOUTME: Repro — measures UTXOMerkletree full-rebuild cost for root()/merkleProof() at realistic tree sizes.
// ABOUTME: Also checks what happens when >65536 leaves are inserted into one tree (root ignores the overflow).
import { describe, it, expect, beforeAll } from 'vitest';
import { UTXOMerkletree } from '../../../src/sync/merkletree';
import { initPoseidonPromise } from '../../../src/core/index';

const leaf = (i: number): string => (BigInt(i) + 1n).toString(16).padStart(64, '0');

describe('merkletree cost', () => {
  beforeAll(async () => { await initPoseidonPromise; });
  it('times root() and merkleProof() on 16384 / 65536 leaves', () => {
    for (const n of [16384, 65536]) {
      const t = new UTXOMerkletree();
      for (let i = 0; i < n; i++) t.insert(leaf(i));
      let s = performance.now();
      t.root();
      const rootMs = performance.now() - s;
      s = performance.now();
      t.merkleProof(0);
      const proofMs = performance.now() - s;
      console.log(`n=${n} root()=${rootMs.toFixed(0)}ms merkleProof()=${proofMs.toFixed(0)}ms`);
    }
    expect(true).toBe(true);
  }, 600_000);
  it('leaves beyond 65536 do not change the root', () => {
    const a = new UTXOMerkletree();
    for (let i = 0; i < 65536; i++) a.insert(leaf(i));
    const r = a.root();
    a.insert(leaf(999999));
    expect(a.length).toBe(65537);
    expect(a.root()).toBe(r); // overflow leaf silently ignored by root()
  }, 600_000);
});
