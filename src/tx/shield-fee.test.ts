// ABOUTME: Tests for shield fee gross-up + npk-reconstruction fee verification (§4.6.1/#410) — the
// ABOUTME: gross-up nets >= target and is minimal; the fee-note verifier matches by reconstructed npk.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, ShieldNote } from '../core/index';
import { shieldFee, shieldNet, grossUpShieldFee, reconstructShieldNpk, verifyShieldFeeNote } from './shield-fee';
import type { ShieldRequest } from './shield';
import { InvalidRequestError } from '../errors';

describe('shield fee gross-up (§4.6.1)', () => {
  it('matches the on-chain formula: floor(G*aBps/1e4) + floor(G*iBps/1e4)', () => {
    expect(shieldFee(1_000_000n, { armadaTakeBps: 50 })).toBe(5000n); // 50 bps of 1e6
    expect(shieldFee(1_000_000n, { armadaTakeBps: 40, integratorBps: 30 })).toBe(4000n + 3000n);
    expect(shieldNet(1_000_000n, { armadaTakeBps: 50 })).toBe(995_000n);
  });

  it('grosses up so the net >= target AND is the minimal such gross', () => {
    const tiers = [
      { armadaTakeBps: 50 },
      { armadaTakeBps: 40 },
      { armadaTakeBps: 40, integratorBps: 30 },
      { armadaTakeBps: 12 },
    ];
    const nets = [1n, 7n, 5000n, 123_456n, 1_000_000n, 999_999n];
    for (const t of tiers) {
      for (const net of nets) {
        const gross = grossUpShieldFee(net, t);
        expect(shieldNet(gross, t)).toBeGreaterThanOrEqual(net); // relayer nets its target after the fee
        expect(shieldNet(gross - 1n, t)).toBeLessThan(net); // and it's the SMALLEST gross that does so
      }
    }
  });

  it('no-fee tiers pass through, and >= 100% fee is rejected', () => {
    expect(grossUpShieldFee(1000n, { armadaTakeBps: 0 })).toBe(1000n);
    expect(() => grossUpShieldFee(1000n, { armadaTakeBps: 9000, integratorBps: 1000 })).toThrow(InvalidRequestError);
    expect(() => grossUpShieldFee(0n, { armadaTakeBps: 50 })).toThrow(InvalidRequestError);
  });
});

describe('npk-reconstruction shield-fee verification (§4.6, #410)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  const req = (npk: bigint, value: bigint): ShieldRequest => ({
    preimage: { npk: '0x' + npk.toString(16).padStart(64, '0'), token: { tokenType: 0, tokenAddress: '0x', tokenSubID: '0' } as ShieldRequest['preimage']['token'], value },
    ciphertext: { encryptedBundle: ['0x', '0x', '0x'], shieldKey: '0x' },
  });

  it('reconstructs npk = Poseidon(masterPublicKey, random) matching the engine', () => {
    const mpk = 123456789n;
    const random = 'a1'.repeat(16);
    expect(reconstructShieldNpk(mpk, random)).toBe(ShieldNote.getNotePublicKey(mpk, random));
  });

  it('finds the relayer note by reconstructed npk and enforces the minimum value', () => {
    const mpk = 987654321n;
    const random = 'bc'.repeat(16);
    const feeNpk = reconstructShieldNpk(mpk, random);

    // Fee note (gross 5000) addressed to the relayer + an unrelated user note.
    const requests = [req(0xdeadn, 1_000_000n), req(feeNpk, 5000n)];
    expect(verifyShieldFeeNote({ shieldRequests: requests, broadcasterMasterPublicKey: mpk, random, minValue: 5000n })).toEqual({ value: 5000n });

    // Underpaid → undefined (the relayer would return FEE_INSUFFICIENT).
    expect(verifyShieldFeeNote({ shieldRequests: requests, broadcasterMasterPublicKey: mpk, random, minValue: 5001n })).toBeUndefined();

    // No note addressed to the relayer → undefined.
    expect(verifyShieldFeeNote({ shieldRequests: [req(0xdeadn, 1n)], broadcasterMasterPublicKey: mpk, random, minValue: 1n })).toBeUndefined();
  });
});
