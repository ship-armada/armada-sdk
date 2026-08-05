// ABOUTME: adaptParams binding tests (§4.6, #399) — byte-exact vs foundry `cast` goldens computed from
// ABOUTME: the deployed CCTPBindingLib / YieldAdaptParams keccak formulas, plus verify round-trips.

import { describe, it, expect } from 'vitest';
import {
  CCTP_UNSHIELD_DOMAIN_TAG,
  encodeCctpBinding,
  verifyCctpBinding,
  encodeYieldDepositBinding,
  verifyYieldDepositBinding,
  encodeYieldRedeemBinding,
  verifyYieldRedeemBinding,
} from './adapt-params';

// 32-byte value: a leading byte + 31 zero (00) or one (11) bytes.
const z = (b: string): string => `0x${b}${'00'.repeat(31)}`;
const o = (b: string): string => `0x${b}${'11'.repeat(31)}`;

const CCTP_RECIPIENT = '0x00000000000000000000000000000000deadbeef';
const NPK = BigInt(`0x${'11'.repeat(32)}`);
const BUNDLE: [string, string, string] = [z('a1'), z('a2'), z('a3')];
const SHIELD_KEY = o('b1');
const FEE_NPK = BigInt(`0x${'22'.repeat(32)}`);
const FEE_BUNDLE: [string, string, string] = [z('c1'), z('c2'), z('c3')];
const FEE_SHIELD_KEY = o('d1');

// Golden values from `cast keccak(cast abi-encode(...))` — foundry, independent of ethers.
const GOLDEN = {
  domainTag: '0x21356b6965af9c07c4d5fb7bc8b7ba6ca11fe531bc1418dd5534bd2269a03825',
  cctp: '0x1c93e4d97f7f5b4a051e92bb54f46d098bf9082767988ca852b7174c3540aac4',
  yieldDeposit: '0x066c700bf785fa0836cdaea56efd55e3c2c3d69e44e0f985ed2bba499bd7d0ae',
  yieldRedeem: '0x85b8929d7b190498b62c82677663f245cc34d1300c4ad8c24335da8efa79c946',
};

describe('adaptParams bindings (§4.6, #399)', () => {
  it('CCTP domain tag matches keccak256("ArmadaCCTPUnshield.v1")', () => {
    expect(CCTP_UNSHIELD_DOMAIN_TAG).toBe(GOLDEN.domainTag);
  });

  it('encodeCctpBinding matches the contract golden + verifies', () => {
    const bound = encodeCctpBinding(CCTP_RECIPIENT, 6, 1_000_000n);
    expect(bound).toBe(GOLDEN.cctp);
    expect(verifyCctpBinding(bound, CCTP_RECIPIENT, 6, 1_000_000n)).toBe(true);
    // A front-runner swapping the recipient / domain / fee no longer matches the bound commitment.
    expect(verifyCctpBinding(bound, '0x00000000000000000000000000000000000000ff', 6, 1_000_000n)).toBe(false);
    expect(verifyCctpBinding(bound, CCTP_RECIPIENT, 7, 1_000_000n)).toBe(false);
    expect(verifyCctpBinding(bound, CCTP_RECIPIENT, 6, 999_999n)).toBe(false);
  });

  it('encodeYieldDepositBinding matches the contract golden + verifies', () => {
    const bound = encodeYieldDepositBinding(NPK, BUNDLE, SHIELD_KEY);
    expect(bound).toBe(GOLDEN.yieldDeposit);
    expect(verifyYieldDepositBinding(bound, NPK, BUNDLE, SHIELD_KEY)).toBe(true);
    expect(verifyYieldDepositBinding(bound, FEE_NPK, BUNDLE, SHIELD_KEY)).toBe(false);
  });

  it('encodeYieldRedeemBinding matches the contract golden + verifies', () => {
    const bound = encodeYieldRedeemBinding(NPK, BUNDLE, SHIELD_KEY, FEE_NPK, FEE_BUNDLE, FEE_SHIELD_KEY, 500n);
    expect(bound).toBe(GOLDEN.yieldRedeem);
    expect(verifyYieldRedeemBinding(bound, NPK, BUNDLE, SHIELD_KEY, FEE_NPK, FEE_BUNDLE, FEE_SHIELD_KEY, 500n)).toBe(true);
    // Redeem-path relayer cannot inflate its own fee beyond what the user committed.
    expect(verifyYieldRedeemBinding(bound, NPK, BUNDLE, SHIELD_KEY, FEE_NPK, FEE_BUNDLE, FEE_SHIELD_KEY, 600n)).toBe(false);
  });

  it('deposit and redeem paths produce distinct commitments for the same shield destination', () => {
    const deposit = encodeYieldDepositBinding(NPK, BUNDLE, SHIELD_KEY);
    const redeem = encodeYieldRedeemBinding(NPK, BUNDLE, SHIELD_KEY, FEE_NPK, FEE_BUNDLE, FEE_SHIELD_KEY, 500n);
    expect(deposit).not.toBe(redeem);
  });
});
