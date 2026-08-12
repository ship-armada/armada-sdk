// ABOUTME: Wallet key-derivation + custody tests. deriveKeyset reproduces the Phase 0 keyset vectors
// ABOUTME: byte-for-byte (closes the deferred keyset vector); LocalSigner signs intents that verify.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initPoseidonPromise, verifyEDDSA } from '../core/index';
import { deriveKeyset } from './derive';
import { LocalSigner } from './local-signer';
import { InvalidRequestError } from '../errors';
import type { SpendSignRequest } from './index';

interface KeysetVector {
  name: string;
  rootSecret: string;
  keyset: {
    masterPublicKey: string;
    nullifyingKey: string;
    spendingPublicKey: [string, string];
    spendingPrivateKey: string;
    viewingPublicKey: string;
    viewingPrivateKey: string;
    shieldedAddress: string;
  };
}
const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../test/vectors/keyset-vectors.json');
const loadVectors = (): KeysetVector[] => JSON.parse(readFileSync(VECTORS_PATH, 'utf8')).vectors;

const bigToHex = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const bytesToHex = (b: Uint8Array): string =>
  '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex: string): Uint8Array => {
  const s = hex.replace(/^0x/, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// Minimal valid SpendSignRequest (LocalSigner only consumes `.message`).
const req = (message: bigint): SpendSignRequest => ({
  message,
  context: {
    nullifiers: [],
    commitmentsOut: [],
    merkleRoot: 0n,
    commitmentCiphertext: [],
    boundParams: {
      treeNumber: 0,
      minGasPrice: 0n,
      unshield: 0,
      chainID: 0n,
      adaptContract: '0x0000000000000000000000000000000000000000',
      adaptParams: `0x${'00'.repeat(32)}`,
    },
    summary: {
      tokenAddress: '0x0000000000000000000000000000000000000000',
      inputTotal: 0n,
      outputs: [],
      changeValue: 0n,
    },
  },
});

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('deriveKeyset — parity vs keyset-vectors.json (closes the Phase 1 deferral)', () => {
  for (const v of loadVectors()) {
    it(`${v.name}: rootSecret → keyset reproduces the stock-engine keyset byte-for-byte`, async () => {
      const ks = await deriveKeyset(hexToBytes(v.rootSecret));
      expect(bigToHex(ks.masterPublicKey)).toBe(v.keyset.masterPublicKey);
      expect(bigToHex(ks.nullifyingKey)).toBe(v.keyset.nullifyingKey);
      expect(ks.spendingPublicKey.map(bigToHex)).toEqual(v.keyset.spendingPublicKey);
      expect(bytesToHex(ks.spendingPrivateKey)).toBe(v.keyset.spendingPrivateKey);
      expect(bytesToHex(ks.viewingPublicKey)).toBe(v.keyset.viewingPublicKey);
      expect(bytesToHex(ks.viewingPrivateKey)).toBe(v.keyset.viewingPrivateKey);
      expect(ks.shieldedAddress).toBe(v.keyset.shieldedAddress);
    });
  }

  it('rejects a non-32-byte rootSecret', async () => {
    await expect(deriveKeyset(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('LocalSigner (SpendSigner)', () => {
  const v = loadVectors()[0]!;

  it('getSpendingPublicKey matches the derived keyset', async () => {
    const signer = await LocalSigner.fromRootSecret(hexToBytes(v.rootSecret));
    expect((await signer.getSpendingPublicKey()).map(bigToHex)).toEqual(v.keyset.spendingPublicKey);
  });

  it('signBatch produces signatures that verifyEDDSA accepts', async () => {
    const signer = await LocalSigner.fromRootSecret(hexToBytes(v.rootSecret));
    const pubkey = await signer.getSpendingPublicKey();
    const messages = [123456789n, 987654321n];
    const sigs = await signer.signBatch(messages.map(req));
    expect(sigs).toHaveLength(messages.length);
    sigs.forEach((sig, i) => {
      expect(verifyEDDSA(messages[i]!, { R8: [sig.R8[0], sig.R8[1]], S: sig.S }, pubkey)).toBe(true);
    });
  });

  it('dispose() zeroizes the spending key and refuses to sign afterward (P3.2 zeroization)', async () => {
    const signer = await LocalSigner.fromRootSecret(hexToBytes(v.rootSecret));
    signer.dispose();
    await expect(signer.signBatch([req(1n)])).rejects.toThrow(InvalidRequestError);
  });
});
