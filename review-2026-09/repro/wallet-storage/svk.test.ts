// ABOUTME: Probe of shareable-viewing-key decode edge cases (non-canonical encodings, trailing bytes).
// ABOUTME: Informational — documents what the decoder accepts/rejects.
import { describe, it, expect } from 'vitest';
import msgpack from 'msgpack-lite';
import { decodeShareableViewingKey, encodeShareableViewingKey, deriveKeyset } from '../../../src/wallet/index';

describe('svk decode probes', () => {
  it('probes', async () => {
    const ks = await deriveKeyset(new Uint8Array(32).fill(3));
    const good = encodeShareableViewingKey({ viewingPrivateKey: ks.viewingPrivateKey, spendingPublicKey: ks.spendingPublicKey });
    const results: Record<string, string> = {};
    const tryDecode = (label: string, s: string) => {
      try { const m = decodeShareableViewingKey(s); results[label] = `ACCEPT ${m.spendingPublicKey[0] === ks.spendingPublicKey[0]}`; } catch (e) { results[label] = `REJECT ${(e as Error).constructor.name}`; }
    };
    tryDecode('good', good);
    tryDecode('trailing-nonhex', good + 'zz');
    tryDecode('trailing-bytes', good + '00');
    tryDecode('uppercase', good.toUpperCase());
    // y = field prime p (non-canonical y) with sign bit 0
    const p = 21888242871839275222246405745257275088548364400416417793613441520734599737617n;
    const le = (n: bigint) => { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
    const vpriv = Buffer.from(ks.viewingPrivateKey).toString('hex');
    tryDecode('y=p', msgpack.encode({ vpriv, spub: le(p).toString('hex') }).toString('hex'));
    // y + p (non-canonical representative of a valid y)
    tryDecode('y+p', msgpack.encode({ vpriv, spub: le(ks.spendingPublicKey[1] + p).toString('hex') }).toString('hex'));
    // extra fields
    tryDecode('extra-field', msgpack.encode({ vpriv, spub: msgpack.decode(Buffer.from(good, 'hex')).spub, x: 1 }).toString('hex'));
    console.log(results);
    expect(results.good).toMatch(/ACCEPT/);
  });
});
