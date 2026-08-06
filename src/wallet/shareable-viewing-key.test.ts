// ABOUTME: Round-trip test for the shareable viewing-key codec (§4.2.2) — encode → decode recovers the
// ABOUTME: viewing private key + spending public key (the Railgun-compatible wire format).

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise } from '../core/index';
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
