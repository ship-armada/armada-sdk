// ABOUTME: Repro (review): createSnarkjsProver().close() terminates the process-global bn128 curve, so closing
// ABOUTME: one prover/SDK instance kills another instance's in-flight proof (module-level state bug class).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSnarkjsProver } from '../../../src/prover/snarkjs-prover';
import type { ArtifactSet } from '../../../src/prover/index';

const fixture = (name: string): string => fileURLToPath(new URL(`../../../test/fixtures/prover/${name}`, import.meta.url));
const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};

describe('shared bn128 curve across prover instances', () => {
  it('BUG: closing prover B while prover A is mid-proof hangs A', async () => {
    const a = createSnarkjsProver();
    const b = createSnarkjsProver();
    await a.prove({ a: '3', b: '11' }, artifacts); // warm: curve cached on globalThis
    const g = globalThis as unknown as { curve_bn128: unknown };
    expect(g.curve_bn128).not.toBeNull();
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      let closeFired = false;
      const p = a.prove({ a: '3', b: '11' }, artifacts, {
        onProgress: (pr) => {
          if (pr.phase === 'proving' && pr.fraction === 0 && !closeFired) {
            closeFired = true;
            // other instance's sdk.close() lands a moment later, while A is inside groth16.prove
            setTimeout(() => { void b.close(); }, i);
          }
        },
      });
      const r = await Promise.race([
        p.then(() => 'ok', (e: unknown) => `err:${(e as Error).message}`),
        new Promise<string>((res) => setTimeout(() => res('HUNG'), 3000)),
      ]);
      outcomes.push(`delay${i}:${r}`);
      if (r === 'HUNG') break;
      await a.prove({ a: '3', b: '11' }, artifacts); // re-warm the global curve
    }
    console.log(outcomes.join(' '));
    expect(outcomes.some((o) => o.includes('HUNG') || o.includes('err'))).toBe(true);
    await a.close();
  }, 60_000);
});
