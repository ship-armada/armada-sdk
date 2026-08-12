// ABOUTME: Round-trip test for the shareable viewing-key codec (§4.2.2) — encode → decode recovers the
// ABOUTME: viewing private key + spending public key (the Railgun-compatible wire format).

import { describe, it, expect, beforeAll } from 'vitest';
import msgpack from 'msgpack-lite';
import { initPoseidonPromise, Babyjubjub } from '../core/index';
import { deriveKeyset } from './derive';
import { encodeShareableViewingKey, decodeShareableViewingKey } from './shareable-viewing-key';

describe('shareable viewing key codec (§4.2.2)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('round-trips the viewing private key + spending public key', async () => {
    const keyset = await deriveKeyset(new Uint8Array(32).fill(0x11));
    const svk = encodeShareableViewingKey({
      viewingPrivateKey: keyset.viewingPrivateKey,
      spendingPublicKey: keyset.spendingPublicKey,
    });
    expect(svk).toMatch(/^[0-9a-f]+$/); // hex

    const decoded = decodeShareableViewingKey(svk);
    expect(Array.from(decoded.viewingPrivateKey)).toEqual(Array.from(keyset.viewingPrivateKey));
    expect(decoded.spendingPublicKey).toEqual(keyset.spendingPublicKey);
  });
});

describe('shareable viewing key — rejects crafted/malformed material (SPEC §4.2, H8)', () => {
  // Inject malformed fields the honest encoder would never emit, using the same wire codec.
  const encodeRaw = (vpriv: string, spubHex: string): string =>
    (msgpack.encode({ vpriv, spub: spubHex }) as Buffer).toString('hex');
  const goodSpubHex = async (fill: number): Promise<string> => {
    const keyset = await deriveKeyset(new Uint8Array(32).fill(fill));
    return Buffer.from(Babyjubjub.packPoint(keyset.spendingPublicKey)).toString('hex');
  };

  it('rejects a non-hex viewing key instead of silently zeroing it (parseInt NaN→0)', async () => {
    const svk = encodeRaw('zz'.repeat(32), await goodSpubHex(0x11));
    expect(() => decodeShareableViewingKey(svk)).toThrow(/non-hex|expected 32 bytes/i);
  });

  it('rejects an all-zero viewing key (degenerate identity scalar)', async () => {
    const svk = encodeRaw('00'.repeat(32), await goodSpubHex(0x22));
    expect(() => decodeShareableViewingKey(svk)).toThrow(/zero scalar/i);
  });

  it('rejects an off-curve / malformed spending public key (unpackPoint → null)', () => {
    const svk = encodeRaw('11'.repeat(32), 'ff'.repeat(32)); // 0xff*32 unpacks to null
    expect(() => decodeShareableViewingKey(svk)).toThrow(/off-curve|malformed encoding/i);
  });

  it('rejects a malformed payload (missing fields)', () => {
    const svk = (msgpack.encode({ nope: 1 }) as Buffer).toString('hex');
    expect(() => decodeShareableViewingKey(svk)).toThrow(/malformed payload/i);
  });
});
