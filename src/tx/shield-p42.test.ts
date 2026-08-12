// ABOUTME: P4.2 gasless-shield surface tests (§4.6/§4.6.1) — EIP-712 type strings match the contract
// ABOUTME: typehashes byte-for-byte, the fee-note gross-up wiring, the EIP-2612 permit, and the cross-chain builder.

import { describe, it, expect, beforeAll } from 'vitest';
import { TypedDataEncoder } from 'ethers';
import { initPoseidonPromise } from '../core/index';
import { deriveKeyset } from '../wallet/derive';
import {
  buildShieldIntentTypedData, buildGaslessShield, buildPermitTypedData, hashPermit,
} from './gasless-shield';
import { buildGaslessCrossChainShield, hashShieldData, hashCrossChainShieldIntent } from './gasless-cross-chain-shield';
import { shieldNet } from './shield-fee';
import { generateShieldPrivateKey } from './shield';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const addr = (p: string): `0x${string}` => `0x${p.repeat(20)}`;
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe('gasless-shield EIP-712 type strings match the deployed typehashes (P4.2)', () => {
  it('ShieldIntent / Permit / CrossChainShieldIntent encode exactly as the contracts hash them', () => {
    const shield = buildShieldIntentTypedData({ wrapperAddress: addr('11'), chainId: 1, intent: { user: addr('22'), requestsHash: `0x${'00'.repeat(32)}`, integrator: addr('33'), deadline: 0n, nonce: 0n } });
    expect(TypedDataEncoder.from(shield.types as never).encodeType('ShieldIntent')).toBe(
      'ShieldIntent(address user,bytes32 requestsHash,address integrator,uint256 deadline,uint256 nonce)',
    );

    const permit = buildPermitTypedData({ token: { address: addr('44'), name: 'USD Coin', version: '2' }, chainId: 1, owner: addr('22'), spender: addr('11'), value: 1n, nonce: 0n, deadline: 0n });
    expect(TypedDataEncoder.from(permit.types as never).encodeType('Permit')).toBe(
      'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)',
    );
    expect(typeof hashPermit(permit)).toBe('string');
  });
});

describe('fee-note gross-up wiring + cross-chain builder (P4.2)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('buildGaslessShield grosses up the fee note so it nets the target after the shield fee', async () => {
    const relayer = await deriveKeyset(seed(0x33));
    const user = await deriveKeyset(seed(0x22));
    const key = generateShieldPrivateKey();
    const tiers = { armadaTakeBps: 50 };
    const { shieldRequests } = await buildGaslessShield({
      wrapperAddress: addr('11'), chainId: 31337, user: addr('22'), integrator: addr('00'), deadline: 0n, nonce: 0n,
      userShield: { shieldedAddress: user.shieldedAddress, amount: 1_000_000n, tokenAddress: USDC },
      feeShield: { shieldedAddress: relayer.shieldedAddress, amount: 5000n, tokenAddress: USDC, grossUp: tiers },
    }, key);

    // The fee note (2nd request) is the grossed-up value; after the on-chain shield fee it nets >= 5000.
    const feeGross = shieldRequests[1]!.preimage.value;
    expect(feeGross).toBeGreaterThan(5000n);
    expect(shieldNet(feeGross, tiers)).toBeGreaterThanOrEqual(5000n);
  });

  it('buildGaslessCrossChainShield builds two ShieldData notes + a CrossChainShieldIntent binding their hashes', async () => {
    const relayer = await deriveKeyset(seed(0x33));
    const user = await deriveKeyset(seed(0x22));
    const key = generateShieldPrivateKey();
    const { userNote, feeNote, typedData } = await buildGaslessCrossChainShield({
      clientWrapperAddress: addr('55'), chainId: 31337, user: addr('22'), maxFee: 100n, minFinalityThreshold: 1000, deadline: 0n, nonce: 0n,
      userShield: { shieldedAddress: user.shieldedAddress, amount: 1_000_000n, tokenAddress: USDC, integrator: addr('00') },
      feeShield: { shieldedAddress: relayer.shieldedAddress, amount: 5000n, tokenAddress: USDC, integrator: addr('00'), grossUp: { armadaTakeBps: 50 } },
    }, key);

    // The intent binds each note's keccak(abi.encode(note)) hash, and the type encodes as the contract hashes it.
    expect(typedData.message.userNoteHash).toBe(hashShieldData(userNote));
    expect(typedData.message.feeNoteHash).toBe(hashShieldData(feeNote));
    expect(typedData.domain.name).toBe('ArmadaGaslessCrossChainShield');
    expect(TypedDataEncoder.from(typedData.types as never).encodeType('CrossChainShieldIntent')).toBe(
      'CrossChainShieldIntent(address user,bytes32 userNoteHash,bytes32 feeNoteHash,uint256 maxFee,uint32 minFinalityThreshold,uint256 deadline,uint256 nonce)',
    );
    expect(typeof hashCrossChainShieldIntent(typedData)).toBe('string');

    // The fee note carries the grossed-up value and a distinct npk/integrator from the user note.
    expect(feeNote.value).toBeGreaterThan(5000n);
    expect(feeNote.npk).not.toBe(userNote.npk);
    expect(feeNote.encryptedBundle).toHaveLength(3);
  });
});
