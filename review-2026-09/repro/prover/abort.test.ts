// ABOUTME: Repro (review): the same-thread snarkjs prover (the documented default) ignores an AbortSignal
// ABOUTME: fired mid-proof and returns a proof, contradicting "cancelling through the signal throws AbortedError".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSnarkjsProver } from '../../../src/prover/snarkjs-prover';
import type { ArtifactSet, ProofProgress } from '../../../src/prover/index';

const fixture = (name: string): string => fileURLToPath(new URL(`../../../test/fixtures/prover/${name}`, import.meta.url));
const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};

describe('same-thread prover abort', () => {
  it('BUG: abort during witness phase is ignored; prove resolves; progress fraction is per-phase (0,1,0,1)', async () => {
    const prover = createSnarkjsProver();
    const ac = new AbortController();
    const seen: ProofProgress[] = [];
    const proof = await prover.prove({ a: '3', b: '11' }, artifacts, {
      signal: ac.signal,
      onProgress: (p) => { seen.push(p); if (p.phase === 'witness' && p.fraction === 0) ac.abort(); },
    });
    expect(ac.signal.aborted).toBe(true);
    expect(proof.a).toHaveLength(2); // resolved despite abort
    expect(seen.map((p) => p.fraction)).toEqual([0, 1, 0, 1]); // non-monotonic when treated as a whole-proof fraction
    await prover.close();
  });
});
