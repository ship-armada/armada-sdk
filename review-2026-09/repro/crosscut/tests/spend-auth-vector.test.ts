// ABOUTME: Scratch repro — the captured EdDSA spend-auth vector's publicInputs → message binding is
// ABOUTME: never asserted by the suite; this shows the assertion holds and could be added.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { poseidon, initPoseidonPromise } from '../../../../src/core/index';

const v = JSON.parse(readFileSync(resolve(__dirname, '../../../../test/vectors/eddsa-spend-auth-vectors.json'), 'utf8')).vectors[0];
const B = (h: string) => BigInt(h.startsWith('0x') ? h : '0x' + h);

describe('spend-auth vector message construction', () => {
  beforeAll(async () => { await initPoseidonPromise; });
  it('message == poseidon([merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut])', () => {
    const p = v.publicInputs;
    const msg = poseidon([B(p.merkleRoot), B(p.boundParamsHash), ...p.nullifiers.map(B), ...p.commitmentsOut.map(B)]);
    expect(msg).toBe(B(v.message));
  });
});
