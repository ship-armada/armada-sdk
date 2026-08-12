// ABOUTME: Tests for the wrapper calldata builders (§4.6) — each embeds a proved Transaction that the
// ABOUTME: wrapper-aware decodeTransact round-trips back, and the selectors match the deployed contracts.

import { describe, it, expect } from 'vitest';
import { ZeroAddress } from 'ethers';
import {
  buildAtomicCrossChainUnshieldCalldata,
  buildLendAndShieldCalldata,
  buildRedeemAndShieldCalldata,
} from './wrappers';
import { decodeTransact } from './decode';
import type { TransactionData } from './serialize';
import type { CommitmentCiphertextV2 } from '../sync/index';

const b32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const POOL = `0x${'11'.repeat(20)}` as const;
const ADAPTER = `0x${'22'.repeat(20)}` as const;
const CT: CommitmentCiphertextV2 = {
  ciphertext: [b32(1n), b32(2n), b32(3n), b32(4n)],
  blindedSenderViewingKey: new Uint8Array(32).fill(5),
  blindedReceiverViewingKey: new Uint8Array(32).fill(6),
  memo: '0x',
  annotationData: '0x',
};
const tx = (): TransactionData => ({
  proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] },
  merkleRoot: 111n,
  nullifiers: [9n, 10n],
  commitments: [11n, 12n],
  boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: 0, chainID: 31337n, adaptContract: ZeroAddress as `0x${string}`, adaptParams: b32(0n) as `0x${string}`, commitmentCiphertext: [CT] },
});
const shieldCt = { encryptedBundle: [b32(7n), b32(8n), b32(9n)] as [string, string, string], shieldKey: b32(10n) };

// decodeTransact recovers the embedded transaction's public fields regardless of the wrapper.
const expectRecovered = (data: string): void => {
  const selector = data.slice(0, 10);
  const [decoded] = decodeTransact(data);
  expect(decoded!.nullifiers).toEqual([9n, 10n]);
  expect(decoded!.commitments).toEqual([11n, 12n]);
  expect(decoded!.merkleRoot).toBe(111n);
  expect(decoded!.boundParams.chainID).toBe(31337n);
  expect(decoded!.commitmentCiphertexts).toHaveLength(1);
  return void selector;
};

describe('wrapper calldata builders (§4.6)', () => {
  it('atomicCrossChainUnshield — selector 0x2bcba06a, embedded Transaction round-trips', () => {
    const { to, data } = buildAtomicCrossChainUnshieldCalldata(tx(), {
      poolAddress: POOL, destinationDomain: 3, finalRecipient: `0x${'ab'.repeat(20)}`, maxFee: 500n, uniqueNonce: 7n,
    });
    expect(to).toBe(POOL);
    expect(data.slice(0, 10)).toBe('0x2bcba06a');
    expectRecovered(data);
  });

  it('lendAndShield — selector 0xf2987ad1, targets the adapter, round-trips', () => {
    const { to, data } = buildLendAndShieldCalldata(tx(), { adapterAddress: ADAPTER, npk: 42n, shieldCiphertext: shieldCt });
    expect(to).toBe(ADAPTER);
    expect(data.slice(0, 10)).toBe('0xf2987ad1');
    expectRecovered(data);
  });

  it('redeemAndShield — selector 0x7e220759, two-note fee params, round-trips', () => {
    const { to, data } = buildRedeemAndShieldCalldata(tx(), {
      adapterAddress: ADAPTER, npk: 42n, shieldCiphertext: shieldCt, feeNpk: 43n, feeShieldCiphertext: shieldCt, feeAmount: 1000n,
    });
    expect(to).toBe(ADAPTER);
    expect(data.slice(0, 10)).toBe('0x7e220759');
    expectRecovered(data);
  });

  it('decodeTransact throws on an unrecognized selector', () => {
    expect(() => decodeTransact('0xdeadbeef')).toThrow(/unrecognized selector/);
  });
});
