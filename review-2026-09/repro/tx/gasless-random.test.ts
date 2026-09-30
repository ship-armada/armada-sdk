// ABOUTME: Repro — buildGaslessShield / buildGaslessCrossChainShield discard the fee note's `random`, which the
// ABOUTME: relayer's gasless fee verifier (and the SDK's own verifyShieldFeeNote) needs as `feeShieldRandom`.
import { describe, it, expect } from 'vitest';
import { initPoseidonPromise } from '../../../src/core/index';
import { deriveKeyset } from '../../../src/wallet/derive';
import { buildGaslessShield, generateShieldPrivateKey, verifyShieldFeeNote } from '../../../src/tx/index';

describe('gasless shield fee random', () => {
  it('is not returned, so the fee note cannot be verified by npk reconstruction', async () => {
    await initPoseidonPromise;
    const user = await deriveKeyset(new Uint8Array(32).fill(0x01));
    const relayer = await deriveKeyset(new Uint8Array(32).fill(0x02));
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const out = await buildGaslessShield({
      wrapperAddress: `0x${'12'.repeat(20)}`, chainId: 1, user: `0x${'34'.repeat(20)}`, integrator: `0x${'00'.repeat(20)}`,
      deadline: 1n, nonce: 0n,
      userShield: { shieldedAddress: user.shieldedAddress, amount: 1_000_000n, tokenAddress: USDC },
      feeShield: { shieldedAddress: relayer.shieldedAddress, amount: 50_000n, tokenAddress: USDC },
    }, generateShieldPrivateKey());
    expect(Object.keys(out).sort()).toEqual(['requestsHash', 'shieldRequests', 'typedData']);
    // Without the random the caller has nothing to pass: a guessed random fails.
    expect(verifyShieldFeeNote({ shieldRequests: out.shieldRequests, broadcasterMasterPublicKey: relayer.masterPublicKey, random: '00'.repeat(16), minValue: 1n })).toBeUndefined();
  });
});
