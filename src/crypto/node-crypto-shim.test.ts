// ABOUTME: Tests for the browser build's stand-in Node `crypto` — sha512 matches Node's own, random bytes have the asked
// ABOUTME: length and vary, and an unsupported hash throws rather than returning something wrong.

import { createHash as nodeCreateHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import shim, { createHash, randomBytes } from './node-crypto-shim';

describe('node-crypto-shim', () => {
  it('createHash("sha512") matches Node crypto, across several update() calls', () => {
    const parts = [new TextEncoder().encode('abc'), new Uint8Array(200).fill(9)];
    const ours = createHash('sha512').update(parts[0]!).update(parts[1]!).digest();
    const node = nodeCreateHash('sha512').update(parts[0]!).update(parts[1]!).digest();
    expect(Buffer.isBuffer(ours)).toBe(true);
    expect(ours.toString('hex')).toBe(node.toString('hex'));
  });

  it('createHash rejects any other algorithm with an InternalError', () => {
    expect(() => createHash('sha256')).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringMatching(/unsupported hash "sha256"/) }));
  });

  it('randomBytes returns a Buffer of the asked length, different each call', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });

  it('the default export carries the same functions (a CJS `require("crypto").default` caller)', () => {
    expect(shim.randomBytes).toBe(randomBytes);
    expect(shim.createHash).toBe(createHash);
  });
});
